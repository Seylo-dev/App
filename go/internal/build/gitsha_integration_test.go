//go:build integration

package build_test

import (
	"context"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// servedRepo commits files to a new repository, serves it over plain http
// from this process (git http-backend) and returns its address and the
// full id of its head commit.
func servedRepo(t *testing.T, files map[string]string) (url, head string) {
	t.Helper()
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Fatal("git is not installed in the test VM")
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
	for name, body := range files {
		p := filepath.Join(work, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run(work, "init", "-q", "-b", "main")
	run(work, "add", ".")
	run(work, "commit", "-q", "-m", "app")
	head = run(work, "rev-parse", "HEAD")
	run(root, "clone", "-q", "--bare", work, "app.git")
	srv := httptest.NewServer(&cgi.Handler{Path: gitBin, Args: []string{"http-backend"},
		Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1"}})
	t.Cleanup(srv.Close)
	return srv.URL + "/app.git", head
}

// runLogged is env.run that also returns the build's output and the
// durable result.
func (e *env) runLogged(t *testing.T, req *agentv1.BuildRequest, timeout time.Duration) (digest, log string, final *agentv1.BuildProgress) {
	t.Helper()
	job, err := e.svc.Start(req)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	werr := job.Watch(ctx, func(r *agentv1.BuildResponse) error {
		out.Write(r.GetLog())
		return nil
	})
	if f := job.Final(); werr != nil || f.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("build %s: %v %v\n%s", req.GetBuildId(), werr, f, tail(out.String(), 80))
	}
	select {
	case final = <-e.reports:
	case <-time.After(10 * time.Second):
		t.Fatal("no durable report")
	}
	return final.GetImageDigest(), out.String(), final
}

// A Dockerfile build from git sees GIT_SHA, the full id of the commit the
// node checked out, through ARG GIT_SHA (Easypanel passes it the same
// way); a Dockerfile that declares no ARG GIT_SHA still builds (BuildKit
// says nothing about the unused build arg); a GIT_SHA the service sets
// itself wins; and the durable result names the commit.
func TestGitBuildPassesGitSHA(t *testing.T) {
	e := setup(t)
	url, head := servedRepo(t, map[string]string{
		"with-arg/Dockerfile": "FROM busybox:1.37\nARG GIT_SHA\nRUN echo \"sha=$GIT_SHA\" > /sha\nCMD [\"cat\", \"/sha\"]\n",
		"no-arg/Dockerfile":   "FROM busybox:1.37\nRUN echo built > /msg\nCMD [\"cat\", \"/msg\"]\n",
	})
	if len(head) != 40 {
		t.Fatalf("head %q", head)
	}
	build := func(id, context string, env ...*agentv1.EnvVar) (string, string, *agentv1.BuildProgress) {
		t.Helper()
		repo := e.repo(id)
		digest, log, final := e.runLogged(t, &agentv1.BuildRequest{
			BuildId: id, ServiceId: e.prefix + "-" + id, ImageReference: repo + ":1",
			Source: &agentv1.BuildSource{Source: &agentv1.BuildSource_Git{Git: &agentv1.GitSource{
				Url: url, Ref: "main", AllowPlainHttp: true, AllowInternalHost: true,
			}}},
			Builder: agentv1.Builder_BUILDER_DOCKERFILE, ContextPath: context, Env: env,
		}, 10*time.Minute)
		return docker(t, "run", "--rm", "--label", "bdit="+e.prefix, e.pullByDigest(t, repo, digest)), log, final
	}

	out, log, final := build("sha1", "with-arg")
	if out != "sha="+head {
		t.Fatalf("the image says %q, want sha=%s\n%s", out, head, tail(log, 40))
	}
	// The durable result names it too, for the containers' GIT_SHA when the stream was lost.
	if final.GetCommit() != head {
		t.Fatalf("the build result names commit %q, want %s", final.GetCommit(), head)
	}

	out, log, _ = build("sha2", "no-arg")
	if out != "built" {
		t.Fatalf("the image without ARG GIT_SHA says %q", out)
	}
	// What the build said about the unused build arg, for the record.
	for _, line := range strings.Split(log, "\n") {
		if strings.Contains(line, "GIT_SHA") || strings.Contains(strings.ToLower(line), "warn") || strings.Contains(line, "consumed") {
			t.Logf("no ARG GIT_SHA: %s", line)
		}
	}

	// A commit id the service pins itself, which the panel sends as a plain
	// variable (env-analyzer isPublicName), is the build arg.
	const pinned = "ff9410c96aa507f27425f3c5dbb8e6bf8c4c37f9"
	out, log, _ = build("sha3", "with-arg", &agentv1.EnvVar{Name: "GIT_SHA", Value: pinned})
	if out != "sha="+pinned {
		t.Fatalf("an own GIT_SHA lost: the image says %q", out)
	}
	if !strings.Contains(log, "--> GIT_SHA is set in the service's variables") {
		t.Fatalf("the log does not say where GIT_SHA comes from:\n%s", tail(log, 40))
	}
}
