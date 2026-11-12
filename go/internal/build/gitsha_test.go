package build

import (
	"context"
	"encoding/json"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// twoCommitGitServer serves a bare repository whose main has two commits
// over plain http (git http-backend) and returns its address with the full
// ids of the first and the second (the head) commit.
func twoCommitGitServer(t *testing.T) (url, first, head string) {
	t.Helper()
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	work := filepath.Join(root, "work")
	run := func(dir string, args ...string) string {
		cmd := exec.Command(gitBin, args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
			"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=t@example.com")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	run(work, "init", "-q", "-b", "main")
	for _, v := range []string{"one", "two"} {
		if err := os.WriteFile(filepath.Join(work, "version.txt"), []byte(v+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		run(work, "add", ".")
		run(work, "commit", "-q", "-m", "version "+v)
		if v == "one" {
			first = run(work, "rev-parse", "HEAD")
		}
	}
	head = run(work, "rev-parse", "HEAD")
	run(root, "clone", "-q", "--bare", work, "app.git")
	backend := &cgi.Handler{Path: gitBin, Args: []string{"http-backend"},
		Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1"}}
	srv := httptest.NewServer(backend)
	t.Cleanup(srv.Close)
	return srv.URL + "/app.git", first, head
}

// gitSHARun is one build of a git source with real git and a fake docker,
// Railpack and Nixpacks: what each builder was handed.
type gitSHARun struct {
	build *Cmd   // docker buildx build
	tools []Cmd  // Railpack and Nixpacks commands
	log   string // the build's output
	final *agentv1.BuildProgress
}

// buildArg is the value the buildx call passes for name (from the argument
// or, for names passed through the environment, from the command's env),
// and how many times it is passed.
func (r gitSHARun) buildArg(name string) (value string, count int) {
	for i, a := range r.build.Args {
		if a != "--build-arg" || i+1 >= len(r.build.Args) {
			continue
		}
		n, v, byValue := strings.Cut(r.build.Args[i+1], "=")
		if n != name {
			continue
		}
		count++
		if !byValue {
			for _, e := range r.build.Env {
				if ev, ok := strings.CutPrefix(e, name+"="); ok {
					v = ev
				}
			}
		}
		value = v
	}
	return value, count
}

// secret is the content of the BuildKit secret id the buildx call mounts.
func (r gitSHARun) secret(t *testing.T, id string) (string, bool) {
	t.Helper()
	for i, a := range r.build.Args {
		if a == "--secret" && strings.HasPrefix(r.build.Args[i+1], "id="+id+",src=") {
			b, err := os.ReadFile(strings.TrimPrefix(r.build.Args[i+1], "id="+id+",src="))
			if err != nil {
				t.Fatal(err)
			}
			return string(b), true
		}
	}
	return "", false
}

// toolEnv is the value a Railpack or Nixpacks command got for name with
// --env, and whether it got it.
func toolEnv(c Cmd, name string) (string, bool) {
	for i, a := range c.Args {
		if a != "--env" || i+1 >= len(c.Args) {
			continue
		}
		n, v, byValue := strings.Cut(c.Args[i+1], "=")
		if n != name {
			continue
		}
		if !byValue {
			for _, e := range c.Env {
				if ev, ok := strings.CutPrefix(e, name+"="); ok {
					v = ev
				}
			}
		}
		return v, true
	}
	return "", false
}

func runGitSHABuild(t *testing.T, req *agentv1.BuildRequest) gitSHARun {
	t.Helper()
	var mu sync.Mutex
	var run gitSHARun
	fr := &fakeRunner{}
	fr.build = func(_ context.Context, c Cmd) error {
		mu.Lock()
		defer mu.Unlock()
		copied := c
		// The secret files are gone once the build ends: keep their content.
		dir := t.TempDir()
		copied.Args = slices.Clone(c.Args)
		for i, a := range copied.Args {
			if a != "--secret" {
				continue
			}
			id, src, _ := strings.Cut(strings.TrimPrefix(copied.Args[i+1], "id="), ",src=")
			b, err := os.ReadFile(src)
			if err != nil {
				return err
			}
			keep := filepath.Join(dir, id)
			if err := os.WriteFile(keep, b, 0o600); err != nil {
				return err
			}
			copied.Args[i+1] = "id=" + id + ",src=" + keep
		}
		run.build = &copied
		return nil
	}
	fr.tool = func(c Cmd) error {
		if c.Name == "git" {
			return ExecRunner{}.Run(context.Background(), c)
		}
		mu.Lock()
		run.tools = append(run.tools, c)
		mu.Unlock()
		switch {
		case strings.HasSuffix(c.Name, Nixpacks.Name+"-"+Nixpacks.Version) && c.Args[0] == "plan":
			vars := map[string]string{"NODE_ENV": "production"}
			for i, a := range c.Args {
				if a == "--env" {
					name, _, _ := strings.Cut(c.Args[i+1], "=")
					vars[name], _ = toolEnv(c, name)
				}
			}
			b, _ := json.Marshal(map[string]any{"variables": vars})
			_, _ = c.Stdout.Write(b)
		case strings.HasSuffix(c.Name, Nixpacks.Name+"-"+Nixpacks.Version) && c.Args[0] == "build":
			return os.MkdirAll(filepath.Join(c.Args[len(c.Args)-1], ".nixpacks"), 0o755)
		}
		return nil
	}
	rep := newReports()
	svc := newTestService(t, fr, rep)
	if err := os.MkdirAll(svc.opts.ToolsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tool := range []Tool{Railpack, Nixpacks} {
		if err := os.WriteFile(filepath.Join(svc.opts.ToolsDir, tool.Name+"-"+tool.Version), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	j, err := svc.Start(req)
	if err != nil {
		t.Fatal(err)
	}
	run.final = finalOf(t, rep)
	var log strings.Builder
	if err := j.Watch(context.Background(), func(r *agentv1.BuildResponse) error {
		log.Write(r.GetLog())
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	run.log = log.String()
	if run.final.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("build %v\n%s", run.final, run.log)
	}
	if run.build == nil {
		t.Fatalf("no buildx build ran\n%s", run.log)
	}
	return run
}

func gitRequest(url string, builder agentv1.Builder, commit string, env ...*agentv1.EnvVar) *agentv1.BuildRequest {
	req := &agentv1.BuildRequest{
		BuildId: "b1", ServiceId: "svc1", ImageReference: DefaultRegistry + "/svc1:4", Builder: builder,
		Source: &agentv1.BuildSource{Source: &agentv1.BuildSource_Git{Git: &agentv1.GitSource{
			Url: url, Ref: "main", Commit: commit, AllowPlainHttp: true, AllowInternalHost: true,
		}}},
		Env: env,
	}
	if builder == agentv1.Builder_BUILDER_DOCKERFILE {
		// The repository has no Dockerfile: one typed in the panel.
		req.DockerfileContent = "FROM busybox:1.37\nARG GIT_SHA\n"
	}
	return req
}

// A build from git gets GIT_SHA, the full id of the commit the agent
// checked out, with every builder, as Easypanel passes it: a build arg and
// a build secret for Dockerfiles, a build variable for Railpack (a secret
// there, like all of them) and Nixpacks (a build arg of its Dockerfile).
// Before: no GIT_SHA at all, so an image that bakes APP_VERSION from it
// baked "" and refused to start.
func TestGitBuildsGetGitSHA(t *testing.T) {
	url, _, head := twoCommitGitServer(t)
	public := &agentv1.EnvVar{Name: "PUBLIC", Value: "p"}

	t.Run("dockerfile", func(t *testing.T) {
		run := runGitSHABuild(t, gitRequest(url, agentv1.Builder_BUILDER_DOCKERFILE, "", public))
		if v, n := run.buildArg(GitSHAVar); v != head || n != 1 {
			t.Fatalf("build arg GIT_SHA = %q (%d times), want %s\n%v", v, n, head, run.build.Args)
		}
		if v, ok := run.secret(t, GitSHAVar); !ok || v != head {
			t.Fatalf("secret GIT_SHA = %q %v", v, ok)
		}
		if v, _ := run.buildArg("PUBLIC"); v != "p" {
			t.Fatalf("the service's own variables went missing: %v", run.build.Args)
		}
		if !strings.Contains(run.log, "--> GIT_SHA="+head+"\n") {
			t.Fatalf("the log does not say what GIT_SHA is:\n%s", run.log)
		}
	})

	t.Run("railpack", func(t *testing.T) {
		req := gitRequest(url, agentv1.Builder_BUILDER_RAILPACK, "", public)
		run := runGitSHABuild(t, req)
		if len(run.tools) != 1 || run.tools[0].Args[0] != "prepare" {
			t.Fatalf("railpack calls %v", run.tools)
		}
		if v, ok := toolEnv(run.tools[0], GitSHAVar); !ok || v != head {
			t.Fatalf("railpack prepare got GIT_SHA = %q %v: %v", v, ok, run.tools[0].Args)
		}
		if v, ok := run.secret(t, GitSHAVar); !ok || v != head {
			t.Fatalf("secret GIT_SHA = %q %v", v, ok)
		}
		// The cache key of the steps that see secrets stays the panel's
		// variables: a new commit does not rebuild the install step.
		if v, _ := run.buildArg("secrets-hash"); v != envHash(req.GetEnv()) {
			t.Fatalf("secrets-hash %s changed with GIT_SHA (panel variables: %s)", v, envHash(req.GetEnv()))
		}
	})

	t.Run("nixpacks", func(t *testing.T) {
		run := runGitSHABuild(t, gitRequest(url, agentv1.Builder_BUILDER_NIXPACKS, "", public))
		if len(run.tools) != 2 {
			t.Fatalf("nixpacks calls %v", run.tools)
		}
		for _, c := range run.tools {
			if v, ok := toolEnv(c, GitSHAVar); !ok || v != head {
				t.Fatalf("nixpacks %s got GIT_SHA = %q %v", c.Args[0], v, ok)
			}
		}
		if v, n := run.buildArg(GitSHAVar); v != head || n != 1 {
			t.Fatalf("build arg GIT_SHA = %q (%d times), want %s", v, n, head)
		}
	})
}

// GIT_SHA is the commit actually built, in full: a redeploy pins the
// commit (a short id still checks out, and GIT_SHA is the full one), and a
// deploy of the branch head is the head the agent fetched.
func TestGitSHAIsTheCheckedOutCommit(t *testing.T) {
	url, first, head := twoCommitGitServer(t)
	for _, c := range []struct{ name, commit, want string }{
		{"branch head", "", head},
		{"pinned commit", first, first},
		{"short commit id", first[:10], first},
	} {
		t.Run(c.name, func(t *testing.T) {
			run := runGitSHABuild(t, gitRequest(url, agentv1.Builder_BUILDER_DOCKERFILE, c.commit))
			if v, _ := run.buildArg(GitSHAVar); v != c.want || len(v) != 40 {
				t.Fatalf("GIT_SHA = %q, want %s", v, c.want)
			}
		})
	}
}

// A GIT_SHA of the service's own or the project's shared variables (the
// panel sends both in env) wins, also an empty one; the agent adds none.
func TestOwnGitSHAWins(t *testing.T) {
	url, _, head := twoCommitGitServer(t)
	for _, own := range []string{"v1.4.2", ""} {
		for _, builder := range []agentv1.Builder{agentv1.Builder_BUILDER_DOCKERFILE, agentv1.Builder_BUILDER_RAILPACK, agentv1.Builder_BUILDER_NIXPACKS} {
			t.Run(builder.String()+"/"+own, func(t *testing.T) {
				run := runGitSHABuild(t, gitRequest(url, builder, "", &agentv1.EnvVar{Name: GitSHAVar, Value: own}))
				if strings.Contains(strings.Join(append(append([]string{}, run.build.Args...), run.build.Env...), " "), head) {
					t.Fatalf("the checked-out commit reached the build: %v %v", run.build.Args, run.build.Env)
				}
				for _, c := range run.tools {
					if v, _ := toolEnv(c, GitSHAVar); v != own {
						t.Fatalf("%s got GIT_SHA = %q, want %q", c.Args[0], v, own)
					}
				}
				if builder != agentv1.Builder_BUILDER_RAILPACK {
					if v, n := run.buildArg(GitSHAVar); v != own || n != 1 {
						t.Fatalf("build arg GIT_SHA = %q (%d times), want %q", v, n, own)
					}
				}
				if strings.Contains(run.log, "--> GIT_SHA=") {
					t.Fatalf("the log claims the agent set GIT_SHA:\n%s", run.log)
				}
			})
		}
	}
}

// Sources without a commit (uploads, inline Dockerfiles; images are not
// built) get no GIT_SHA.
func TestNoGitSHAWithoutGit(t *testing.T) {
	fr := &fakeRunner{}
	var args []string
	fr.build = func(_ context.Context, c Cmd) error {
		args = append(slices.Clone(c.Args), c.Env...)
		return nil
	}
	rep := newReports()
	svc := newTestService(t, fr, rep)
	if _, err := svc.Start(inlineRequest("inline1")); err != nil {
		t.Fatal(err)
	}
	if final := finalOf(t, rep); final.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("build %v", final)
	}
	if slices.ContainsFunc(args, func(a string) bool { return strings.Contains(a, GitSHAVar) }) {
		t.Fatalf("an inline Dockerfile got GIT_SHA: %v", args)
	}
}

func TestWithGitSHA(t *testing.T) {
	env := []*agentv1.EnvVar{{Name: "A", Value: "1"}}
	got := withGitSHA(env, "abc")
	if len(got) != 2 || got[1].GetName() != GitSHAVar || got[1].GetValue() != "abc" || len(env) != 1 {
		t.Fatalf("withGitSHA = %v (request env now %v)", got, env)
	}
	if got := withGitSHA(env, ""); len(got) != 1 {
		t.Fatalf("no commit: %v", got)
	}
	own := []*agentv1.EnvVar{{Name: GitSHAVar, Value: ""}}
	if got := withGitSHA(own, "abc"); len(got) != 1 || got[0].GetValue() != "" {
		t.Fatalf("an own empty GIT_SHA lost: %v", got)
	}
}
