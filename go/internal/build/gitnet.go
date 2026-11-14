package build

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
)

// A fetch that fails on the node's network is not the address, the
// branch or the credentials: a node whose provider's firewall dropped its
// new outbound connections told people to check their credentials, while
// the build log said "CONNECT tunnel failed, response 502" (the fetch's
// own proxy, which could not connect). Such failures get their own
// message (GitNetworkError): the node, the host it tried and the first
// error line, and the node's Health check, which tests its DNS and its
// connections. Everything else keeps ErrFetch's "check the address, the
// branch and the credentials".
//
// The first error is the fetch proxy's when it could not connect (it
// records that, gitProxy.connFailed: "dial tcp 192.0.2.10:443: i/o
// timeout", "dial tcp: lookup github.com ...: server misbehaving", the
// agent's own HTTP proxy answering 502), else the first line of git's
// stderr that names a network failure (curl's, ssh's, git-dial's).

// GitNetworkKind is what failed on the way to the git server.
type GitNetworkKind int

const (
	// GitConnect: the connection was refused, timed out, reset or had no
	// route.
	GitConnect GitNetworkKind = iota + 1
	// GitDNS: a name did not resolve.
	GitDNS
	// GitProxy: an HTTP proxy on the way answered with an error.
	GitProxy
	// GitTLS: the TLS handshake failed or the certificate was not trusted.
	GitTLS
)

func (k GitNetworkKind) String() string {
	switch k {
	case GitConnect:
		return "connect"
	case GitDNS:
		return "dns"
	case GitProxy:
		return "proxy"
	case GitTLS:
		return "tls"
	}
	return "unknown"
}

// GitNetworkError is a git fetch that failed on the node's network.
// errors.Is(err, ErrFetch) holds.
type GitNetworkError struct {
	Kind GitNetworkKind
	// Target is what the node tried: host:port, or the host for a name
	// that did not resolve.
	Target string
	// Line is the first error line.
	Line string
	// Node is the node's name in the panel; "" says "this node".
	Node string
	// Exit is how git ended ("git exited with code 128").
	Exit string
}

func (e *GitNetworkError) Error() string {
	node := "this node"
	if e.Node != "" {
		node = "node " + e.Node
	}
	var what string
	switch e.Kind {
	case GitDNS:
		what = "could not resolve " + e.Target
	case GitProxy:
		what = "could not get through a proxy to " + e.Target
	case GitTLS:
		what = "could not open a TLS connection to " + e.Target
	default:
		what = "could not connect to " + e.Target
	}
	problem := "a network problem on the node"
	if e.Kind == GitTLS {
		problem += " (or a certificate it does not trust)"
	}
	exit := ""
	if e.Exit != "" {
		exit = " (" + e.Exit + ")"
	}
	return fmt.Sprintf("%s: %s %s - %s, not the address, the branch or the credentials: %s%s. %s",
		ErrFetch, node, what, problem, e.Line, exit, gitHealthHint)
}

// Is makes errors.Is(err, ErrFetch) hold.
func (e *GitNetworkError) Is(target error) bool { return target == ErrFetch }

// gitHealthHint points at the node check that tests what such a fetch
// needs (nodecheck's DNS resolution, Container DNS and Panel connection).
const gitHealthHint = "The node's Health check (its Health tab, or `" + brand.Slug + " health` on the node) tests its DNS and connections"

// NameNode puts the node's name into a GitNetworkError in err.
func NameNode(err error, name string) {
	var ne *GitNetworkError
	if name != "" && errors.As(err, &ne) {
		ne.Node = name
	}
}

// gitNetPattern is one way a network failure shows in git's stderr or a
// failed connection of the fetch's proxy. Target is the submatch that
// names the host, port the one that names its port (0: none).
type gitNetPattern struct {
	kind         GitNetworkKind
	re           *regexp.Regexp
	target, port int
}

// gitNetPatterns, most specific first. Samples are in gitnet_test.go.
var gitNetPatterns = []gitNetPattern{
	// curl: "Could not resolve host: github.com", "Could not resolve
	// proxy: proxy.example"; ssh: "Could not resolve hostname github.com:
	// Name or service not known"; Go: "dial tcp: lookup github.com on
	// 127.0.0.53:53: server misbehaving", "lookup github.com: no such host".
	{kind: GitDNS, re: regexp.MustCompile(`Could not resolve (?:host|proxy|hostname):? ([^\s:]+)`), target: 1},
	{kind: GitDNS, re: regexp.MustCompile(`\blookup ([^\s:]+)(?: on \S+)?: `), target: 1},
	{kind: GitDNS, re: regexp.MustCompile(`(?i)Temporary failure in name resolution|Name or service not known|nodename nor servname provided|no such host|server misbehaving`)},
	// curl: "CONNECT tunnel failed, response 502", before 7.69 "Received
	// HTTP code 502 from proxy after CONNECT"; the agent's proxy (dialVia):
	// "the tunnel to github.com:443 through the agent's proxy ...: the
	// proxy answered 502 Bad Gateway".
	{kind: GitProxy, re: regexp.MustCompile(`the tunnel to (\S+):(\d+) through the agent's proxy`), target: 1, port: 2},
	{kind: GitProxy, re: regexp.MustCompile(`CONNECT tunnel failed, response \d+|Received HTTP code \d+ from proxy after CONNECT|Proxy CONNECT aborted|the agent's proxy`)},
	// curl's TLS errors (OpenSSL, GnuTLS, Secure Transport); Go's.
	{kind: GitTLS, re: regexp.MustCompile(`SSL_connect: \S+ in connection to (\S+):(\d+)`), target: 1, port: 2},
	{kind: GitTLS, re: regexp.MustCompile(`(?i)SSL certificate problem|server certificate verification failed|certificate verify failed|gnutls_handshake\(\) failed|GnuTLS recv error|SSL_ERROR_SYSCALL|OpenSSL SSL_|TLS connect error|no alternative certificate subject name|x509: |tls: `)},
	// curl: "Failed to connect to github.com port 443 after 133967 ms:
	// Connection timed out" (7.x), "...: Couldn't connect to server" (8.x);
	// ssh: "ssh: connect to host github.com port 22: Connection refused";
	// Go (the fetch's proxy): "dial tcp 140.82.121.4:443: i/o timeout".
	{kind: GitConnect, re: regexp.MustCompile(`Failed to connect to (\S+) port (\d+)`), target: 1, port: 2},
	{kind: GitConnect, re: regexp.MustCompile(`connect to host (\S+) port (\d+): `), target: 1, port: 2},
	{kind: GitConnect, re: regexp.MustCompile(`dial tcp (\S+):(\d+): `), target: 1, port: 2},
	{kind: GitConnect, re: regexp.MustCompile(`(?i)Connection refused|Connection timed out|Operation timed out|Connection reset by peer|Network is unreachable|No route to host|` +
		`Couldn't connect to server|i/o timeout|Empty reply from server|Recv failure|Send failure|RPC failed; curl (?:7|28|52|55|56) |the git server could not be reached`)},
}

// accessRe is git's "unable to access '<url>'": the address it tried
// when the error line names no host.
var accessRe = regexp.MustCompile(`unable to access '([^']+)'`)

// userinfoRe finds credentials in an address inside a line.
var userinfoRe = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s']+@`)

// classifyGitNetwork reads one failure, the fetch proxy's or git's
// stderr: the first line that names a network failure, what kind, and
// the host it names (else the one git's "unable to access" names, else
// fallback, the source's host:port). nil when no line does.
func classifyGitNetwork(text, fallback string) *GitNetworkError {
	var access string
	if m := accessRe.FindStringSubmatch(text); m != nil {
		if u, err := url.Parse(m[1]); err == nil && u.Hostname() != "" {
			access = u.Host
			if u.Port() == "" {
				access = net.JoinHostPort(u.Hostname(), map[string]string{"http": "80", "https": "443", "ssh": "22"}[u.Scheme])
			}
		}
	}
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		for _, p := range gitNetPatterns {
			m := p.re.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			target := access
			if p.target > 0 {
				target = strings.Trim(m[p.target], "'\"[]")
				if p.port > 0 {
					target = net.JoinHostPort(target, m[p.port])
				}
			}
			if target == "" || strings.HasSuffix(target, ":") {
				target = fallback
			}
			if p.kind == GitDNS {
				// A name that did not resolve: the name, without a port.
				if host, _, err := net.SplitHostPort(target); err == nil {
					target = host
				}
			}
			return &GitNetworkError{Kind: p.kind, Target: target, Line: cleanGitLine(line)}
		}
	}
	return nil
}

// cleanGitLine is an error line for a message: no credentials in an
// address, at most 300 bytes.
func cleanGitLine(line string) string {
	line = userinfoRe.ReplaceAllString(line, "${1}***@")
	if len(line) > 300 {
		line = line[:300]
	}
	return line
}

// stderrTail keeps the start of a command's stderr (up to 16 KiB), where
// git writes its error, besides the build log.
type stderrTail struct{ buf bytes.Buffer }

func (s *stderrTail) Write(b []byte) (int, error) {
	if room := 16<<10 - s.buf.Len(); room > 0 {
		s.buf.Write(b[:min(len(b), room)])
	}
	return len(b), nil
}

func (s *stderrTail) String() string { return s.buf.String() }
