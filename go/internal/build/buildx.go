package build

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/docker"
)

// BuilderPrefix starts the name of every buildx builder the agent creates.
var BuilderPrefix = brand.Slug + "-builder"

// Sizing is the CPU and memory cap of a buildx builder, so builds never
// take the node from the services (or game servers) running on it. Each
// project gets its own builder of this size; the build queue
// (max_parallel_builds) bounds how many run at once. Ported from an
// earlier in-house implementation by the same authors: a quarter of the
// machine, at least 2 cores and 4 GB, at most 8 and 16.
type Sizing struct {
	Cores    int
	MemoryGB int
}

// SizeFor returns the builder size for a machine.
func SizeFor(cpus int, memBytes uint64) Sizing {
	cores := min(max(cpus/4, 2), 8, max(cpus, 1))
	totalGB := int(memBytes >> 30)
	mem := min(max(totalGB/4, 4), 16)
	// Small machines: never promise more than three quarters of them.
	if limit := totalGB * 3 / 4; totalGB > 0 && mem > limit {
		mem = max(limit, 1)
	}
	return Sizing{Cores: cores, MemoryGB: mem}
}

// suffix ends every builder name. It carries the size, so a node whose
// hardware changed gets new builders of the right size.
func (s Sizing) suffix() string { return fmt.Sprintf("-%dc-%dg", s.Cores, s.MemoryGB) }

// Name is the name of the one builder older agents shared between every
// project on the node. Kept only to find and remove it: its cache mixes
// projects.
func (s Sizing) Name() string { return BuilderPrefix + s.suffix() }

// BuilderName is the builder of one project (scope: the project id, or
// the service id for panels that send none). Builders never share
// BuildKit state, so cache mounts and the layer cache stay in the project.
func (s Sizing) BuilderName(scope string) string {
	return BuilderPrefix + "-" + scopeName(scope) + s.suffix()
}

var plainScopeRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_]{0,39}$`)

// scopeName keeps panel ids as they are and hashes anything else into a
// name buildx and Docker accept. Dashes are hashed too, so a scope can
// never look like a size suffix.
func scopeName(scope string) string {
	if plainScopeRe.MatchString(scope) {
		return scope
	}
	sum := sha256.Sum256([]byte(scope))
	return "x" + hex.EncodeToString(sum[:8])
}

// MachineSize reads the CPU count and total memory of this machine.
func MachineSize() Sizing {
	return SizeFor(runtime.NumCPU(), memTotal())
}

var memTotalRe = regexp.MustCompile(`(?m)^MemTotal:\s+(\d+) kB`)

func memTotal() uint64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 8 << 30
	}
	m := memTotalRe.FindSubmatch(b)
	if m == nil {
		return 8 << 30
	}
	kb, _ := strconv.ParseUint(string(m[1]), 10, 64)
	return kb << 10
}

// dockerCLI runs the docker command line (buildx, push, image ls). Builds
// use the CLI rather than the Engine API because buildx, BuildKit
// frontends and secrets live there.
type dockerCLI struct {
	run Runner
	// configDir is DOCKER_CONFIG for every call: buildx keeps its builder
	// list there, and the agent never touches root's ~/.docker.
	configDir string
}

func (d dockerCLI) cmd(env []string, args ...string) Cmd {
	return Cmd{
		Name: "docker",
		Args: args,
		Env:  append([]string{"DOCKER_CONFIG=" + d.configDir, "DOCKER_CLI_HINTS=false", "BUILDX_NO_DEFAULT_ATTESTATIONS=1"}, env...),
	}
}

func (d dockerCLI) out(ctx context.Context, args ...string) (string, error) {
	return output(ctx, d.run, d.cmd(nil, args...))
}

// stream runs a docker command with its output in log.
func (d dockerCLI) stream(ctx context.Context, log io.Writer, env []string, args ...string) error {
	c := d.cmd(env, args...)
	c.Stdout, c.Stderr = log, log
	return d.run.Run(ctx, c)
}

// buildxEnv finds and creates the builders, one per project, and
// remembers which exist and when each was last used.
type buildxEnv struct {
	cli  dockerCLI
	size Sizing

	mu      sync.Mutex
	checked bool
	ok      bool // buildx is installed
	cleaned bool // builders of another size and the old shared one are gone
	ready   map[string]bool
	used    map[string]time.Time
}

// ErrNoBuildx is the build failure on a node without docker buildx. Every
// build needs it: the build worker that caps CPU and memory is a buildx
// builder, and the flags builds pass (--load, --secret, --provenance) do
// not exist in the legacy `docker build`.
var ErrNoBuildx = &InvalidError{Msg: "docker buildx is not installed on this node, and builds need it. Install the docker-buildx-plugin package (Docker from get.docker.com has it) and build again."}

// builder returns the builder name to build with for scope, creating it
// on first use. Without buildx it fails with ErrNoBuildx.
func (b *buildxEnv) builder(ctx context.Context, log io.Writer, scope string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.check(ctx); err != nil {
		return "", err
	}
	if !b.ok {
		// Checked again on the next build, so installing the plugin is
		// enough.
		b.checked = false
		return "", ErrNoBuildx
	}
	name := b.size.BuilderName(scope)
	b.used[name] = time.Now()
	if b.ready[name] {
		return name, nil
	}
	if _, err := b.cli.out(ctx, "buildx", "inspect", name); err == nil {
		b.ready[name] = true
		return name, nil
	}
	fmt.Fprintf(log, "Creating the build worker for this project (%d cores, %d GB)\n", b.size.Cores, b.size.MemoryGB)
	args := []string{"buildx", "create", "--name", name, "--driver", "docker-container"}
	for _, o := range b.driverOpts() {
		args = append(args, "--driver-opt", o)
	}
	args = append(args, "--bootstrap")
	if err := b.cli.stream(ctx, log, nil, args...); err != nil {
		return "", fmt.Errorf("creating the build worker: %w", err)
	}
	b.ready[name] = true
	return name, nil
}

// check finds out once whether buildx is installed and, when it is,
// removes the builders older agents left (b.mu is held).
func (b *buildxEnv) check(ctx context.Context) error {
	if !b.checked {
		_, err := b.cli.out(ctx, "buildx", "version")
		if ctx.Err() != nil {
			return ctx.Err()
		}
		b.checked, b.ok = true, err == nil
		b.ready, b.used = map[string]bool{}, map[string]time.Time{}
	}
	if b.ok && !b.cleaned {
		b.removeOld(ctx)
		b.cleaned = true
	}
	return nil
}

func (b *buildxEnv) driverOpts() []string {
	return []string{
		fmt.Sprintf("memory=%dg", b.size.MemoryGB),
		fmt.Sprintf("cpu-quota=%d", b.size.Cores*100_000),
		"cpu-period=100000",
		"cgroup-parent=" + docker.CgroupParent,
	}
}

// ours lists the builders this agent created (any size).
func (b *buildxEnv) ours(ctx context.Context) ([]string, error) {
	all, err := b.builders(ctx)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, name := range all {
		if strings.HasPrefix(name, BuilderPrefix+"-") {
			names = append(names, name)
		}
	}
	return names, nil
}

// builders lists every buildx builder by name. `buildx ls` also lists
// each builder's nodes ("<name>0"), so it reads the JSON form (one object
// per builder); buildx before 0.13 has none, and there node rows are told
// apart by being a listed builder's name plus digits.
func (b *buildxEnv) builders(ctx context.Context) ([]string, error) {
	if out, err := b.cli.out(ctx, "buildx", "ls", "--format", "json"); err == nil {
		var names []string
		ok := true
		for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			var row struct{ Name string }
			if json.Unmarshal([]byte(line), &row) != nil || row.Name == "" {
				ok = false
				break
			}
			names = append(names, row.Name)
		}
		if ok {
			return names, nil
		}
	}
	out, err := b.cli.out(ctx, "buildx", "ls", "--format", "{{.Name}}")
	if err != nil {
		return nil, err
	}
	var rows []string
	for _, name := range strings.Fields(out) {
		if name = strings.TrimSuffix(name, "*"); !slices.Contains(rows, name) {
			rows = append(rows, name)
		}
	}
	var names []string
	for _, name := range rows {
		parent := strings.TrimRight(name, "0123456789")
		if parent != name && slices.Contains(rows, parent) {
			continue // a node of builder parent
		}
		names = append(names, name)
	}
	return names, nil
}

// current lists our builders of the current size, the old shared one
// excluded.
func (b *buildxEnv) current(ctx context.Context) ([]string, error) {
	all, err := b.ours(ctx)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, name := range all {
		if strings.HasSuffix(name, b.size.suffix()) && name != b.size.Name() {
			names = append(names, name)
		}
	}
	return names, nil
}

// removeOld deletes our builders of another size and the builder older
// agents shared between projects (its cache mixes them). b.mu is held.
func (b *buildxEnv) removeOld(ctx context.Context) {
	all, err := b.ours(ctx)
	if err != nil {
		return
	}
	for _, name := range all {
		if !strings.HasSuffix(name, b.size.suffix()) || name == b.size.Name() {
			_, _ = b.cli.out(ctx, "buildx", "rm", name)
		}
	}
}

// reapIdle removes builders (with their cache) no build used for idle,
// for projects that stopped building or were deleted. A builder first seen
// in this process starts its idle clock now. Call it only while no build
// runs or waits.
func (b *buildxEnv) reapIdle(ctx context.Context, idle time.Duration) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.check(ctx); err != nil || !b.ok {
		return nil
	}
	names, err := b.current(ctx)
	if err != nil {
		return nil
	}
	now := time.Now()
	var removed []string
	for _, name := range names {
		last, seen := b.used[name]
		if !seen {
			b.used[name] = now
			continue
		}
		if now.Sub(last) < idle {
			continue
		}
		if _, err := b.cli.out(ctx, "buildx", "rm", name); err == nil {
			delete(b.ready, name)
			delete(b.used, name)
			removed = append(removed, name)
		}
	}
	return removed
}

// forget makes the next build check the builder again (after it failed
// in a way that suggests the builder is gone).
func (b *buildxEnv) forget(name string) {
	b.mu.Lock()
	delete(b.ready, name)
	b.mu.Unlock()
}

// buildSpec is one `docker buildx build`.
type buildSpec struct {
	Builder    string // "" for plain docker build
	ContextDir string
	Dockerfile string
	Target     string
	Tag        string
	// BuildArgs are --build-arg values; Secrets become --secret files.
	BuildArgs []KV
	Secrets   []Secret
	// Labels go on the built image (cleanup only prunes labelled images).
	Labels []KV
}

// KV is one name and value.
type KV struct{ Name, Value string }

// Secret is a BuildKit secret read from a file.
type Secret struct{ ID, File string }

// args returns the docker arguments. Build arg values the CLI must read
// from its environment (never shown in the process list) are in env.
func (s buildSpec) args() (args, env []string) {
	args = []string{"buildx", "build"}
	if s.Builder != "" {
		args = append(args, "--builder", s.Builder)
	}
	args = append(args, "--progress", "plain", "--load", "--provenance=false", "--sbom=false", "-t", s.Tag, "-f", s.Dockerfile)
	if s.Target != "" {
		args = append(args, "--target", s.Target)
	}
	for _, a := range s.BuildArgs {
		arg, e := passVar(a.Name, a.Value)
		args = append(args, "--build-arg", arg)
		if e != "" {
			env = append(env, e)
		}
	}
	for _, sec := range s.Secrets {
		args = append(args, "--secret", "id="+sec.ID+",src="+sec.File)
	}
	for _, l := range s.Labels {
		args = append(args, "--label", l.Name+"="+l.Value)
	}
	return append(args, s.ContextDir), env
}

// cliVars are variables the docker and builder CLIs read themselves; a
// build variable with one of these names is passed by value instead of
// through the environment so it cannot change how the CLI runs.
var cliVars = []string{"PATH", "HOME", "LANG", "TMPDIR", "SHELL", "USER", "PWD", "LD_PRELOAD", "LD_LIBRARY_PATH"}

func reservedVar(name string) bool {
	if slices.Contains(cliVars, name) {
		return true
	}
	for _, p := range []string{"DOCKER_", "BUILDX_", "BUILDKIT_", "SSL_", "GIT_", "RAILPACK_", "NIXPACKS_", "BUILD_GIT_"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return strings.HasSuffix(strings.ToUpper(name), "_PROXY")
}

// passVar returns the CLI argument for a variable and, unless the name is
// reserved, the environment entry carrying its value.
func passVar(name, value string) (arg, env string) {
	if reservedVar(name) {
		return name + "=" + value, ""
	}
	return name, name + "=" + value
}

var pushDigestRe = regexp.MustCompile(`digest: (sha256:[0-9a-f]{64})`)

// push pushes ref and returns its digest.
func (d dockerCLI) push(ctx context.Context, log io.Writer, ref string) (string, error) {
	var out strings.Builder
	c := d.cmd(nil, "push", ref)
	w := io.MultiWriter(log, &out)
	c.Stdout, c.Stderr = w, w
	if err := d.run.Run(ctx, c); err != nil {
		return "", err
	}
	if m := pushDigestRe.FindStringSubmatch(out.String()); m != nil {
		return m[1], nil
	}
	return d.repoDigest(ctx, ref)
}

// repoDigest reads the registry digest of a pushed image.
func (d dockerCLI) repoDigest(ctx context.Context, ref string) (string, error) {
	out, err := d.out(ctx, "image", "inspect", "--format", `{{range .RepoDigests}}{{println .}}{{end}}`, ref)
	if err != nil {
		return "", err
	}
	repo := repository(ref)
	for _, line := range strings.Fields(out) {
		if r, dg, ok := strings.Cut(line, "@"); ok && r == repo {
			return dg, nil
		}
	}
	return "", fmt.Errorf("no digest for %s after the push", ref)
}

// repository strips the tag (and digest) from an image reference.
func repository(ref string) string {
	if i := strings.IndexByte(ref, '@'); i >= 0 {
		ref = ref[:i]
	}
	if i := strings.LastIndexByte(ref, ':'); i > strings.LastIndexByte(ref, '/') {
		ref = ref[:i]
	}
	return ref
}

// localImage is one tagged image of a repository.
type localImage struct {
	Tag     string
	Created time.Time
}

// pruneImages removes the local tags of repo beyond the newest keep.
// Images still used by a container fail to delete and stay, which is
// what we want. It returns the removed tags.
func (d dockerCLI) pruneImages(ctx context.Context, repo string, keep int) ([]string, error) {
	out, err := d.out(ctx, "image", "ls", "--format", "{{.Tag}}\t{{.CreatedAt}}", repo)
	if err != nil {
		return nil, err
	}
	imgs := parseImageList(out)
	var removed []string
	for _, img := range imagesToRemove(imgs, keep) {
		if _, err := d.out(ctx, "image", "rm", repo+":"+img.Tag); err == nil {
			removed = append(removed, img.Tag)
		}
	}
	return removed, nil
}

// parseImageList reads `docker image ls --format "{{.Tag}}\t{{.CreatedAt}}"`.
func parseImageList(out string) []localImage {
	var imgs []localImage
	for _, line := range strings.Split(out, "\n") {
		tag, created, ok := strings.Cut(strings.TrimSpace(line), "\t")
		if !ok || tag == "" || tag == "<none>" {
			continue
		}
		t, _ := time.Parse("2006-01-02 15:04:05 -0700 MST", created)
		imgs = append(imgs, localImage{Tag: tag, Created: t})
	}
	return imgs
}

// imagesToRemove sorts newest first and returns everything after keep.
func imagesToRemove(imgs []localImage, keep int) []localImage {
	imgs = slices.Clone(imgs)
	slices.SortStableFunc(imgs, func(a, b localImage) int { return b.Created.Compare(a.Created) })
	if keep < 0 {
		keep = 0
	}
	if len(imgs) <= keep {
		return nil
	}
	return imgs[keep:]
}
