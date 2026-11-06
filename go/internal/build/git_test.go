package build

import (
	"bytes"
	"context"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// gitServer serves bare repositories over smart HTTPS (git http-backend),
// requiring the token when one is set. No network beyond httptest. The
// returned runner makes git trust the test server's certificate.
func gitServer(t *testing.T, token string) (url string, repo string, runner Runner) {
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
	if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(work, "add", ".")
	run(work, "commit", "-q", "-m", "first")
	if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(work, "commit", "-q", "-am", "second commit")
	run(work, "checkout", "-q", "-b", "other")
	if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte("other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(work, "commit", "-q", "-am", "on other")
	run(work, "checkout", "-q", "main")
	run(root, "clone", "-q", "--bare", work, "repo.git")
	run(filepath.Join(root, "repo.git"), "config", "uploadpack.allowReachableSHA1InWant", "true")

	backend := &cgi.Handler{
		Path: gitBin,
		Args: []string{"http-backend"},
		Env:  []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1"},
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token != "" {
			user, pass, ok := r.BasicAuth()
			if !ok || user != "x-access-token" || pass != token {
				w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
				http.Error(w, "auth", http.StatusUnauthorized)
				return
			}
		}
		backend.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	ca := filepath.Join(root, "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o644); err != nil {
		t.Fatal(err)
	}
	return srv.URL + "/repo.git", work, caRunner{ca: ca}
}

// caRunner runs commands like ExecRunner with git trusting one CA file.
type caRunner struct{ ca string }

func (r caRunner) Run(ctx context.Context, c Cmd) error {
	c.Env = append(slices.Clone(c.Env), "GIT_SSL_CAINFO="+r.ca)
	return ExecRunner{}.Run(ctx, c)
}

func headOf(t *testing.T, repo, rev string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", repo, "rev-parse", rev).Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func TestFetchGitWithToken(t *testing.T) {
	url, repo, run := gitServer(t, "s3cret-token")
	ctx := context.Background()

	cases := []struct {
		name, ref, commit, want, subject string
	}{
		{"default branch", "", "", "two\n", "second commit"},
		{"branch", "other", "", "other\n", "on other"},
		{"exact commit", "main", headOf(t, repo, "main~1"), "one\n", "first"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			work := t.TempDir()
			dir := filepath.Join(work, "src")
			var log bytes.Buffer
			src := &agentv1.GitSource{Url: url, Ref: c.ref, Commit: c.commit, Token: "s3cret-token"}
			if err := validateGit(src); err != nil {
				t.Fatal(err)
			}
			info, err := fetchGit(ctx, run, &log, src, dir, work, false)
			if err != nil {
				t.Fatalf("%v\n%s", err, log.String())
			}
			b, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
			if string(b) != c.want {
				t.Fatalf("a.txt = %q, want %q", b, c.want)
			}
			if info.GetSubject() != c.subject || len(info.GetCommit()) != 40 || info.GetAuthor() != "Test" {
				t.Fatalf("info %v", info)
			}
			if strings.Contains(log.String(), "s3cret-token") {
				t.Fatal("the token is in the log")
			}
			cfg, _ := os.ReadFile(filepath.Join(dir, ".git", "config"))
			if strings.Contains(string(cfg), "s3cret-token") {
				t.Fatal("the token is in .git/config")
			}
		})
	}
}

func TestFetchGitWrongToken(t *testing.T) {
	url, _, run := gitServer(t, "right")
	work := t.TempDir()
	var log bytes.Buffer
	_, err := fetchGit(context.Background(), run, &log, &agentv1.GitSource{Url: url, Ref: "main", Token: "wrong"}, filepath.Join(work, "src"), work, false)
	if !errors.Is(err, ErrFetch) {
		t.Fatalf("got %v, want ErrFetch\n%s", err, log.String())
	}
}

func TestRedactURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://user:pw@github.com/a/b": "https://***@github.com/a/b",
		"https://github.com/a/b":         "https://github.com/a/b",
		"git@github.com:a/b.git":         "git@github.com:a/b.git",
	} {
		if got := redactURL(in); got != want {
			t.Errorf("redactURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGitSSHKeyHandling(t *testing.T) {
	work := t.TempDir()
	g, err := newGit(ExecRunner{}, &bytes.Buffer{}, &agentv1.GitSource{Url: "git@github.com:acme/app.git", SshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"}, work)
	if err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(work, "ssh", "id")
	fi, err := os.Stat(key)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", fi, err)
	}
	if b, _ := os.ReadFile(key); !strings.HasSuffix(string(b), "KEY-----\n") {
		t.Fatal("the key must end with a newline for OpenSSH")
	}
	hosts, _ := os.ReadFile(filepath.Join(work, "ssh", "known_hosts"))
	if !strings.Contains(string(hosts), "github.com ssh-ed25519 ") {
		t.Fatal("default known_hosts lack github.com")
	}
	var sshCmd string
	for _, e := range g.env {
		if v, ok := strings.CutPrefix(e, "GIT_SSH_COMMAND="); ok {
			sshCmd = v
		}
	}
	for _, want := range []string{"StrictHostKeyChecking=yes", "BatchMode=yes", "IdentitiesOnly=yes", "-F /dev/null", "GlobalKnownHostsFile=/dev/null"} {
		if !strings.Contains(sshCmd, want) {
			t.Errorf("GIT_SSH_COMMAND %q lacks %q", sshCmd, want)
		}
	}

	custom := t.TempDir()
	if _, err := newGit(ExecRunner{}, &bytes.Buffer{}, &agentv1.GitSource{SshPrivateKey: "k", SshKnownHosts: "git.example.com ssh-ed25519 AAAA"}, custom); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(custom, "ssh", "known_hosts")); strings.Contains(string(b), "github.com") || !strings.Contains(string(b), "git.example.com") {
		t.Fatalf("custom known_hosts: %q", b)
	}
}

// TestCredentialHelperAnswersOnlyItsHost: the helper is installed for the
// source's origin only and, even when git asks it anyway (a submodule or a
// redirect to another host), it hands the token to that host alone.
func TestCredentialHelperAnswersOnlyItsHost(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	ask := func(op, host string) string {
		cmd := exec.Command(sh, "-c", strings.TrimPrefix(credentialHelper, "!")+` "$@"`, "sh", op)
		cmd.Env = []string{"BUILD_GIT_HOST=git.example.com:8443", "BUILD_GIT_USER=x-access-token", "BUILD_GIT_TOKEN=tok-123"}
		cmd.Stdin = strings.NewReader("protocol=https\nhost=" + host + "\npath=a/b.git\n\n")
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("helper: %v", err)
		}
		return string(out)
	}
	if got := ask("get", "git.example.com:8443"); got != "username=x-access-token\npassword=tok-123\n" {
		t.Fatalf("own host: %q", got)
	}
	for _, host := range []string{"evil.example.com", "git.example.com", "git.example.com:8443.evil.example", ""} {
		if got := ask("get", host); got != "" {
			t.Fatalf("host %q got %q", host, got)
		}
	}
	if got := ask("store", "git.example.com:8443"); got != "" {
		t.Fatalf("store: %q", got)
	}

	g, err := newGit(ExecRunner{}, &bytes.Buffer{}, &agentv1.GitSource{Url: "https://git.example.com:8443/a/b.git", Token: "tok-123"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join(g.args, " ")
	if !strings.Contains(args, "credential.https://git.example.com:8443.helper=!f()") || strings.Contains(args, "credential.helper=!") ||
		!strings.Contains(args, "protocol.http.allow=never") || !slices.Contains(g.env, "BUILD_GIT_HOST=git.example.com:8443") {
		t.Fatalf("args %q env %q", args, g.env)
	}
}

// TestGitTokenNeedsHTTPS: a token or key never travels over plain http.
func TestGitTokenNeedsHTTPS(t *testing.T) {
	if err := validateGit(&agentv1.GitSource{Url: "http://git.example.com/a.git", Token: "t"}); err == nil {
		t.Fatal("http:// with a token was accepted")
	}
	if err := validateGit(&agentv1.GitSource{Url: "http://git.example.com/a.git"}); err != nil {
		t.Fatalf("http:// without credentials: %v", err)
	}
	if err := validateGit(&agentv1.GitSource{Url: "https://git.example.com/a.git", Token: "t"}); err != nil {
		t.Fatalf("https:// with a token: %v", err)
	}
}
