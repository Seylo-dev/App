package build

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// gitServer serves bare repositories over smart HTTPS (git http-backend),
// requiring the token when one is set. No network beyond httptest. The
// returned runner makes git trust the test server's certificate.
func gitServer(t *testing.T, token string) (url string, repo string, runner Runner) {
	t.Helper()
	return gitServerFor(t, defaultGitUser, token)
}

// gitServerFor is gitServer for a host that wants a given HTTPS user name
// with the token (Bitbucket: "x-token-auth" or the account).
func gitServerFor(t *testing.T, user, token string) (url string, repo string, runner Runner) {
	t.Helper()
	url, repo, runner, _ = gitServerHits(t, user, token, nil)
	return url, repo, runner
}

// testCert is one self-signed certificate for localhost, 127.0.0.1 and ::1
// that every test server shares, so one CA file trusts them all.
var testCert = sync.OnceValues(func() (tls.Certificate, []byte) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "seylo build test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		DNSNames:              []string{"localhost", "example.com"},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		panic(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
})

// testTLSServer is an httptest TLS server with testCert, and the runner
// that makes git trust it.
func testTLSServer(t *testing.T, h http.Handler) (*httptest.Server, Runner) {
	t.Helper()
	cert, caPEM := testCert()
	srv := httptest.NewUnstartedServer(h)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, caPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	return srv, caRunner{ca: ca}
}

// gitServerHits is gitServerFor that counts the requests it gets; wrap
// (may be nil) sees every request first and may answer it itself.
func gitServerHits(t *testing.T, user, token string, wrap func(w http.ResponseWriter, r *http.Request) bool) (url string, repo string, runner Runner, hits *atomic.Int32) {
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
	hits = &atomic.Int32{}
	srv, runner := testTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if wrap != nil && wrap(w, r) {
			return
		}
		if token != "" {
			name, pass, ok := r.BasicAuth()
			if !ok || name != user || pass != token {
				w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
				http.Error(w, "auth", http.StatusUnauthorized)
				return
			}
		}
		backend.ServeHTTP(w, r)
	}))
	return srv.URL + "/repo.git", work, runner, hits
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
			src := &agentv1.GitSource{Url: url, Ref: c.ref, Commit: c.commit, Token: "s3cret-token", AllowInternalHost: true}
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

// A provider that wants another user name (Bitbucket) gets the one the
// panel sends; without one the clone sends x-access-token and is refused.
func TestFetchGitWithUsername(t *testing.T) {
	url, _, run := gitServerFor(t, "x-token-auth", "bb-token")
	for _, c := range []struct {
		name, user string
		ok         bool
	}{
		{"named user", "x-token-auth", true},
		{"default user", "", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			work := t.TempDir()
			var log bytes.Buffer
			src := &agentv1.GitSource{Url: url, Ref: "main", Token: "bb-token", Username: c.user, AllowInternalHost: true}
			if err := validateGit(src); err != nil {
				t.Fatal(err)
			}
			_, err := fetchGit(context.Background(), run, &log, src, filepath.Join(work, "src"), work, false)
			if c.ok && err != nil {
				t.Fatalf("%v\n%s", err, log.String())
			}
			if !c.ok && !errors.Is(err, ErrFetch) {
				t.Fatalf("got %v, want ErrFetch", err)
			}
		})
	}
}

func TestGitUsernameIsValidated(t *testing.T) {
	for _, bad := range []string{"two words", "line\nbreak", "x=y\npassword=z", strings.Repeat("a", 101)} {
		src := &agentv1.GitSource{Url: "https://git.example.com/a/b.git", Token: "t", Username: bad}
		if err := validateGit(src); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
	for _, good := range []string{"x-token-auth", "oauth2", "jane.doe", "dev+ci@example.com"} {
		src := &agentv1.GitSource{Url: "https://git.example.com/a/b.git", Token: "t", Username: good}
		if err := validateGit(src); err != nil {
			t.Errorf("%q: %v", good, err)
		}
	}
}

func TestFetchGitWrongToken(t *testing.T) {
	url, _, run := gitServer(t, "right")
	work := t.TempDir()
	var log bytes.Buffer
	_, err := fetchGit(context.Background(), run, &log, &agentv1.GitSource{Url: url, Ref: "main", Token: "wrong", AllowInternalHost: true}, filepath.Join(work, "src"), work, false)
	if !errors.Is(err, ErrFetch) || errors.Is(err, ErrBlockedHost) {
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
	defer g.close()
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
	g2, err := newGit(ExecRunner{}, &bytes.Buffer{}, &agentv1.GitSource{Url: "git@git.example.com:a.git", SshPrivateKey: "k", SshKnownHosts: "git.example.com ssh-ed25519 AAAA"}, custom)
	if err != nil {
		t.Fatal(err)
	}
	g2.close()
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
	defer g.close()
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
	if err := validateGit(&agentv1.GitSource{Url: "http://git.example.com/a.git"}); err == nil {
		t.Fatal("http:// without the admin opt-in was accepted")
	}
	if err := validateGit(&agentv1.GitSource{Url: "http://git.example.com/a.git", AllowPlainHttp: true}); err != nil {
		t.Fatalf("http:// with the admin opt-in: %v", err)
	}
	if err := validateGit(&agentv1.GitSource{Url: "http://git.example.com/a.git", Token: "t", AllowPlainHttp: true}); err == nil {
		t.Fatal("http:// with a token and the opt-in was accepted")
	}
	if err := validateGit(&agentv1.GitSource{Url: "https://git.example.com/a.git", Token: "t"}); err != nil {
		t.Fatalf("https:// with a token: %v", err)
	}
}
