package build

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// Defaults for BuildRequest fields left at zero.
const (
	DefaultKeepImages = 3
	DefaultTimeout    = 45 * time.Minute
	// DefaultRegistry is where every build pushes: the agent's relay to the
	// panel registry (registry.LocalAddress).
	DefaultRegistry = "127.0.0.1:5755"
	// finishedTTL keeps finished jobs so a panel that reconnects can still
	// read the result and the log.
	finishedTTL = 15 * time.Minute
	// cachePruneEvery and cacheMaxAge bound the BuildKit cache.
	cachePruneEvery = time.Hour
	cacheMaxAge     = 7 * 24 * time.Hour
	// builderIdle removes a project's builder (and its cache) after this
	// long without a build: deleted projects leave none behind.
	builderIdle = 14 * 24 * time.Hour
)

// ErrNotFound means no build with that id is queued or running.
var ErrNotFound = errors.New("no such build")

// Options configures a Service.
type Options struct {
	// Dir holds workspaces, uploads and the docker CLI config
	// (datadir.Layout.BuildsDir).
	Dir string
	// ToolsDir holds the pinned Railpack and Nixpacks binaries.
	ToolsDir string
	Runner   Runner
	Logger   *slog.Logger
	// Emit sends best-effort progress (rpc.Emitter.Emit). May be nil.
	Emit func(*agentv1.Event)
	// Report queues the final result durably (state.Reporter.Event).
	// May be nil in tests.
	Report func(context.Context, *agentv1.Event) error
	// Registry is the push target prefix; default DefaultRegistry.
	Registry string
	// Parallel is the initial number of builds at once (default 1).
	Parallel int
	// Sizing caps the buildx builder; default MachineSize().
	Sizing *Sizing
	// Tools installs builder binaries; default one under ToolsDir.
	Tools *Tools
	// Git is what the node's config.yml says about git fetches
	// (git_proxy_resolves).
	Git GitNodeConfig
	// WorkerDNS judges a project's build worker before a build uses it: one
	// without a DNS server it can use, while new containers get one, is
	// restarted first. Nil skips that (nodecheck.NewWorkerDNS in the
	// agent).
	WorkerDNS WorkerDNS
	// NodeName is the node's name in the panel, which a fetch that failed
	// on the node's network names (GitNetworkError). Nil or "": "this
	// node".
	NodeName func() string
}

// nodeName is Options.NodeName's answer, "" without one.
func (s *Service) nodeName() string {
	if s.opts.NodeName == nil {
		return ""
	}
	return s.opts.NodeName()
}

// Service is the node's Builder: a queue of detached build jobs.
type Service struct {
	opts    Options
	log     *slog.Logger
	cli     dockerCLI
	buildx  *buildxEnv
	queue   *Queue
	uploads uploads
	tools   *Tools

	life   context.Context
	stop   context.CancelFunc
	mu     sync.Mutex
	jobs   map[string]*Job
	closed bool
}

var _ Builder = (*Service)(nil)

// New returns a Service. Call Run to start its maintenance and Close (or
// cancel Run's ctx) to stop every build.
func New(opts Options) *Service {
	if opts.Runner == nil {
		opts.Runner = ExecRunner{}
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Registry == "" {
		opts.Registry = DefaultRegistry
	}
	size := MachineSize()
	if opts.Sizing != nil {
		size = *opts.Sizing
	}
	tools := opts.Tools
	if tools == nil {
		tools = &Tools{Dir: opts.ToolsDir}
	}
	cli := dockerCLI{run: opts.Runner, configDir: filepath.Join(opts.Dir, "docker")}
	// The service owns the lifetime of its builds: they outlive the RPC
	// that started them and end with Close.
	life, stop := context.WithCancel(context.Background())
	return &Service{
		opts:    opts,
		log:     opts.Logger,
		cli:     cli,
		buildx:  &buildxEnv{cli: cli, size: size, dns: opts.WorkerDNS},
		queue:   NewQueue(opts.Parallel),
		uploads: uploads{dir: filepath.Join(opts.Dir, "uploads")},
		tools:   tools,
		life:    life,
		stop:    stop,
		jobs:    map[string]*Job{},
	}
}

// SetParallel follows NodeSettings.max_parallel_builds (0 means 1).
func (s *Service) SetParallel(n int) { s.queue.SetLimit(n) }

// RestartStaleWorkers is for the Container DNS check: it restarts the
// workers of these builders that have no DNS server they can use while a
// new container gets one (Options.WorkerDNS judges each again), when no
// build uses them. Only the agent's own builders (BuilderPrefix, in the
// builds' DOCKER_CONFIG) are touched, and the build cache stays. It
// returns the builders it restarted.
func (s *Service) RestartStaleWorkers(ctx context.Context, builders []string) []string {
	restarted, errs := s.buildx.restartStale(ctx, builders)
	for _, name := range restarted {
		s.log.Info("restarted a build worker without a DNS server it could use", "builder", name)
	}
	for name, err := range errs {
		s.log.Warn("restarting a build worker without a DNS server it could use", "builder", name, "err", err)
	}
	return restarted
}

// Queue exposes running and waiting counts.
func (s *Service) Queue() *Queue { return s.queue }

// Close cancels every build and refuses new ones.
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.stop()
}

// Run cleans what a previous agent left behind, then expires uploads and
// prunes the build cache now and then. It returns when ctx ends, after
// cancelling every build.
func (s *Service) Run(ctx context.Context) error {
	defer s.Close()
	// Workspaces of builds that were running when the agent stopped.
	_ = os.RemoveAll(s.workRoot())
	s.uploads.expire(time.Now())
	t := time.NewTicker(cachePruneEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			s.uploads.expire(time.Now())
			s.forgetFinished()
			s.pruneCache(ctx)
		}
	}
}

func (s *Service) workRoot() string { return filepath.Join(s.opts.Dir, "work") }

// pruneCache drops BuildKit cache nobody used for a week and removes the
// builders of projects that built nothing for builderIdle, while no build
// runs (pruning under a running build only slows it down).
func (s *Service) pruneCache(ctx context.Context) {
	if running, waiting := s.queue.Stats(); running+waiting > 0 {
		return
	}
	for _, name := range s.buildx.reapIdle(ctx, builderIdle) {
		s.log.Info("removed an idle build worker and its cache", "builder", name)
	}
	s.buildx.mu.Lock()
	var ready []string
	for name := range s.buildx.ready {
		ready = append(ready, name)
	}
	s.buildx.mu.Unlock()
	until := fmt.Sprintf("until=%dh", int(cacheMaxAge.Hours()))
	for _, name := range ready {
		if _, err := s.cli.out(ctx, "buildx", "prune", "--builder", name, "--force", "--filter", until); err != nil {
			s.log.Warn("pruning the build cache", "builder", name, "err", err)
		}
	}
}

func (s *Service) forgetFinished() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, j := range s.jobs {
		if f := j.Final(); f != nil && time.Since(j.finishedAt) > finishedTTL {
			delete(s.jobs, id)
		}
	}
}

// Start implements Builder.
func (s *Service) Start(req *agentv1.BuildRequest) (*Job, error) {
	if err := validateRequest(req, s.opts.Registry); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("the builder is shutting down")
	}
	if j, ok := s.jobs[req.GetBuildId()]; ok {
		if j.ServiceID != req.GetServiceId() {
			return nil, invalid("build id %s is already used by another service", req.GetBuildId())
		}
		return j, nil
	}
	ctx, cancel := context.WithCancel(s.life)
	j := newJob(req.GetBuildId(), req.GetServiceId(), cancel)
	s.jobs[j.ID] = j
	go s.run(ctx, j, req)
	return j, nil
}

// Cancel implements Builder.
func (s *Service) Cancel(buildID string) error {
	s.mu.Lock()
	j, ok := s.jobs[buildID]
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	j.cancel()
	return nil
}

// Job returns a known build.
func (s *Service) Job(buildID string) (*Job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j, ok := s.jobs[buildID]
	return j, ok
}

// StoreContext implements Builder.
func (s *Service) StoreContext(ctx context.Context, req *agentv1.UploadBuildContextRequest, archive io.Reader) error {
	return s.uploads.store(ctx, req, archive)
}

// run is one build from queue to result. It always ends with finish.
func (s *Service) run(ctx context.Context, j *Job, req *agentv1.BuildRequest) {
	defer j.cancel()
	started := time.Now()
	log := s.log.With("build_id", j.ID, "service_id", j.ServiceID)
	step := func(stage agentv1.BuildStage, msg string) {
		p := &agentv1.BuildProgress{BuildId: j.ID, RunId: j.RunID, Stage: stage, Message: msg}
		j.progress(p)
		if s.opts.Emit != nil {
			s.opts.Emit(&agentv1.Event{Payload: &agentv1.Event_BuildProgress{BuildProgress: p}})
		}
	}

	digest, err := s.execute(ctx, j, req, step)

	final := &agentv1.BuildProgress{BuildId: j.ID, RunId: j.RunID, Duration: durationpb.New(time.Since(started).Round(time.Millisecond))}
	switch {
	case err == nil:
		final.Stage = agentv1.BuildStage_BUILD_STAGE_SUCCEEDED
		final.ImageDigest = digest
		final.Message = "Pushed " + req.GetImageReference() + "@" + digest
		// The panel's GIT_SHA for the containers, also when it missed BuildSourceInfo.
		final.Commit = j.builtCommit()
	case errors.Is(err, context.Canceled):
		final.Stage = agentv1.BuildStage_BUILD_STAGE_CANCELLED
		final.Message = "The build was cancelled"
	default:
		final.Stage = agentv1.BuildStage_BUILD_STAGE_FAILED
		final.Message = failureMessage(err)
	}
	fmt.Fprintf(j, "\n--> %s\n", final.Message)
	for _, hint := range failureHints(err, j.recent(), j.secretArgs) {
		fmt.Fprintf(j, "--> %s\n", hint)
	}
	log.Info("build finished", "stage", final.Stage.String(), "duration", final.Duration.AsDuration(), "err", err)

	j.finishedAt = time.Now()
	j.finish(final)
	if s.opts.Report != nil {
		// Durable: reaches the panel even if the stream was lost. Use the
		// service lifetime, not the build's (cancelled) context.
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err := s.opts.Report(rctx, &agentv1.Event{Payload: &agentv1.Event_BuildProgress{BuildProgress: final}}); err != nil {
			log.Error("queueing the build result", "err", err)
		}
	}
}

// failureMessage is the reason shown for a failed build.
func failureMessage(err error) string {
	var inv *InvalidError
	var exit *ExitError
	switch {
	case errors.As(err, &inv):
		return inv.Msg
	case errors.Is(err, context.DeadlineExceeded):
		return "The build took too long and was stopped"
	case errors.Is(err, ErrFetch), errors.Is(err, ErrToolUnavailable), errors.Is(err, ErrUploadNotFound):
		return err.Error()
	case errors.As(err, &exit):
		return "The build failed - the lines above say why"
	default:
		return "The build failed: " + err.Error()
	}
}

// DNSHint follows a failed build whose output shows a name lookup failing
// in the build worker. The worker's DNS servers are the ones Docker gives
// every container, and a broken "dns" setting of Docker's (for example
// empty entries in daemon.json) shows only as BuildKit's lookup error, so
// the line points at the node check that says what Docker gives
// containers and how to fix it (nodecheck's Container DNS).
const DNSHint = "A name lookup (DNS) failed in the build worker - if the name is right, the Container DNS check on the node's Health tab (or `" +
	brand.Slug + " health` on the node) says why and how to fix it"

// dnsLookupRe matches failed name lookups in build output: BuildKit's Go
// resolver ("dial tcp: lookup registry-1.docker.io on [::1]:53: ...
// connection refused", "no such host") and the C resolvers of RUN steps
// (apt, curl and git, pip, npm), which use the same servers.
var dnsLookupRe = regexp.MustCompile(`lookup \S+ on \S+:53\b|dial tcp: lookup |no such host|` +
	`Temporary failure in name resolution|Temporary failure resolving|Could not resolve host|getaddrinfo EAI_AGAIN`)

// failureHints are lines for the log after the failure message, none when
// none fits. A builder that failed (the lines above say why) on a name
// lookup gets DNSHint; one whose output mentions an ARG of the Dockerfile
// that is a secret variable (secretArgs) gets that ARG's note again, last.
func failureHints(err error, output string, secretArgs []string) []string {
	var exit *ExitError
	if !errors.As(err, &exit) {
		return nil
	}
	var out []string
	if dnsLookupRe.MatchString(output) {
		out = append(out, DNSHint)
	}
	for _, name := range mentionedSecretArgs(output, secretArgs) {
		out = append(out, secretArgNote(name))
	}
	return out
}

// execute fetches, builds and pushes, returning the pushed digest.
func (s *Service) execute(ctx context.Context, j *Job, req *agentv1.BuildRequest, step func(agentv1.BuildStage, string)) (string, error) {
	release, err := s.queue.Acquire(ctx, func(ahead int) {
		msg := "Starting"
		if ahead > 0 {
			msg = fmt.Sprintf("Waiting for %d build(s) on this node", ahead)
			fmt.Fprintf(j, "--> %s\n", msg)
		}
		step(agentv1.BuildStage_BUILD_STAGE_QUEUED, msg)
	})
	if err != nil {
		return "", err
	}
	defer release()

	timeout := DefaultTimeout
	if d := req.GetTimeout().AsDuration(); req.GetTimeout() != nil && d > 0 {
		timeout = d
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	work := filepath.Join(s.workRoot(), j.ID)
	_ = os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o700); err != nil {
		return "", err
	}
	defer os.RemoveAll(work)

	ref := req.GetImageReference()
	if img := req.GetSource().GetImage(); img != nil {
		step(agentv1.BuildStage_BUILD_STAGE_FETCHING_SOURCE, "Pulling "+img.GetReference())
		if err := s.mirror(ctx, j, img, ref, work); err != nil {
			return "", err
		}
	} else {
		step(agentv1.BuildStage_BUILD_STAGE_FETCHING_SOURCE, "Fetching the source")
		src := filepath.Join(work, "src")
		commit, err := s.fetch(ctx, j, req, src, work)
		if err != nil {
			return "", err
		}
		step(agentv1.BuildStage_BUILD_STAGE_BUILDING, "Building with "+builderName(req))
		if err := s.build(ctx, j, req, src, work, commit); err != nil {
			return "", err
		}
	}

	step(agentv1.BuildStage_BUILD_STAGE_PUSHING, "Pushing "+ref)
	fmt.Fprintf(j, "--> Pushing %s\n", ref)
	digest, err := s.cli.push(ctx, j, ref)
	if err != nil {
		return "", fmt.Errorf("pushing the image to the panel registry: %w", err)
	}
	s.retain(ctx, j, req)
	return digest, nil
}

func builderName(req *agentv1.BuildRequest) string {
	if req.GetSource().GetInlineDockerfile() != "" || req.GetDockerfileContent() != "" {
		return "your Dockerfile"
	}
	switch req.GetBuilder() {
	case agentv1.Builder_BUILDER_NIXPACKS:
		return "Nixpacks " + Nixpacks.Version
	case agentv1.Builder_BUILDER_DOCKERFILE:
		return "the Dockerfile"
	default:
		return "Railpack " + Railpack.Version
	}
}

// fetch puts the source in src. For a git source it returns the full
// commit it checked out (the one BuildSourceInfo reports), "" otherwise.
func (s *Service) fetch(ctx context.Context, j *Job, req *agentv1.BuildRequest, src, work string) (commit string, err error) {
	switch source := req.GetSource().GetSource().(type) {
	case *agentv1.BuildSource_Git:
		info, err := fetchGitOn(ctx, s.opts.Git, s.opts.Runner, j, source.Git, src, work, req.GetGitSubmodules())
		if err != nil {
			NameNode(err, s.nodeName())
			return "", err
		}
		j.sourceInfo(info)
		commit = info.GetCommit()
	case *agentv1.BuildSource_UploadId:
		archive := s.uploads.path(source.UploadId)
		if _, err := os.Stat(archive); err != nil {
			return "", fmt.Errorf("%w: %s", ErrUploadNotFound, source.UploadId)
		}
		fmt.Fprintln(j, "--> Unpacking the uploaded source")
		if err := os.MkdirAll(src, 0o755); err != nil {
			return "", err
		}
		if err := extractArchive(ctx, archive, src); err != nil {
			return "", err
		}
		// Single use: the archive is not needed after a successful unpack.
		_ = os.Remove(archive)
	case *agentv1.BuildSource_InlineDockerfile:
		if err := os.MkdirAll(src, 0o755); err != nil {
			return "", err
		}
		fmt.Fprintln(j, "--> Building the Dockerfile written in the panel")
		return "", os.WriteFile(filepath.Join(src, "Dockerfile"), []byte(source.InlineDockerfile), 0o644)
	}
	return commit, checkTree(ctx, src)
}

// GitSHAVar is the variable a build from git gets with the full commit the
// agent checked out, as Easypanel passes it: a build arg (ARG GIT_SHA) for
// Dockerfiles and a build variable for Railpack and Nixpacks. The panel
// gives the deployment's containers the same value (CONTRACTS.md).
const GitSHAVar = "GIT_SHA"

// withGitSHA returns the build's variables plus GIT_SHA=<commit> for a
// source fetched from git (commit is "" for uploads and inline
// Dockerfiles), unless the panel already sends GIT_SHA: the service's own
// .env or the project's shared variables set it, and their value wins,
// also an empty one.
func withGitSHA(env []*agentv1.EnvVar, commit string) []*agentv1.EnvVar {
	if commit == "" || slices.ContainsFunc(env, func(e *agentv1.EnvVar) bool { return e.GetName() == GitSHAVar }) {
		return env
	}
	return append(slices.Clip(env), &agentv1.EnvVar{Name: GitSHAVar, Value: commit})
}

// ownGitSHANote is the log line for a build from git whose variables set
// GIT_SHA themselves, so the agent passes no commit; "" otherwise. A
// secret one gets a word more where it is lost: a Dockerfile build sees it
// only as a BuildKit secret (ARG GIT_SHA stays empty) and a Nixpacks build
// not at all, which would otherwise look like a build without GIT_SHA.
func ownGitSHANote(req *agentv1.BuildRequest, commit string) string {
	env := req.GetEnv()
	i := slices.IndexFunc(env, func(e *agentv1.EnvVar) bool { return e.GetName() == GitSHAVar })
	if commit == "" || i < 0 {
		return ""
	}
	note := GitSHAVar + " is set in the service's variables (or the project's shared ones), so the commit checked out is not passed"
	if !env[i].GetSecret() {
		return note
	}
	public := ` (a "# @public" comment above it makes it public)`
	switch {
	case req.GetSource().GetInlineDockerfile() != "" || req.GetDockerfileContent() != "" || req.GetBuilder() == agentv1.Builder_BUILDER_DOCKERFILE:
		return note + "; it is a secret there, so it is no build arg (ARG " + GitSHAVar + " stays empty)" + public
	case req.GetBuilder() == agentv1.Builder_BUILDER_NIXPACKS:
		return note + "; it is a secret there, so the Nixpacks build does not see it" + public
	}
	return note
}

// build runs the chosen builder and leaves the image tagged as the
// request's image reference in the local Docker. commit is the one fetch
// checked out ("" when the source is not git).
func (s *Service) build(ctx context.Context, j *Job, req *agentv1.BuildRequest, src, work, commit string) error {
	contextDir, err := insideRoot(src, req.GetContextPath(), "The build path")
	if err != nil {
		return err
	}
	name, release, err := s.buildx.builder(ctx, j, buildScope(req))
	if err != nil {
		return err
	}
	defer release()
	spec := buildSpec{Builder: name, ContextDir: contextDir, Tag: req.GetImageReference(), Target: req.GetTargetStage(), Labels: imageLabels(req)}
	buildVars := withGitSHA(req.GetEnv(), commit)
	if len(buildVars) > len(req.GetEnv()) {
		fmt.Fprintf(j, "--> %s=%s\n", GitSHAVar, commit)
	} else if note := ownGitSHANote(req, commit); note != "" {
		fmt.Fprintf(j, "--> %s\n", note)
	}

	inline := req.GetSource().GetInlineDockerfile() != "" || req.GetDockerfileContent() != ""
	switch {
	case inline || req.GetBuilder() == agentv1.Builder_BUILDER_DOCKERFILE:
		if err := s.dockerfileSpec(j, req, buildVars, &spec, src, contextDir, work); err != nil {
			return err
		}
	case req.GetBuilder() == agentv1.Builder_BUILDER_NIXPACKS:
		if err := s.nixpacksSpec(ctx, j, req, buildVars, &spec, contextDir); err != nil {
			return err
		}
	default:
		if err := s.railpackSpec(ctx, j, req, buildVars, &spec, contextDir, work); err != nil {
			return err
		}
	}

	args, env := spec.args()
	fmt.Fprintf(j, "--> Building %s\n", req.GetImageReference())
	err = s.cli.stream(ctx, j, env, args...)
	if err != nil && ctx.Err() == nil && name != "" {
		// A removed or broken builder container: check again next time.
		s.buildx.forget(name)
	}
	return err
}

// dockerfileSpec builds the Dockerfile with buildVars (the request's
// variables, withGitSHA) as build args and secrets, and notes each ARG that
// names a secret variable (dockerargs.go).
func (s *Service) dockerfileSpec(j *Job, req *agentv1.BuildRequest, buildVars []*agentv1.EnvVar, spec *buildSpec, src, contextDir, work string) error {
	switch {
	case req.GetSource().GetInlineDockerfile() != "":
		spec.Dockerfile = filepath.Join(src, "Dockerfile")
	case req.GetDockerfileContent() != "":
		// Outside the source, so it never shadows or joins the context.
		f := filepath.Join(work, "Dockerfile.panel")
		if err := os.WriteFile(f, []byte(req.GetDockerfileContent()), 0o644); err != nil {
			return err
		}
		spec.Dockerfile = f
	default:
		p := req.GetDockerfilePath()
		if p == "" {
			p = "Dockerfile"
		}
		f, err := insideRoot(contextDir, p, "The Dockerfile")
		if err != nil {
			return err
		}
		spec.Dockerfile = f
	}
	secrets, args, err := splitEnv(buildVars, filepath.Join(work, "secrets"))
	if err != nil {
		return err
	}
	spec.Secrets, spec.BuildArgs = secrets, args
	// An ARG named like a secret variable stays empty: say so before the build output.
	j.secretArgs = secretArgs(spec.Dockerfile, req.GetEnv())
	for _, name := range j.secretArgs {
		fmt.Fprintf(j, "--> %s\n", secretArgNote(name))
	}
	return nil
}

// railpackSpec plans the build with Railpack, which sees buildVars (the
// request's variables, withGitSHA) and gets every one as a BuildKit secret.
func (s *Service) railpackSpec(ctx context.Context, j *Job, req *agentv1.BuildRequest, buildVars []*agentv1.EnvVar, spec *buildSpec, contextDir, work string) error {
	bin, err := s.tools.Path(ctx, Railpack, j)
	if err != nil {
		return err
	}
	plan := filepath.Join(work, "railpack-plan.json")
	args := []string{"prepare", contextDir, "--plan-out", plan, "--info-out", filepath.Join(work, "railpack-info.json")}
	var env []string
	for _, e := range buildVars {
		arg, v := passVar(e.GetName(), e.GetValue())
		args = append(args, "--env", arg)
		if v != "" {
			env = append(env, v)
		}
	}
	if c := req.GetInstallCommand(); c != "" {
		args = append(args, "--env", "RAILPACK_INSTALL_CMD="+c)
	}
	if c := req.GetBuildCommand(); c != "" {
		args = append(args, "--build-cmd", c)
	}
	if c := req.GetStartCommand(); c != "" {
		args = append(args, "--start-cmd", c)
	}
	fmt.Fprintln(j, "--> Planning the build with Railpack")
	if err := s.opts.Runner.Run(ctx, Cmd{Name: bin, Args: args, Env: env, Stdout: j, Stderr: j}); err != nil {
		return err
	}
	// Railpack hands every variable to the build as a BuildKit secret.
	secrets, err := writeSecrets(buildVars, filepath.Join(work, "secrets"))
	if err != nil {
		return err
	}
	spec.Dockerfile = plan
	spec.Secrets = secrets
	spec.BuildArgs = []KV{
		{"BUILDKIT_SYNTAX", RailpackFrontend},
		// Changes when a value changes, so cached layers that used the old
		// value are rebuilt. Only the panel's variables: the GIT_SHA the
		// agent adds changes with every commit and would rebuild every step
		// that sees secrets (the install step too) on every push, while the
		// steps that copy the source run again for a new commit anyway.
		{"secrets-hash", envHash(req.GetEnv())},
	}
	return nil
}

// buildScope picks the builder a build runs in: its project's, or for
// panels that send no project, its service's.
func buildScope(req *agentv1.BuildRequest) string {
	if p := req.GetProjectId(); p != "" {
		return p
	}
	return req.GetServiceId()
}

// nixpacksSpec generates the Dockerfile with Nixpacks from buildVars (the
// request's variables, withGitSHA), leaving the secret ones out.
func (s *Service) nixpacksSpec(ctx context.Context, j *Job, req *agentv1.BuildRequest, buildVars []*agentv1.EnvVar, spec *buildSpec, contextDir string) error {
	bin, err := s.tools.Path(ctx, Nixpacks, j)
	if err != nil {
		return err
	}
	common := []string{contextDir}
	var env []string
	// Nixpacks has no build secrets: every variable it knows becomes an
	// ARG/ENV of the image, readable in its config and history. Secret
	// variables are left out of the build; the container still gets them
	// at runtime from the service's env.
	vars := nixpacksVars(buildVars)
	if n := len(buildVars) - len(vars); n > 0 {
		fmt.Fprintf(j, "--> %d secret variable(s) are not available during a Nixpacks build (they would be stored in the image); "+
			"they are set when the service runs. Use Railpack or a Dockerfile with RUN --mount=type=secret if the build needs them\n", n)
	}
	for _, e := range vars {
		arg, v := passVar(e.GetName(), e.GetValue())
		common = append(common, "--env", arg)
		if v != "" {
			env = append(env, v)
		}
	}
	if c := req.GetInstallCommand(); c != "" {
		common = append(common, "--install-cmd", c)
	}
	if c := req.GetBuildCommand(); c != "" {
		common = append(common, "--build-cmd", c)
	}
	if c := req.GetStartCommand(); c != "" {
		common = append(common, "--start-cmd", c)
	}
	// The plan lists the variables (ours plus Nixpacks defaults such as
	// NODE_ENV) that the generated Dockerfile declares as build args.
	var planOut strings.Builder
	if err := s.opts.Runner.Run(ctx, Cmd{Name: bin, Args: append([]string{"plan"}, append(common, "--format", "json")...), Env: env, Stdout: &planOut, Stderr: j}); err != nil {
		return err
	}
	var plan struct {
		Variables map[string]string `json:"variables"`
	}
	if err := json.Unmarshal([]byte(planOut.String()), &plan); err != nil {
		return fmt.Errorf("reading the Nixpacks plan: %w", err)
	}
	fmt.Fprintln(j, "--> Generating the Dockerfile with Nixpacks")
	if err := s.opts.Runner.Run(ctx, Cmd{Name: bin, Args: append([]string{"build"}, append(common, "--out", contextDir)...), Env: env, Stdout: j, Stderr: j}); err != nil {
		return err
	}
	args := plan.Variables
	if args == nil {
		args = map[string]string{}
	}
	for _, e := range vars {
		args[e.GetName()] = e.GetValue()
	}
	for _, e := range buildVars {
		if e.GetSecret() {
			delete(args, e.GetName()) // never a build arg, even under a Nixpacks default's name
		}
	}
	names := make([]string, 0, len(args))
	for k := range args {
		names = append(names, k)
	}
	slices.Sort(names)
	for _, k := range names {
		if envNameRe.MatchString(k) {
			spec.BuildArgs = append(spec.BuildArgs, KV{k, args[k]})
		}
	}
	spec.Dockerfile = filepath.Join(contextDir, ".nixpacks", "Dockerfile")
	return nil
}

// nixpacksVars are the variables a Nixpacks build may see: all but the
// secret ones.
func nixpacksVars(env []*agentv1.EnvVar) []*agentv1.EnvVar {
	out := make([]*agentv1.EnvVar, 0, len(env))
	for _, e := range env {
		if !e.GetSecret() {
			out = append(out, e)
		}
	}
	return out
}

// splitEnv makes every variable a BuildKit secret file (RUN
// --mount=type=secret,id=NAME works for all of them, as with Railpack) and
// the variables that are not secret also build args (ARG NAME), which can
// end up in the image's history, so secret ones never are.
func splitEnv(env []*agentv1.EnvVar, dir string) ([]Secret, []KV, error) {
	var args []KV
	for _, e := range env {
		if !e.GetSecret() {
			args = append(args, KV{e.GetName(), e.GetValue()})
		}
	}
	files, err := writeSecrets(env, dir)
	return files, args, err
}

// writeSecrets writes one 0600 file per variable for --secret src=.
func writeSecrets(env []*agentv1.EnvVar, dir string) ([]Secret, error) {
	if len(env) == 0 {
		return nil, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	out := make([]Secret, 0, len(env))
	for _, e := range env {
		f := filepath.Join(dir, e.GetName())
		if err := os.WriteFile(f, []byte(e.GetValue()), 0o600); err != nil {
			return nil, err
		}
		out = append(out, Secret{ID: e.GetName(), File: f})
	}
	return out, nil
}

func envHash(env []*agentv1.EnvVar) string {
	pairs := make([]string, 0, len(env))
	for _, e := range env {
		pairs = append(pairs, e.GetName()+"="+e.GetValue())
	}
	slices.Sort(pairs)
	h := sha256.Sum256([]byte(strings.Join(pairs, "\x00")))
	return hex.EncodeToString(h[:])
}

// mirror pulls an existing image (logged in for this pull only) and tags
// it as ref for the push.
func (s *Service) mirror(ctx context.Context, j *Job, img *agentv1.ImageSource, ref, work string) error {
	pull := s.cli
	if auth := img.GetAuth(); auth.GetUsername() != "" {
		// A throwaway Docker config: the login never outlives the build.
		pull.configDir = filepath.Join(work, "docker-config")
		if err := os.MkdirAll(pull.configDir, 0o700); err != nil {
			return err
		}
		server := auth.GetServer()
		if server == "" {
			server = registryOf(img.GetReference())
		}
		fmt.Fprintf(j, "--> Logging in to %s as %s\n", server, auth.GetUsername())
		c := pull.cmd(nil, "login", server, "--username", auth.GetUsername(), "--password-stdin")
		c.Stdin = strings.NewReader(auth.GetPassword())
		c.Stdout, c.Stderr = j, j
		if err := s.opts.Runner.Run(ctx, c); err != nil {
			return fmt.Errorf("%w: could not log in to %s", ErrFetch, server)
		}
	}
	// Untag the source afterwards only if this build brought it: a tag the
	// node already had may be used by something else.
	_, inspectErr := s.cli.out(ctx, "image", "inspect", "--format", "{{.Id}}", img.GetReference())
	hadImage := inspectErr == nil
	fmt.Fprintf(j, "--> Pulling %s\n", img.GetReference())
	if err := pull.stream(ctx, j, nil, "pull", img.GetReference()); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("%w: could not pull %s - check the name and the registry login", ErrFetch, img.GetReference())
	}
	if _, err := s.cli.out(ctx, "tag", img.GetReference(), ref); err != nil {
		return fmt.Errorf("tagging %s: %w", img.GetReference(), err)
	}
	if !hadImage {
		// Only the name goes; the layers stay under ref.
		_, _ = s.cli.out(ctx, "image", "rm", "--no-prune", img.GetReference())
	}
	return nil
}

// registryOf: "ghcr.io/o/a:1" -> "ghcr.io"; "nginx", "o/a" -> Docker Hub.
func registryOf(image string) string {
	first, _, ok := strings.Cut(image, "/")
	if ok && (strings.ContainsAny(first, ".:") || first == "localhost") {
		return first
	}
	return "docker.io"
}

// retain removes this service's older local images. Failures only log.
func (s *Service) retain(ctx context.Context, j *Job, req *agentv1.BuildRequest) {
	keep := int(req.GetKeepImages())
	if keep == 0 {
		keep = DefaultKeepImages
	}
	removed, err := s.cli.pruneImages(ctx, repository(req.GetImageReference()), keep)
	if err != nil {
		s.log.Warn("pruning old images", "service_id", req.GetServiceId(), "err", err)
		return
	}
	for _, tag := range removed {
		fmt.Fprintf(j, "--> Removed the old local image %s\n", tag)
	}
}

// imageLabels mark a built image as Seylo's, for cleanup: managed, the
// service and, when the tag is "<repo>:<generation>", the generation.
func imageLabels(req *agentv1.BuildRequest) []KV {
	labels := []KV{{docker.LabelManaged, "true"}, {docker.LabelService, req.GetServiceId()}}
	ref := req.GetImageReference()
	if i := strings.LastIndexByte(ref, ':'); i > strings.LastIndexByte(ref, '/') {
		if _, err := strconv.ParseUint(ref[i+1:], 10, 64); err == nil {
			labels = append(labels, KV{docker.LabelGeneration, ref[i+1:]})
		}
	}
	return labels
}
