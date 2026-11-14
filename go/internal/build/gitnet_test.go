package build

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Real git stderr (and the fetch proxy's errors) for each kind of failure,
// with the host each names, the line the message shows and whether a
// wrong address gives it as well (maybeAddress: a name that does not
// exist, a refused connection). "(here)" are
// from runs of TestGitNetworkFailures and of git: git 2.50.1 on macOS
// (curl 8) and git in the test VM (curl with GnuTLS); the others are
// curl's and ssh's wording on other releases, as their error reports
// show it.
var gitStderrSamples = []struct {
	name, text   string
	kind         GitNetworkKind
	maybeAddress bool
	target, line string
}{
	// Connection refused or timed out.
	{name: "curl 8 refused (here)", kind: GitConnect, maybeAddress: true, target: "127.0.0.1:9",
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
	{name: "curl timed out, its own words", kind: GitConnect, target: "github.com:443",
		text: "fatal: unable to access 'https://github.com/acme/api.git/': Timeout was reached\n",
		line: "fatal: unable to access 'https://github.com/acme/api.git/': Timeout was reached"},
	{name: "ssh timed out", kind: GitConnect, target: "git.example.com:22",
		text: "ssh: connect to host git.example.com port 22: Connection timed out\nfatal: Could not read from remote repository.\n",
		line: "ssh: connect to host git.example.com port 22: Connection timed out"},
	{name: "ssh no route", kind: GitConnect, target: "git.example.com:22",
		text: "ssh: connect to host git.example.com port 22: No route to host\nfatal: Could not read from remote repository.\n",
		line: "ssh: connect to host git.example.com port 22: No route to host"},
	{name: "ssh refused", kind: GitConnect, maybeAddress: true, target: "github.com:22",
		text: "ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
		line: "ssh: connect to host github.com port 22: Connection refused"},
	{name: "ssh through git-dial and the fetch proxy (here)", kind: GitConnect, target: "github.com:443",
		text: "the git server could not be reached\ngit-dial: 502 Bad Gateway\nConnection closed by UNKNOWN port 65535\nfatal: Could not read from remote repository.\n\n" +
			"Please make sure you have the correct access rights\nand the repository exists.\n",
		line: "the git server could not be reached"},
	{name: "the fetch proxy timed out", kind: GitConnect, target: "140.82.121.4:443",
		text: "dial tcp 140.82.121.4:443: i/o timeout", line: "dial tcp 140.82.121.4:443: i/o timeout"},
	{name: "the fetch proxy refused (here)", kind: GitConnect, maybeAddress: true, target: "127.0.0.1:9",
		text: "dial tcp 127.0.0.1:9: connect: connection refused", line: "dial tcp 127.0.0.1:9: connect: connection refused"},
	{name: "no route", kind: GitConnect, target: "192.0.2.10:443",
		text: "dial tcp 192.0.2.10:443: connect: no route to host", line: "dial tcp 192.0.2.10:443: connect: no route to host"},

	// DNS.
	{name: "curl could not resolve", kind: GitDNS, maybeAddress: true, target: "github.com",
		text: "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve host: github.com\n",
		line: "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve host: github.com"},
	{name: "curl could not resolve the proxy", kind: GitDNS, target: "proxy.example",
		text: "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve proxy: proxy.example\n",
		line: "fatal: unable to access 'https://github.com/acme/api.git/': Could not resolve proxy: proxy.example"},
	{name: "ssh could not resolve", kind: GitDNS, target: "gitlab.com",
		text: "ssh: Could not resolve hostname gitlab.com: Temporary failure in name resolution\nfatal: Could not read from remote repository.\n",
		line: "ssh: Could not resolve hostname gitlab.com: Temporary failure in name resolution"},
	{name: "the fetch proxy's lookup (here)", kind: GitDNS, maybeAddress: true, target: "nonexistent.invalid",
		text: "dial tcp: lookup nonexistent.invalid: no such host", line: "dial tcp: lookup nonexistent.invalid: no such host"},
	{name: "the fetch proxy's lookup on Linux (here)", kind: GitDNS, maybeAddress: true, target: "nonexistent.invalid",
		text: "dial tcp: lookup nonexistent.invalid on 1.1.1.1:53: no such host", line: "dial tcp: lookup nonexistent.invalid on 1.1.1.1:53: no such host"},
	{name: "the fetch proxy's lookup through systemd-resolved", kind: GitDNS, target: "github.com",
		text: "dial tcp: lookup github.com on 127.0.0.53:53: server misbehaving", line: "dial tcp: lookup github.com on 127.0.0.53:53: server misbehaving"},
	{name: "the fetch proxy's lookup timed out", kind: GitDNS, target: "github.com",
		text: "dial tcp: lookup github.com on 192.0.2.53:53: read udp 172.17.0.2:41234->192.0.2.53:53: i/o timeout",
		line: "dial tcp: lookup github.com on 192.0.2.53:53: read udp 172.17.0.2:41234->192.0.2.53:53: i/o timeout"},
	// A mistyped host: what ssh says on Linux (getaddrinfo's EAI_NONAME)
	// and on macOS.
	{name: "ssh: no such name", kind: GitDNS, maybeAddress: true, target: "gihub.com",
		text: "ssh: Could not resolve hostname gihub.com: Name or service not known\r\nfatal: Could not read from remote repository.\n",
		line: "ssh: Could not resolve hostname gihub.com: Name or service not known"},
	{name: "ssh on macOS: no such name", kind: GitDNS, maybeAddress: true, target: "gihub.com",
		text: "ssh: Could not resolve hostname gihub.com: nodename nor servname provided, or not known\r\nfatal: Could not read from remote repository.\n",
		line: "ssh: Could not resolve hostname gihub.com: nodename nor servname provided, or not known"},
	// The agent's own proxy is the node's setting, whatever its error.
	{name: "the agent's proxy does not resolve", kind: GitDNS, target: "proxy.example",
		text: "connecting to the agent's proxy proxy.example:3128: dial tcp: lookup proxy.example: no such host",
		line: "connecting to the agent's proxy proxy.example:3128: dial tcp: lookup proxy.example: no such host"},
	{name: "the agent's proxy refuses", kind: GitProxy, target: "github.com:443",
		text: "connecting to the agent's proxy 192.0.2.5:3128: dial tcp 192.0.2.5:3128: connect: connection refused",
		line: "connecting to the agent's proxy 192.0.2.5:3128: dial tcp 192.0.2.5:3128: connect: connection refused"},

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
	{name: "an address with credentials", kind: GitDNS, maybeAddress: true, target: "git.example",
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

// A connection the fetch's proxy could not make is read by its type too:
// a name that does not exist (NXDOMAIN) and a refused port ask for the
// address; a DNS server that timed out or failed, a timeout, no route, a
// TLS failure and anything about the agent's own HTTP proxy (reaching it,
// its answer, its name, its setting) are the node's. The target is the
// host git asked for, or the name that did not resolve.
func TestClassifyDialError(t *testing.T) {
	dial := func(errno syscall.Errno) error {
		return &net.OpError{Op: "dial", Net: "tcp", Err: &os.SyscallError{Syscall: "connect", Err: errno}}
	}
	for _, c := range []struct {
		name         string
		err          error
		kind         GitNetworkKind
		maybeAddress bool
		target       string
	}{
		{"no such host", &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: "githb.example", IsNotFound: true}}, GitDNS, true, "githb.example"},
		{"connection refused", dial(syscall.ECONNREFUSED), GitConnect, true, "githb.example:443"},
		{"network unreachable", dial(syscall.ENETUNREACH), GitConnect, false, "githb.example:443"},
		{"host unreachable", dial(syscall.EHOSTUNREACH), GitConnect, false, "githb.example:443"},
		{"DNS timeout", &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "i/o timeout", Name: "githb.example", Server: "192.0.2.53:53", IsTimeout: true}}, GitDNS, false, "githb.example"},
		{"SERVFAIL", &net.DNSError{Err: "server misbehaving", Name: "githb.example", Server: "192.0.2.53:53", IsTemporary: true}, GitDNS, false, "githb.example"},
		{"dial timeout", &net.OpError{Op: "dial", Net: "tcp", Err: os.ErrDeadlineExceeded}, GitConnect, false, "githb.example:443"},
		{"context deadline", fmt.Errorf("dial: %w", context.DeadlineExceeded), GitConnect, false, "githb.example:443"},
		{"the agent's proxy refused", &agentProxyError{fmt.Errorf("connecting to the agent's proxy 192.0.2.8:3128: %w", dial(syscall.ECONNREFUSED))}, GitProxy, false, "githb.example:443"},
		{"the agent's proxy answered", &agentProxyError{errors.New("the proxy answered 502 Bad Gateway")}, GitProxy, false, "githb.example:443"},
		{"the agent's proxy's name", &agentProxyError{fmt.Errorf("connecting to the agent's proxy proxy.example:3128: %w",
			&net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: "proxy.example", IsNotFound: true}})}, GitDNS, false, "proxy.example"},
		{"the agent's proxy setting", &agentProxyError{errors.New("the agent's proxy socks5://127.0.0.1:1080: git goes only through http:// or https:// proxies")}, GitProxy, false, "githb.example:443"},
		{"TLS", errors.New("tls: handshake failure"), GitTLS, false, "githb.example:443"},
	} {
		got := classifyDialError("githb.example:443", c.err)
		if got.Kind != c.kind || got.MaybeAddress != c.maybeAddress || got.Target != c.target || got.Line != c.err.Error() {
			t.Errorf("%s (%v): got %v %v %q %q, want %v %v %q", c.name, c.err, got.Kind, got.MaybeAddress, got.Target, got.Line, c.kind, c.maybeAddress, c.target)
		}
	}
}

// What the fetch's proxy recorded comes before git's own words (git only
// saw a 502), and a failure it did not record is read from git's stderr.
func TestNetworkErrPrefersTheProxysDial(t *testing.T) {
	p := &gitProxy{policy: gitPolicy{source: gitTarget{host: "githb.example", port: "443"}}, ctx: context.Background(), log: &bytes.Buffer{}}
	g := &git{proxy: p, lastStderr: "fatal: unable to access 'https://githb.example/a.git/': CONNECT tunnel failed, response 502\n"}
	if got := g.networkErr(errors.New("git exited with code 128")); got == nil || got.Kind != GitProxy {
		t.Fatalf("git's words alone: %+v", got)
	}
	p.connFailed(context.Background(), "githb.example:443", &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: "githb.example", IsNotFound: true}}, true)
	// Only the first failure counts.
	p.connFailed(context.Background(), "other.example:443", &net.OpError{Op: "dial", Net: "tcp", Err: os.ErrDeadlineExceeded}, true)
	got := g.networkErr(errors.New("git exited with code 128"))
	if got == nil || got.Kind != GitDNS || !got.MaybeAddress || got.Target != "githb.example" || got.Exit != "git exited with code 128" {
		t.Fatalf("the proxy's dial: %+v", got)
	}
	// A request git gave up on, or one the fetch's end cut, is not one.
	q := &gitProxy{ctx: context.Background(), log: &bytes.Buffer{}}
	gaveUp, cancel := context.WithCancel(context.Background())
	cancel()
	q.connFailed(gaveUp, "githb.example:443", errors.New("dial tcp 192.0.2.10:443: i/o timeout"), true)
	q.connFailed(context.Background(), "githb.example:443", fmt.Errorf("dial: %w", context.Canceled), true)
	if target, err := q.ConnFailed(); err != nil {
		t.Fatalf("recorded %s: %v", target, err)
	}
}

func TestClassifyGitNetwork(t *testing.T) {
	for _, tc := range gitStderrSamples {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyGitNetwork(tc.text, "github.com:443")
			if got == nil {
				t.Fatalf("not a network failure: %q", tc.text)
			}
			if got.Kind != tc.kind || got.MaybeAddress != tc.maybeAddress || got.Target != tc.target || got.Line != tc.line {
				t.Fatalf("got %v %v %q %q\nwant %v %v %q %q", got.Kind, got.MaybeAddress, got.Target, got.Line, tc.kind, tc.maybeAddress, tc.target, tc.line)
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
// never the address, the branch or the credentials as the thing to check,
// unless a wrong address gives the same failure (a name that does not
// exist, a refused connection): then the address first, then the Health
// check, and never "not the address".
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

	typo := error(&GitNetworkError{Kind: GitDNS, MaybeAddress: true, Target: "gihub.com", Line: "dial tcp: lookup gihub.com: no such host", Exit: "git exited with code 128"})
	NameNode(typo, "de-fsn-1")
	want = "fetching the source failed: node de-fsn-1 could not resolve gihub.com - check the address: dial tcp: lookup gihub.com: no such host (git exited with code 128). " +
		"If the address is right, the node's Health check (its Health tab, or `seylo health` on the node) tests its DNS and connections"
	if typo.Error() != want || !errors.Is(typo, ErrFetch) {
		t.Fatalf("a name that does not exist\n got: %s\nwant: %s", typo, want)
	}
	refused := (&GitNetworkError{Kind: GitConnect, MaybeAddress: true, Target: "git.example:8443", Line: "dial tcp 192.0.2.10:8443: connect: connection refused"}).Error()
	want = "fetching the source failed: this node could not connect to git.example:8443 - check the address: dial tcp 192.0.2.10:8443: connect: connection refused. " +
		"If the address is right, the node's Health check (its Health tab, or `seylo health` on the node) tests its DNS and connections"
	if refused != want {
		t.Fatalf("a refused connection\n got: %s\nwant: %s", refused, want)
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
// git's. A refused connection and a name that does not exist (what a
// wrong port or a mistyped host give) ask to check the address first; the
// agent's proxy's error and an untrusted certificate say it is not the
// address. A wrong token and a missing branch keep today's message.
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
	// maybeAddress: a failure a wrong address gives as well, whose message
	// asks to check the address first; the others say it is not the
	// address. Both name the Health check.
	asNetwork := func(t *testing.T, err error, kind GitNetworkKind, maybeAddress bool, target, line string) {
		t.Helper()
		var ne *GitNetworkError
		if !errors.As(err, &ne) || !errors.Is(err, ErrFetch) {
			t.Fatalf("not a network failure: %v", err)
		}
		if ne.Kind != kind || ne.MaybeAddress != maybeAddress || ne.Target != target || !strings.Contains(ne.Line, line) {
			t.Fatalf("got %v %v %q %q, want %v %v %q %q", ne.Kind, ne.MaybeAddress, ne.Target, ne.Line, kind, maybeAddress, target, line)
		}
		msg := err.Error()
		if strings.Contains(msg, "the branch and the credentials") || !strings.Contains(msg, "Health check") ||
			strings.Contains(msg, " - check the address: ") != maybeAddress || strings.Contains(msg, "not the address") == maybeAddress {
			t.Fatalf("message: %s", err)
		}
	}

	t.Run("connection refused", func(t *testing.T) {
		port := closedPort(t)
		log, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "https://127.0.0.1:" + port + "/acme/api.git", Ref: "main", AllowInternalHost: true})
		asNetwork(t, err, GitConnect, true, "127.0.0.1:"+port, "dial tcp 127.0.0.1:"+port+": connect: connection refused")
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
			" - check the address: dial tcp 127.0.0.1:"+port+": connect: connection refused (") ||
			!strings.HasSuffix(err.Error(), "). If the address is right, the node's Health check (its Health tab, or `seylo health` on the node) tests its DNS and connections") {
			t.Fatalf("FetchFile: %v", err)
		}
	})

	t.Run("a name that does not resolve", func(t *testing.T) {
		if addrs, err := net.DefaultResolver.LookupHost(context.Background(), "nonexistent.invalid"); err == nil {
			t.Skipf("this machine's DNS answers for .invalid: %v", addrs)
		}
		_, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "https://nonexistent.invalid/acme/api.git", Ref: "main"})
		asNetwork(t, err, GitDNS, true, "nonexistent.invalid", "lookup nonexistent.invalid")
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
		asNetwork(t, err, GitConnect, true, "127.0.0.1:"+port, "dial tcp 127.0.0.1:"+port+": connect: connection refused")
		if !strings.Contains(log, "the git server could not be reached") {
			t.Fatalf("git-dial's line is not in the log:\n%s", log)
		}
	})

	t.Run("the agent's proxy answers 502", func(t *testing.T) {
		nodeDNS(t, map[string]string{"git.proxied.test": "93.184.216.34"})
		up := startFakeUpstream(t, map[string]string{"git.proxied.test:443": "127.0.0.1:" + closedPort(t)}, false)
		setProxyEnv(t, "http://"+up.addr, "", "")
		_, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "https://git.proxied.test/acme/api.git", Ref: "main"})
		asNetwork(t, err, GitProxy, false, "git.proxied.test:443", "through the agent's proxy http://"+up.addr+": the proxy answered 502 Bad Gateway")
	})

	// The agent's own HTTP proxy that cannot be reached is the node's
	// side, whatever the address.
	t.Run("the agent's proxy is down", func(t *testing.T) {
		nodeDNS(t, map[string]string{"git.proxied.test": "93.184.216.34"})
		proxyAddr := "127.0.0.1:" + closedPort(t)
		setProxyEnv(t, "http://"+proxyAddr, "", "")
		_, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "https://git.proxied.test/acme/api.git", Ref: "main"})
		asNetwork(t, err, GitProxy, false, "git.proxied.test:443", "connecting to the agent's proxy "+proxyAddr+": ")
	})

	// A proxy name that does not resolve is the node's setting: the
	// message names the proxy, not the git server.
	t.Run("the agent's proxy's name does not resolve", func(t *testing.T) {
		if addrs, err := net.DefaultResolver.LookupHost(context.Background(), "proxy.invalid"); err == nil {
			t.Skipf("this machine's DNS answers for .invalid: %v", addrs)
		}
		nodeDNS(t, map[string]string{"git.proxied.test": "93.184.216.34"})
		setProxyEnv(t, "http://proxy.invalid:3128", "", "")
		_, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "https://git.proxied.test/acme/api.git", Ref: "main"})
		asNetwork(t, err, GitDNS, false, "proxy.invalid", "connecting to the agent's proxy proxy.invalid:3128: ")
	})

	// Plain http whose proxy setting git cannot use: the fetch's proxy
	// answered git's request itself, so only it knows why.
	t.Run("plain http through a proxy git cannot use", func(t *testing.T) {
		url, _ := plainGitServer(t)
		port := portOf(t, url)
		nodeDNS(t, map[string]string{"git.plain.test": "93.184.216.34"})
		setProxyEnv(t, "", "socks5://127.0.0.1:1080", "")
		_, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: "http://git.plain.test:" + port + "/internal.git", Ref: "main", AllowPlainHttp: true})
		asNetwork(t, err, GitProxy, false, "git.plain.test:"+port, "git goes only through http:// or https:// proxies")
	})

	t.Run("a certificate the node does not trust", func(t *testing.T) {
		srv, _ := testTLSServer(t, http.NotFoundHandler())
		_, err := fetch(t, ExecRunner{}, &agentv1.GitSource{Url: srv.URL + "/repo.git", Ref: "main", AllowInternalHost: true})
		var ne *GitNetworkError
		if !errors.As(err, &ne) {
			t.Fatalf("not a network failure: %v", err)
		}
		asNetwork(t, err, GitTLS, false, strings.TrimPrefix(srv.URL, "https://"), "unable to access '"+srv.URL+"/repo.git/': ")
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
