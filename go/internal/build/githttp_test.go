package build

import (
	"context"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// plainGitServer serves one bare repository with secret.txt over plain
// http (git http-backend) and counts the requests it gets.
func plainGitServer(t *testing.T) (url string, hits *atomic.Int32) {
	t.Helper()
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	work := filepath.Join(root, "work")
	run := func(dir string, args ...string) {
		cmd := exec.Command(gitBin, args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
			"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(work, 0o755))
	run(work, "init", "-q", "-b", "main")
	must(os.WriteFile(filepath.Join(work, "secret.txt"), []byte("INTERNAL-ONLY-SECRET\n"), 0o644))
	run(work, "add", ".")
	run(work, "commit", "-q", "-m", "x")
	run(root, "clone", "-q", "--bare", work, "internal.git")
	backend := &cgi.Handler{Path: gitBin, Args: []string{"http-backend"},
		Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1"}}
	hits = &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv.URL + "/internal.git", hits
}

// Plain http:// git is off unless the panel marks the source as allowed
// by an admin (GitSource.allow_plain_http): a member could otherwise make
// the node clone an internal http:// git server and read files back
// (agentio-2, the agent's half), and anyone on the path could change what
// is built.
func TestPlainHTTPGitNeedsAdminOptIn(t *testing.T) {
	url, hits := plainGitServer(t)
	s := New(Options{Dir: t.TempDir(), Runner: ExecRunner{}})
	defer s.Close()
	ctx := context.Background()
	fetch := func(src *agentv1.GitSource) (*agentv1.FetchGitFileResponse, error) {
		return s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: src, Path: "secret.txt"})
	}

	var inv *InvalidError
	if _, err := fetch(&agentv1.GitSource{Url: url, Ref: "main"}); !errors.As(err, &inv) {
		t.Fatalf("http:// without the opt-in: %v", err)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the http:// server got %d requests without the opt-in", n)
	}
	if _, err := fetch(&agentv1.GitSource{Url: url, Ref: "main", Token: "t", AllowPlainHttp: true}); !errors.As(err, &inv) {
		t.Fatalf("http:// with a token: %v", err)
	}

	res, err := fetch(&agentv1.GitSource{Url: url, Ref: "main", AllowPlainHttp: true})
	if err != nil || !strings.Contains(string(res.GetContent()), "INTERNAL-ONLY-SECRET") {
		t.Fatalf("http:// with the admin opt-in: %v %v", res, err)
	}

	// An https:// server that redirects the clone to http:// gets nowhere
	// without the opt-in: git refuses the plain http hop.
	redirect := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, strings.TrimSuffix(url, "/internal.git")+r.URL.RequestURI(), http.StatusFound)
	}))
	defer redirect.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: redirect.Certificate().Raw}), 0o644); err != nil {
		t.Fatal(err)
	}
	before := hits.Load()
	viaTLS := New(Options{Dir: t.TempDir(), Runner: caRunner{ca: ca}})
	defer viaTLS.Close()
	_, err = viaTLS.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: &agentv1.GitSource{Url: redirect.URL + "/internal.git", Ref: "main"}, Path: "secret.txt"})
	if !errors.Is(err, ErrFetch) {
		t.Fatalf("https:// redirected to http://: %v", err)
	}
	if n := hits.Load() - before; n != 0 {
		t.Fatalf("git followed the redirect to http:// (%d requests)", n)
	}
}

func TestHTTPAllow(t *testing.T) {
	cases := []struct {
		src  *agentv1.GitSource
		want string
	}{
		{&agentv1.GitSource{Url: "https://git.example.com/a.git"}, "never"},
		{&agentv1.GitSource{Url: "http://git.example.com/a.git"}, "never"},
		{&agentv1.GitSource{Url: "http://git.example.com/a.git", AllowPlainHttp: true}, "always"},
		{&agentv1.GitSource{Url: "http://git.example.com/a.git", AllowPlainHttp: true, Token: "t"}, "never"},
		{&agentv1.GitSource{Url: "git@git.example.com:a.git", AllowPlainHttp: true, SshPrivateKey: "k"}, "never"},
	}
	for _, c := range cases {
		if got := httpAllow(c.src); got != c.want {
			t.Errorf("httpAllow(%v) = %s, want %s", c.src, got, c.want)
		}
	}
}
