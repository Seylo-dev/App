package build

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Real git stderr (and the fetch proxy's errors) for each kind of failure,
// with the host each names and the line the message shows. "(here)" are
// from runs of TestGitNetworkFailures and of git: git 2.50.1 on macOS
// (curl 8) and git in the test VM (curl with GnuTLS); the others are
// curl's and ssh's wording on other releases, as their error reports
// show it.
var gitStderrSamples = []struct {
	name, text   string
	kind         GitNetworkKind
	target, line string
}{
	// Connection refused or timed out.
	{name: "curl 8 refused (here)", kind: GitConnect, target: "127.0.0.1:9",
		text: "fatal: unable to access 'https://127.0.0.1:9/acme/api.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server\n",
		line: "fatal: unable to access 'https://127.0.0.1:9/acme/api.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server"},
	{name: "curl 7 timed out", kind: GitConnect, target: "github.com:443",
		text: "fatal: unable to access 'https://github.com/acme/api.git/': Failed to connect to github.com port 443 after 133967 ms: Connection timed out\n",
		line: "fatal: unable to access 'https://github.com/acme/api.git/': Failed to connect to github.com port 443 after 133967 ms: Connection timed out"},
	{name: "curl timed out during the transfer", kind: GitConnect, target: "github.com:443",
		text: "error: RPC failed; curl 28 Operation timed out after 300000 milliseconds with 0 out of 0 bytes received\nfatal: expected flush after ref listing\n",
		line: "error: RPC failed; curl 28 Operation timed out after 300000 milliseconds with 0 out of 0 bytes received"},
	{name: "connection reset", kind: GitConnect, target: "github.com:443",
		text: "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: early EOF\n",
		line: "error: RPC failed; curl 56 Recv failure: Connection reset by peer"},
	{name: "ssh refused", kind: GitConnect, target: "github.com:22",
		text: "ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
		line: "ssh: connect to host github.com port 22: Connection refused"},
	{name: "ssh through git-dial and the fetch proxy (here)", kind: GitConnect, target: "github.com:443",
		text: "the git server could not be reached\ngit-dial: 502 Bad Gateway\nConnection closed by UNKNOWN port 65535\nfatal: Could not read from remote repository.\n\n" +
			"Please make sure you have the correct access rights\nand the repository exists.\n",
		line: "the git server could not be reached"},
	{name: "the fetch proxy timed out", kind: GitConnect, target: "140.82.121.4:443",
		text: "dial tcp 140.82.121.4:443: i/o timeout", line: "dial tcp 140.82.121.4:443: i/o timeout"},
	{name: "the fetch proxy refused (here)", kind: GitConnect, target: "127.0.0.1:9",
		text: "dial tcp 127.0.0.1:9: connect: connection refused", line: "dial tcp 127.0.0.1:9: connect: connection refused"},
	{name: "no route", kind: GitConnect, target: "192.0.2.10:443",
		text: "dial tcp 192.0.2.10:443: connect: no route to host", line: "dial tcp 192.0.2.10:443: connect: no route to host"},

	// DNS.
	{name: "curl could not resolve", kind: GitDNS, target: "github.com",
		text: "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve host: github.com\n",
		line: "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve host: github.com"},
	{name: "curl could not resolve the proxy", kind: GitDNS, target: "proxy.example",
		text: "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve proxy: proxy.example\n",
		line: "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve proxy: proxy.example"},
	{name: "ssh could not resolve", kind: GitDNS, target: "gitlab.com",
		text: "ssh: Could not resolve hostname gitlab.com: Temporary failure in name resolution\nfatal: Could not read from remote repository.\n",
		line: "ssh: Could not resolve hostname gitlab.com: Temporary failure in name resolution"},
	{name: "the fetch proxy's lookup (here)", kind: GitDNS, target: "nonexistent.invalid",
		text: "dial tcp: lookup nonexistent.invalid: no such host", line: "dial tcp: lookup nonexistent.invalid: no such host"},
	{name: "the fetch proxy's lookup on Linux (here)", kind: GitDNS, target: "nonexistent.invalid",
		text: "dial tcp: lookup nonexistent.invalid on 1.1.1.1:53: no such host", line: "dial tcp: lookup nonexistent.invalid on 1.1.1.1:53: no such host"},
	{name: "the fetch proxy's lookup through systemd-resolved", kind: GitDNS, target: "github.com",
		text: "dial tcp: lookup github.com on 127.0.0.53:53: server misbehaving", line: "dial tcp: lookup github.com on 127.0.0.53:53: server misbehaving"},

	// Proxies.
	{name: "curl 8 CONNECT 502 (the incident)", kind: GitProxy, target: "github.com:443",
		text: "fatal: unable to access 'https://github.com/acme/api.git/': CONNECT tunnel failed, response 502\n",
		line: "fatal: unable to access 'https://github.com/acme/api.git/': CONNECT tunnel failed, response 502"},
	{name: "curl 7 CONNECT 503", kind: GitProxy, target: "gitlab.example:8443",
		text: "fatal: unable to access 'https://gitlab.example:8443/acme/api.git/': Received HTTP code 503 from proxy after CONNECT\n",
		line: "fatal: unable to access 'https://gitlab.example:8443/acme/api.git/': Received HTTP code 503 from proxy after CONNECT"},
	{name: "the agent's proxy answered 502 (here)", kind: GitProxy, target: "git.proxied.test:443",
		text: "the tunnel to git.proxied.test:443 through the agent's proxy http://127.0.0.1:3128: the proxy answered 502 Bad Gateway",
		line: "the tunnel to git.proxied.test:443 through the agent's proxy http://127.0.0.1:3128: the proxy answered 502 Bad Gateway"},

	// TLS.
	{name: "curl Secure Transport/OpenSSL self-signed (here)", kind: GitTLS, target: "127.0.0.1:443",
		text: "fatal: unable to access 'https://127.0.0.1/repo.git/': SSL certificate problem: self signed certificate\n",
		line: "fatal: unable to access 'https://127.0.0.1/repo.git/': SSL certificate problem: self signed certificate"},
	{name: "curl GnuTLS untrusted (here)", kind: GitTLS, target: "127.0.0.1:41633",
		text: "fatal: unable to access 'https://127.0.0.1:41633/repo.git/': server certificate verification failed. CAfile: none CRLfile: none\n",
		line: "fatal: unable to access 'https://127.0.0.1:41633/repo.git/': server certificate verification failed. CAfile: none CRLfile: none"},
	{name: "curl GnuTLS untrusted, system CAs", kind: GitTLS, target: "git.example:443",
		text: "fatal: unable to access 'https://git.example/acme/api.git/': server certificate verification failed. CAfile: /etc/ssl/certs/ca-certificates.crt CRLfile: none\n",
		line: "fatal: unable to access 'https://git.example/acme/api.git/': server certificate verification failed. CAfile: /etc/ssl/certs/ca-certificates.crt CRLfile: none"},
	{name: "curl GnuTLS handshake", kind: GitTLS, target: "github.com:443",
		text: "fatal: unable to access 'https://github.com/acme/api.git/': gnutls_handshake() failed: The TLS connection was non-properly terminated.\n",
		line: "fatal: unable to access 'https://github.com/acme/api.git/': gnutls_handshake() failed: The TLS connection was non-properly terminated."},
	{name: "curl OpenSSL syscall", kind: GitTLS, target: "github.com:443",
		text: "fatal: unable to access 'https://github.com/acme/api.git/': OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443 \n",
		line: "fatal: unable to access 'https://github.com/acme/api.git/': OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443"},

	// Credentials in an address never reach the message.
	{name: "an address with credentials", kind: GitDNS, target: "git.example",
		text: "fatal: unable to access 'https://deploy:s3cret@git.example/acme/api.git/': Could not resolve host: git.example\n",
		line: "fatal: unable to access 'https://***@git.example/acme/api.git/': Could not resolve host: git.example"},
}

// Failures that are the address, the branch or the credentials keep
// today's message.
var gitStderrNotNetwork = []string{
	"fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
	"remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/api.git/'\n",
	"remote: Repository not found.\nfatal: repository 'https://github.com/acme/nope.git/' not found\n",
	"fatal: couldn't find remote ref mian\n",
	"git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
	"Host key verification failed.\r\nfatal: Could not read from remote repository.\n",
	"error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403\nfatal: unable to access 'https://github.com/acme/api.git/': The requested URL returned error: 403\n",
	"fatal: unable to access 'https://github.com/acme/api.git/': The requested URL returned error: 401\n",
	"",
}

func TestClassifyGitNetwork(t *testing.T) {
	for _, tc := range gitStderrSamples {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyGitNetwork(tc.text, "github.com:443")
			if got == nil {
				t.Fatalf("not a network failure: %q", tc.text)
			}
			if got.Kind != tc.kind || got.Target != tc.target || got.Line != tc.line {
				t.Fatalf("got %v %q %q\nwant %v %q %q", got.Kind, got.Target, got.Line, tc.kind, tc.target, tc.line)
			}
		})
	}
	for _, text := range gitStderrNotNetwork {
		if got := classifyGitNetwork(text, "github.com:443"); got != nil {
			t.Errorf("%q read as a network failure: %+v", text, got)
		}
	}
}

// The message: the node, the host, the first error line, the Health check;
// never the address, the branch or the credentials as the thing to check.
func TestGitNetworkErrorMessage(t *testing.T) {
	err := error(&GitNetworkError{Kind: GitConnect, Target: "github.com:443", Line: "dial tcp 140.82.121.4:443: i/o timeout", Exit: "git exited with code 128"})
	NameNode(err, "de-fsn-1")
	want := "fetching the source failed: node de-fsn-1 could not connect to github.com:443 - a network problem on the node, not the address, the branch or the credentials: " +
		"dial tcp 140.82.121.4:443: i/o timeout (git exited with code 128). The node's Health check (its Health tab, or `seylo health` on the node) tests its DNS and connections"
	if err.Error() != want {
		t.Fatalf("message\n got: %s\nwant: %s", err, want)
	}
	if !errors.Is(err, ErrFetch) || failureMessage(err) != want {
		t.Fatalf("not a fetch failure: %v / %q", errors.Is(err, ErrFetch), failureMessage(err))
	}
	for kind, what := range map[GitNetworkKind]string{
		GitDNS:   "this node could not resolve github.com - a network problem on the node, not",
		GitProxy: "this node could not get through a proxy to github.com - a network problem on the node, not",
		GitTLS:   "this node could not open a TLS connection to github.com - a network problem on the node (or a certificate it does not trust), not",
	} {
		if msg := (&GitNetworkError{Kind: kind, Target: "github.com", Line: "x"}).Error(); !strings.Contains(msg, what) || strings.Contains(msg, "check the address") {
			t.Errorf("%v: %s", kind, msg)
		}
	}
}

// closedPort is a local port nothing listens on.
func closedPort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	_ = ln.Close()
	return port
}

// Real git through the fetch's proxy, one failure of each kind that a
// test can make without the internet: each names the host, the first
// error and the node, and the build log has the proxy's line before
// git's. A wrong token and a missing branch keep today's message.
func TestGitNetworkFailures(t *testing.T) {
	setProxyEnv(t, "", "", "")
	fetch := func(t *testing.T, run Runner, src *agentv1.GitSource) (string, error) {
		t.Helper()
		work := t.TempDir()
		var log bytes.Buffer
		_, err := fetchGit(context.Background(), run, &log, src, filepath.Join(work, "src"), work, false)
		t.Logf("%v\n%s", err, log.String())
		return log.String(), err
	}
	asNetwork := func(t *testing.T, err error, kind GitNetworkKind, target, line string) {
		t.Helper()
		var ne *GitNetworkError
		if !errors.As(err, &ne) || !errors.Is(err, ErrFetch) {
			t.Fatalf("not a network failure: %v", err)
		}
		if ne.Kind != kind || ne.Target != target || !strings.Contains(ne.Line, line) {
			t.Fatalf("got %v %q %q, want %v %q %q", ne.Kind, ne.Target, ne.Line, kind, target, line)
		}
		if strings.Contains(err.Error(), "check the address") || !strings.Contains(err.Error(), "Health check") {
			t.Fatalf("message: %s", err)
		}
	}

	t.Run("connection refused", func(t *testing.T) {
		port := closedPort(t)
		log, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "https://127.0.0.1:" + port + "/acme/api.git", Ref: "main", AllowInternalHost: true})
		asNetwork(t, err, GitConnect, "127.0.0.1:"+port, "dial tcp 127.0.0.1:"+port+": connect: connection refused")
		// git itself only saw the proxy's 502; the log has why, first.
		proxyLine := strings.Index(log, "The git connection to 127.0.0.1:"+port+" failed: dial tcp")
		gitLine := strings.Index(log, "CONNECT tunnel failed, response 502")
		if proxyLine < 0 || gitLine < 0 || proxyLine > gitLine {
			t.Fatalf("the log has the proxy's line at %d and git's at %d", proxyLine, gitLine)
		}
		// The node's name, through the build service.
		s := New(Options{Dir: t.TempDir(), Runner: ExecRunner{}, NodeName: func() string { return "de-fsn-1" }})
		defer s.Close()
		_, err = s.FetchFile(context.Background(), &agentv1.FetchGitFileRequest{
			Source: &agentv1.GitSource{Url: "https://127.0.0.1:" + port + "/acme/api.git", Ref: "main", AllowInternalHost: true}, Path: "compose.yaml"})
		if !strings.HasPrefix(err.Error(), "fetching the source failed: node de-fsn-1 could not connect to 127.0.0.1:"+port+
			" - a network problem on the node, not the address, the branch or the credentials: dial tcp 127.0.0.1:"+port+": connect: connection refused (") {
			t.Fatalf("FetchFile: %v", err)
		}
	})

	t.Run("a name that does not resolve", func(t *testing.T) {
		if addrs, err := net.DefaultResolver.LookupHost(context.Background(), "nonexistent.invalid"); err == nil {
			t.Skipf("this machine's DNS answers for .invalid: %v", addrs)
		}
		_, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "https://nonexistent.invalid/acme/api.git", Ref: "main"})
		asNetwork(t, err, GitDNS, "nonexistent.invalid", "lookup nonexistent.invalid")
	})

	// ssh's ProxyCommand (git-dial, this test binary: TestMain) asks the
	// same proxy, which records the connection; git only says it could not
	// read from the remote repository.
	t.Run("ssh through git-dial, connection refused", func(t *testing.T) {
		if _, err := exec.LookPath("ssh"); err != nil {
			t.Skip("ssh is not installed")
		}
		port := closedPort(t)
		log, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "ssh://git@127.0.0.1:" + port + "/acme/api.git", Ref: "main", AllowInternalHost: true,
			SshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----", SshKnownHosts: "[127.0.0.1]:" + port + " ssh-ed25519 AAAA"})
		asNetwork(t, err, GitConnect, "127.0.0.1:"+port, "dial tcp 127.0.0.1:"+port+": connect: connection refused")
		if !strings.Contains(log, "the git server could not be reached") {
			t.Fatalf("git-dial's line is not in the log:\n%s", log)
		}
	})

	t.Run("the agent's proxy answers 502", func(t *testing.T) {
		nodeDNS(t, map[string]string{"git.proxied.test": "93.184.216.34"})
		up := startFakeUpstream(t, map[string]string{"git.proxied.test:443": "127.0.0.1:" + closedPort(t)}, false)
		setProxyEnv(t, "http://"+up.addr, "", "")
		_, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "https://git.proxied.test/acme/api.git", Ref: "main"})
		asNetwork(t, err, GitProxy, "git.proxied.test:443", "through the agent's proxy http://"+up.addr+": the proxy answered 502 Bad Gateway")
	})

	t.Run("a certificate the node does not trust", func(t *testing.T) {
		srv, _ := testTLSServer(t, http.NotFoundHandler())
		_, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: srv.URL + "/repo.git", Ref: "main", AllowInternalHost: true})
		var ne *GitNetworkError
		if !errors.As(err, &ne) {
			t.Fatalf("not a network failure: %v", err)
		}
		asNetwork(t, err, GitTLS, strings.TrimPrefix(srv.URL, "https://"), "unable to access '"+srv.URL+"/repo.git/': ")
	})

	t.Run("a wrong token and a missing branch keep today's message", func(t *testing.T) {
		private, _, run := gitServer(t, "right")
		public, _, _ := gitServer(t, "")
		for _, src := range []*agentv1.GitSource{
			{Url: private, Ref: "main", Token: "wrong", AllowInternalHost: true},
			{Url: public, Ref: "mian", AllowInternalHost: true},
		} {
			_, err := fetch(t, run, src)
			var ne *GitNetworkError
			if errors.As(err, &ne) || !errors.Is(err, ErrFetch) ||
				!strings.Contains(err.Error(), "could not fetch "+src.GetRef()+" - check the address, the branch and the credentials") {
				t.Fatalf("%s: %v", src.GetRef(), err)
			}
		}
	})
}
