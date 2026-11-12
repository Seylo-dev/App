package build

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// fakeRunner plays docker for Service tests.
type fakeRunner struct {
	mu    sync.Mutex
	calls []Cmd
	// build runs for `docker buildx build`; nil succeeds at once.
	build func(ctx context.Context, c Cmd) error
	// tool runs for commands other than docker (Railpack, Nixpacks).
	tool func(c Cmd) error
	// builders is what `buildx ls` lists; created and removed builders
	// change it. noJSON plays a buildx without `ls --format json`.
	builders []string
	noJSON   bool
	// noBuildx plays a node without the buildx plugin: `buildx` fails and
	// the legacy `docker build` refuses buildx's flags, like the real CLI.
	noBuildx bool
	// restarted is called for `buildx stop <builder>`. stop runs first
	// when set, and an error from it fails the stop instead.
	restarted func(builder string)
	stop      func(ctx context.Context, builder string) error
}

func (f *fakeRunner) Run(ctx context.Context, c Cmd) error {
	f.mu.Lock()
	f.calls = append(f.calls, c)
	f.mu.Unlock()
	args := strings.Join(c.Args, " ")
	out := c.Stdout
	if out == nil {
		out = io.Discard
	}
	switch {
	case c.Name != "docker" && f.tool != nil:
		return f.tool(c)
	case c.Name != "docker":
		return fmt.Errorf("unexpected command %s", c)
	case f.noBuildx && strings.HasPrefix(args, "buildx"):
		fmt.Fprintln(out, "docker: 'buildx' is not a docker command.")
		return &ExitError{Cmd: "docker", Code: 1}
	case strings.HasPrefix(args, "build "):
		fmt.Fprintln(out, "unknown flag: --progress")
		return &ExitError{Cmd: "docker", Code: 125}
	case strings.HasPrefix(args, "buildx inspect"), strings.HasPrefix(args, "buildx stop"):
		// buildx inspect [--bootstrap] <name>, buildx stop <name>
		f.mu.Lock()
		found := slices.Contains(f.builders, c.Args[len(c.Args)-1])
		f.mu.Unlock()
		if !found {
			return &ExitError{Cmd: "docker", Code: 1}
		}
		if f.stop != nil && strings.HasPrefix(args, "buildx stop") {
			if err := f.stop(ctx, c.Args[len(c.Args)-1]); err != nil {
				return err
			}
		}
		if f.restarted != nil && strings.HasPrefix(args, "buildx stop") {
			f.restarted(c.Args[len(c.Args)-1])
		}
	case strings.HasPrefix(args, "buildx ls --format json"):
		if f.noJSON {
			return &ExitError{Cmd: "docker", Code: 1}
		}
		f.mu.Lock()
		for _, b := range f.builders {
			fmt.Fprintf(out, "{\"Name\":%q,\"Nodes\":[{\"Name\":%q}]}\n", b, b+"0")
		}
		f.mu.Unlock()
	case strings.HasPrefix(args, "buildx ls"):
		// Older buildx: builder rows and their node rows.
		f.mu.Lock()
		for _, b := range f.builders {
			fmt.Fprintf(out, "%s\n%s0\n", b, b)
		}
		f.mu.Unlock()
	case strings.HasPrefix(args, "buildx create"):
		f.mu.Lock()
		f.builders = append(f.builders, c.Args[3])
		f.mu.Unlock()
	case strings.HasPrefix(args, "buildx rm"):
		f.mu.Lock()
		f.builders = slices.DeleteFunc(f.builders, func(b string) bool { return b == c.Args[2] })
		f.mu.Unlock()
	case strings.HasPrefix(args, "buildx build"):
		if f.build != nil {
			return f.build(ctx, c)
		}
		fmt.Fprintln(out, "#1 building")
	case strings.HasPrefix(args, "push "):
		fmt.Fprintf(out, "3: digest: sha256:%s size: 528\n", hex64("d"))
	case strings.HasPrefix(args, "image ls"):
		for i := 1; i <= 5; i++ {
			fmt.Fprintf(out, "%d\t2026-11-0%d 10:00:00 +0000 UTC\n", i, i)
		}
	}
	return nil
}

func (f *fakeRunner) commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		out = append(out, c.Name+" "+strings.Join(c.Args, " "))
	}
	return out
}

type reports struct {
	mu     sync.Mutex
	events []*agentv1.Event
	final  chan *agentv1.BuildProgress
}

func newReports() *reports { return &reports{final: make(chan *agentv1.BuildProgress, 4)} }

func (r *reports) emit(e *agentv1.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}

func (r *reports) report(_ context.Context, e *agentv1.Event) error {
	r.final <- e.GetBuildProgress()
	return nil
}

func (r *reports) stages() []agentv1.BuildStage {
	r.mu.Lock()
	defer r.mu.Unlock()
	var s []agentv1.BuildStage
	for _, e := range r.events {
		s = append(s, e.GetBuildProgress().GetStage())
	}
	return s
}

func newTestService(t *testing.T, fr *fakeRunner, rep *reports) *Service {
	t.Helper()
	dir := t.TempDir()
	svc := New(Options{
		Dir: filepath.Join(dir, "builds"), ToolsDir: filepath.Join(dir, "tools"),
		Runner: fr, Emit: rep.emit, Report: rep.report,
		Sizing: &Sizing{Cores: 2, MemoryGB: 4},
	})
	t.Cleanup(svc.Close)
	return svc
}

func inlineRequest(id string) *agentv1.BuildRequest {
	return &agentv1.BuildRequest{
		BuildId: id, ServiceId: "svc1", ImageReference: DefaultRegistry + "/svc1:3",
		Source: &agentv1.BuildSource{Source: &agentv1.BuildSource_InlineDockerfile{InlineDockerfile: "FROM busybox\n"}},
		Env:    []*agentv1.EnvVar{{Name: "PUBLIC", Value: "p"}, {Name: "TOKEN", Value: "hidden", Secret: true}},
	}
}

func finalOf(t *testing.T, rep *reports) *agentv1.BuildProgress {
	t.Helper()
	select {
	case p := <-rep.final:
		return p
	case <-time.After(5 * time.Second):
		t.Fatal("no final build result reported")
		return nil
	}
}

func TestServiceBuildsPushesAndRetains(t *testing.T) {
	fr := &fakeRunner{}
	var sawSecret, sawPublicSecret, sawDockerfile bool
	fr.build = func(_ context.Context, c Cmd) error {
		for i, a := range c.Args {
			if a == "--secret" && strings.HasPrefix(c.Args[i+1], "id=TOKEN,src=") {
				f := strings.TrimPrefix(c.Args[i+1], "id=TOKEN,src=")
				b, _ := os.ReadFile(f)
				sawSecret = string(b) == "hidden"
			}
			// Variables that are not secret are build secrets too, so RUN --mount=type=secret works for every one.
			if a == "--secret" && strings.HasPrefix(c.Args[i+1], "id=PUBLIC,src=") {
				f := strings.TrimPrefix(c.Args[i+1], "id=PUBLIC,src=")
				b, _ := os.ReadFile(f)
				sawPublicSecret = string(b) == "p"
			}
			if a == "-f" {
				b, _ := os.ReadFile(c.Args[i+1])
				sawDockerfile = string(b) == "FROM busybox\n"
			}
		}
		fmt.Fprintln(c.Stdout, "#1 building")
		if !slices.Contains(c.Env, "PUBLIC=p") || slices.ContainsFunc(c.Env, func(e string) bool { return strings.Contains(e, "hidden") }) {
			t.Errorf("build env %v", c.Env)
		}
		return nil
	}
	rep := newReports()
	svc := newTestService(t, fr, rep)

	job, err := svc.Start(inlineRequest("b1"))
	if err != nil {
		t.Fatal(err)
	}
	again, err := svc.Start(inlineRequest("b1"))
	if err != nil || again != job {
		t.Fatalf("starting the same build again: %v, same job %v", err, again == job)
	}

	p := finalOf(t, rep)
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED || p.GetImageDigest() != "sha256:"+hex64("d") || p.GetDuration() == nil {
		t.Fatalf("final %v", p)
	}
	if !sawSecret || !sawPublicSecret || !sawDockerfile {
		t.Fatalf("secret file seen %v, public variable as a secret %v, Dockerfile seen %v", sawSecret, sawPublicSecret, sawDockerfile)
	}
	want := []agentv1.BuildStage{agentv1.BuildStage_BUILD_STAGE_QUEUED, agentv1.BuildStage_BUILD_STAGE_FETCHING_SOURCE, agentv1.BuildStage_BUILD_STAGE_BUILDING, agentv1.BuildStage_BUILD_STAGE_PUSHING}
	if got := rep.stages(); !slices.Equal(got, want) {
		t.Fatalf("emitted stages %v, want %v", got, want)
	}

	var log strings.Builder
	if err := job.Watch(context.Background(), func(r *agentv1.BuildResponse) error { log.Write(r.GetLog()); return nil }); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Creating the build worker", "#1 building", "Removed the old local image 1", "Pushed "} {
		if !strings.Contains(log.String(), want) {
			t.Errorf("log lacks %q:\n%s", want, log.String())
		}
	}
	if strings.Contains(log.String(), "hidden") {
		t.Error("a secret value is in the log")
	}

	cmds := strings.Join(fr.commands(), "\n")
	for _, want := range []string{"docker buildx create --name " + BuilderPrefix + "-svc1-2c-4g", "--driver-opt memory=4g", "docker push " + DefaultRegistry + "/svc1:3", "docker image rm " + DefaultRegistry + "/svc1:1"} {
		if !strings.Contains(cmds, want) {
			t.Errorf("commands lack %q:\n%s", want, cmds)
		}
	}
	if strings.Contains(cmds, "image rm "+DefaultRegistry+"/svc1:3") {
		t.Error("removed an image within the keep count")
	}
	if entries, _ := os.ReadDir(svc.workRoot()); len(entries) != 0 {
		t.Errorf("workspace left behind: %v", entries)
	}
}

func TestServiceCancel(t *testing.T) {
	fr := &fakeRunner{}
	started := make(chan struct{})
	fr.build = func(ctx context.Context, _ Cmd) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	rep := newReports()
	svc := newTestService(t, fr, rep)
	if _, err := svc.Start(inlineRequest("b2")); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := svc.Cancel("b2"); err != nil {
		t.Fatal(err)
	}
	if p := finalOf(t, rep); p.GetStage() != agentv1.BuildStage_BUILD_STAGE_CANCELLED {
		t.Fatalf("final %v", p)
	}
	if err := svc.Cancel("nope"); err != ErrNotFound {
		t.Fatalf("cancel unknown: %v", err)
	}
}

func TestServiceFailureAndQueue(t *testing.T) {
	fr := &fakeRunner{}
	release := make(chan struct{})
	var once sync.Once
	fr.build = func(ctx context.Context, c Cmd) error {
		first := false
		once.Do(func() { first = true })
		if first {
			<-release
			return &ExitError{Cmd: "docker", Code: 1}
		}
		return nil
	}
	rep := newReports()
	svc := newTestService(t, fr, rep)
	if _, err := svc.Start(inlineRequest("b3")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { r, _ := svc.Queue().Stats(); return r == 1 })
	second, err := svc.Start(inlineRequest("b4"))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { _, w := svc.Queue().Stats(); return w == 1 })
	close(release)

	results := map[string]*agentv1.BuildProgress{}
	for range 2 {
		p := finalOf(t, rep)
		results[p.GetBuildId()] = p
	}
	if p := results["b3"]; p.GetStage() != agentv1.BuildStage_BUILD_STAGE_FAILED || !strings.Contains(p.GetMessage(), "lines above") {
		t.Fatalf("b3 %v", p)
	}
	if p := results["b4"]; p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("b4 %v", p)
	}
	var log strings.Builder
	_ = second.Watch(context.Background(), func(r *agentv1.BuildResponse) error { log.Write(r.GetLog()); return nil })
	if !strings.Contains(log.String(), "Waiting for 1 build(s)") {
		t.Errorf("queued build log:\n%s", log.String())
	}
}

// stagesOf lists the stages emitted for one build, in order.
func (r *reports) stagesOf(buildID string) []agentv1.BuildStage {
	r.mu.Lock()
	defer r.mu.Unlock()
	var s []agentv1.BuildStage
	for _, e := range r.events {
		if p := e.GetBuildProgress(); p.GetBuildId() == buildID {
			s = append(s, p.GetStage())
		}
	}
	return s
}

// The panel keeps a build queued until a stage after BUILD_STAGE_QUEUED
// arrives, without reading the message (apps/panel deployments/engine.ts
// recordBuildProgress): a build waiting for a slot sends QUEUED and nothing
// else, FETCHING_SOURCE comes first once it has the slot, and cancelling it
// while it waits takes it out of the queue.
func TestServiceWaitingBuildSendsOnlyQueuedUntilItsSlot(t *testing.T) {
	fr := &fakeRunner{}
	release := make(chan struct{})
	var once sync.Once
	fr.build = func(ctx context.Context, c Cmd) error {
		first := false
		once.Do(func() { first = true })
		if first {
			<-release
		}
		return nil
	}
	rep := newReports()
	svc := newTestService(t, fr, rep)
	if _, err := svc.Start(inlineRequest("w1")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { r, _ := svc.Queue().Stats(); return r == 1 })
	for _, id := range []string{"w2", "w3"} {
		if _, err := svc.Start(inlineRequest(id)); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, func() bool { _, w := svc.Queue().Stats(); return w == 2 })
	// QUEUED goes out right after a build joins the waiters, outside the queue's lock.
	waitFor(t, func() bool { return len(rep.stagesOf("w2")) > 0 && len(rep.stagesOf("w3")) > 0 })
	queued := []agentv1.BuildStage{agentv1.BuildStage_BUILD_STAGE_QUEUED}
	for _, id := range []string{"w2", "w3"} {
		if got := rep.stagesOf(id); !slices.Equal(got, queued) {
			t.Fatalf("%s waiting sent %v, want %v", id, got, queued)
		}
	}

	if err := svc.Cancel("w2"); err != nil {
		t.Fatal(err)
	}
	if p := finalOf(t, rep); p.GetBuildId() != "w2" || p.GetStage() != agentv1.BuildStage_BUILD_STAGE_CANCELLED {
		t.Fatalf("final %v", p)
	}
	waitFor(t, func() bool { _, w := svc.Queue().Stats(); return w == 1 })

	close(release)
	for range 2 {
		if p := finalOf(t, rep); p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
			t.Fatalf("final %v", p)
		}
	}
	want := []agentv1.BuildStage{
		agentv1.BuildStage_BUILD_STAGE_QUEUED, agentv1.BuildStage_BUILD_STAGE_FETCHING_SOURCE,
		agentv1.BuildStage_BUILD_STAGE_BUILDING, agentv1.BuildStage_BUILD_STAGE_PUSHING,
	}
	if got := rep.stagesOf("w3"); !slices.Equal(got, want) {
		t.Fatalf("w3 sent %v, want %v", got, want)
	}
	if got := rep.stagesOf("w2"); !slices.Equal(got, queued) {
		t.Fatalf("cancelled w2 sent %v, want %v", got, queued)
	}
}

func TestServiceRejectsInvalid(t *testing.T) {
	rep := newReports()
	svc := newTestService(t, &fakeRunner{}, rep)
	req := inlineRequest("b5")
	req.ImageReference = "docker.io/library/x:1"
	if _, err := svc.Start(req); err == nil {
		t.Fatal("accepted a push outside the panel registry")
	}
	req = inlineRequest("b6")
	req.Source = &agentv1.BuildSource{Source: &agentv1.BuildSource_UploadId{UploadId: "missing"}}
	if _, err := svc.Start(req); err != nil {
		t.Fatal(err)
	}
	if p := finalOf(t, rep); p.GetStage() != agentv1.BuildStage_BUILD_STAGE_FAILED || !strings.Contains(p.GetMessage(), "not found") {
		t.Fatalf("missing upload: %v", p)
	}
}

// Nixpacks bakes every variable it sees into the image (ARG/ENV), so a
// secret variable must never reach it or the build args.
func TestNixpacksLeavesSecretsOut(t *testing.T) {
	var toolCalls []Cmd
	fr := &fakeRunner{tool: func(c Cmd) error {
		toolCalls = append(toolCalls, c)
		switch c.Args[0] {
		case "plan":
			// Nixpacks echoes the variables it was given plus its defaults.
			vars := map[string]string{"NODE_ENV": "production"}
			for i, a := range c.Args {
				if a == "--env" {
					name, value, ok := strings.Cut(c.Args[i+1], "=")
					if !ok {
						for _, e := range c.Env {
							if v, found := strings.CutPrefix(e, name+"="); found {
								value = v
							}
						}
					}
					vars[name] = value
				}
			}
			b, _ := json.Marshal(map[string]any{"variables": vars})
			_, _ = c.Stdout.Write(b)
		case "build":
			return os.MkdirAll(filepath.Join(c.Args[len(c.Args)-1], ".nixpacks"), 0o755)
		}
		return nil
	}}
	svc := newTestService(t, fr, newReports())
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(svc.opts.ToolsDir, 0o755))
	must(os.WriteFile(filepath.Join(svc.opts.ToolsDir, Nixpacks.Name+"-"+Nixpacks.Version), []byte("#!/bin/sh\n"), 0o755))
	contextDir := t.TempDir()
	req := &agentv1.BuildRequest{Builder: agentv1.Builder_BUILDER_NIXPACKS, Env: []*agentv1.EnvVar{
		{Name: "PUBLIC", Value: "p"},
		{Name: "STRIPE_SECRET_KEY", Value: "sk_live_hidden", Secret: true},
		{Name: "NODE_ENV", Value: "hidden-too", Secret: true},
	}}
	j := newJob("b1", "svc1", func() {})
	var spec buildSpec
	must(svc.nixpacksSpec(context.Background(), j, req, req.GetEnv(), &spec, contextDir))

	for _, c := range toolCalls {
		all := strings.Join(append(append([]string{}, c.Args...), c.Env...), " ")
		if strings.Contains(all, "hidden") || strings.Contains(all, "STRIPE_SECRET_KEY") {
			t.Fatalf("nixpacks %s saw a secret: %s", c.Args[0], all)
		}
	}
	args, env := spec.args()
	all := strings.Join(append(args, env...), " ")
	if strings.Contains(all, "hidden") || strings.Contains(all, "STRIPE_SECRET_KEY") {
		t.Fatalf("buildx args carry a secret: %s", all)
	}
	got := map[string]string{}
	for _, kv := range spec.BuildArgs {
		got[kv.Name] = kv.Value
	}
	if got["PUBLIC"] != "p" {
		t.Fatalf("build args = %v", spec.BuildArgs)
	}
	if _, ok := got["NODE_ENV"]; ok {
		t.Fatalf("a secret variable's name is a build arg: %v", spec.BuildArgs)
	}
	j.mu.Lock()
	log := string(j.pending)
	j.mu.Unlock()
	if !strings.Contains(log, "2 secret variable(s) are not available during a Nixpacks build") {
		t.Fatalf("log = %s", log)
	}
}

// Every project builds in its own builder, so RUN --mount=type=cache
// folders and the layer cache never cross projects. The builder older
// agents shared and builders of another size go away.
func TestBuildersArePerProject(t *testing.T) {
	size := Sizing{Cores: 2, MemoryGB: 4}
	shared, otherSize := size.Name(), BuilderPrefix+"-proja-4c-8g"
	fr := &fakeRunner{builders: []string{shared, otherSize, "someone-elses"}}
	var used []string
	var mu sync.Mutex
	fr.build = func(_ context.Context, c Cmd) error {
		mu.Lock()
		used = append(used, c.Args[3])
		mu.Unlock()
		return nil
	}
	rep := newReports()
	svc := newTestService(t, fr, rep)
	run := func(id, project, service string) {
		t.Helper()
		req := inlineRequest(id)
		req.ProjectId, req.ServiceId = project, service
		req.ImageReference = DefaultRegistry + "/" + service + ":1"
		if _, err := svc.Start(req); err != nil {
			t.Fatal(err)
		}
		if p := finalOf(t, rep); p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
			t.Fatalf("build %s = %v", id, p)
		}
	}
	run("b1", "proja", "svc1")
	run("b2", "proja", "svc2")
	run("b3", "projb", "svc3")
	run("b4", "", "svc4") // an older panel: per service

	a, b, c := size.BuilderName("proja"), size.BuilderName("projb"), size.BuilderName("svc4")
	if want := []string{a, a, b, c}; !slices.Equal(used, want) {
		t.Fatalf("builders used %v, want %v", used, want)
	}
	fr.mu.Lock()
	left := slices.Clone(fr.builders)
	fr.mu.Unlock()
	slices.Sort(left)
	want := []string{"someone-elses", a, b, c}
	slices.Sort(want)
	if !slices.Equal(left, want) {
		t.Fatalf("builders left %v, want %v (the shared and the old-size ones removed)", left, want)
	}

	// An idle project's builder goes away; the clock starts when first seen.
	if got := svc.buildx.reapIdle(context.Background(), time.Hour); len(got) != 0 {
		t.Fatalf("reaped %v right after use", got)
	}
	svc.buildx.mu.Lock()
	svc.buildx.used[b] = time.Now().Add(-2 * time.Hour)
	svc.buildx.mu.Unlock()
	if got := svc.buildx.reapIdle(context.Background(), time.Hour); !slices.Equal(got, []string{b}) {
		t.Fatalf("reaped %v, want %s", got, b)
	}
	// The next build of that project creates it again.
	run("b5", "projb", "svc3")
	if used[len(used)-1] != b {
		t.Fatalf("builders used %v", used)
	}
}

func TestBuildersListWithoutJSON(t *testing.T) {
	for _, noJSON := range []bool{false, true} {
		fr := &fakeRunner{noJSON: noJSON, builders: []string{BuilderPrefix + "-p1-2c-4g", "default", BuilderPrefix + "-p2-2c-4g"}}
		b := &buildxEnv{cli: dockerCLI{run: fr}, size: Sizing{2, 4}}
		got, err := b.ours(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if want := []string{BuilderPrefix + "-p1-2c-4g", BuilderPrefix + "-p2-2c-4g"}; !slices.Equal(got, want) {
			t.Fatalf("noJSON=%v: ours = %v, want %v", noJSON, got, want)
		}
	}
}

func TestScopeName(t *testing.T) {
	for _, scope := range []string{"ab12cd34ef56gh78", "proj_1"} {
		if got := scopeName(scope); got != scope {
			t.Errorf("scopeName(%q) = %q", scope, got)
		}
	}
	for _, scope := range []string{"Proj", "a-4c-8g", "../x", "", strings.Repeat("a", 41)} {
		got := scopeName(scope)
		if !strings.HasPrefix(got, "x") || len(got) != 17 || strings.Contains(got, "-") {
			t.Errorf("scopeName(%q) = %q, want a hashed name", scope, got)
		}
	}
}

// Without the buildx plugin a build fails with a reason that says what to
// install, instead of announcing a fallback to `docker build` that cannot
// parse the flags builds pass. Installing the plugin is enough: the next
// build checks again.
func TestBuildWithoutBuildxSaysWhatToInstall(t *testing.T) {
	fr := &fakeRunner{noBuildx: true}
	rep := newReports()
	svc := newTestService(t, fr, rep)
	if _, err := svc.Start(inlineRequest("b1")); err != nil {
		t.Fatal(err)
	}
	p := finalOf(t, rep)
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_FAILED || p.GetMessage() != ErrNoBuildx.Msg {
		t.Fatalf("result = %v %q", p.GetStage(), p.GetMessage())
	}
	for _, c := range fr.commands() {
		if strings.HasPrefix(c, "docker build ") {
			t.Fatalf("ran the legacy builder: %q", c)
		}
	}

	fr.mu.Lock()
	fr.noBuildx = false
	fr.mu.Unlock()
	if _, err := svc.Start(inlineRequest("b2")); err != nil {
		t.Fatal(err)
	}
	if p := finalOf(t, rep); p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("after installing buildx: %v %q", p.GetStage(), p.GetMessage())
	}
}
