package build

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	stdlog "log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/netguard"
)

// Every connection git makes for a source goes through a proxy the agent
// runs on loopback for that one fetch: https through git's http.proxy (a
// CONNECT tunnel; plain http as a forwarded request), ssh through a
// ProxyCommand that runs this binary as `git-dial`, which asks the same
// proxy for a tunnel. The proxy dials with netguard, which checks the
// address the socket connects to, so a name that resolves somewhere else
// on the node than at the panel (rebinding, split-horizon DNS), a redirect
// and a submodule all stay on public addresses. Internal addresses are
// allowed only for the source's own host and port, and only when the panel
// says an admin allowed that host for the project (allow_internal_host).
// Metadata endpoints never.

const gitDialTimeout = 30 * time.Second

// GitDialCommand is the hidden CLI command the ssh ProxyCommand runs.
const GitDialCommand = "git-dial"

// gitDialProgram is the binary ssh runs as its ProxyCommand: the agent
// itself. Tests point it at the test binary (TestMain).
var gitDialProgram = os.Executable

// ErrBlockedHost is a git connection the node refused because of where it
// would go.
var ErrBlockedHost = errors.New("the node does not clone from this address")

// BlockedHostError says which connection was refused and why.
type BlockedHostError struct {
	Target string
	Reason string
}

func (e *BlockedHostError) Error() string {
	return fmt.Sprintf("%s: the node refused to connect to %s: %s. Nodes clone from public addresses only, unless an admin allowed this host for the project",
		ErrFetch, e.Target, e.Reason)
}

// Is makes errors.Is(err, ErrFetch) and errors.Is(err, ErrBlockedHost) hold.
func (e *BlockedHostError) Is(target error) bool {
	return target == ErrFetch || target == ErrBlockedHost
}

// gitTarget is the host and port of a git address, the way git connects:
// lower case, no brackets, the scheme's port when none is given.
type gitTarget struct {
	host string
	port string
}

func (t gitTarget) String() string { return net.JoinHostPort(t.host, t.port) }

// gitTargetOf parses https://, http://, ssh:// and scp-like addresses.
func gitTargetOf(raw string) (gitTarget, error) {
	if scpRe.MatchString(raw) && !strings.Contains(raw, "://") {
		at := strings.IndexByte(raw, '@')
		colon := strings.IndexByte(raw[at:], ':') + at
		return gitTarget{host: normHost(raw[at+1 : colon]), port: "22"}, nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return gitTarget{}, invalid("%q is not a repository address", raw)
	}
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https":
			port = "443"
		case "http":
			port = "80"
		case "ssh":
			port = "22"
		default:
			return gitTarget{}, invalid("repository addresses start with https:// or ssh://")
		}
	}
	return gitTarget{host: normHost(u.Hostname()), port: port}, nil
}

func normHost(h string) string {
	h = strings.TrimSuffix(strings.ToLower(strings.Trim(h, "[]")), ".")
	if a, err := netip.ParseAddr(h); err == nil {
		return a.WithZone("").String()
	}
	return h
}

// gitPolicy decides which addresses a fetch may connect to.
type gitPolicy struct {
	source gitTarget
	// allowInternal is GitSource.allow_internal_host: the source's own
	// host may have internal addresses.
	allowInternal bool
}

func (p gitPolicy) internalAllowed(host, port string) bool {
	return p.allowInternal && port == p.source.port && normHost(host) == p.source.host
}

// gitProxy is one fetch's proxy on 127.0.0.1.
type gitProxy struct {
	policy    gitPolicy
	log       io.Writer
	ctx       context.Context
	cancel    context.CancelFunc
	ln        net.Listener
	srv       *http.Server
	fwd       *httputil.ReverseProxy
	transport *http.Transport

	mu       sync.Mutex
	conns    map[net.Conn]struct{}
	refused  *BlockedHostError
	closed   bool
	handlers sync.WaitGroup
}

// syncWriter serializes the writes of git (through exec) and the proxy
// into one log.
type syncWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *syncWriter) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(b)
}

func startGitProxy(policy gitPolicy, log io.Writer) (*gitProxy, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("starting the git proxy: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &gitProxy{policy: policy, log: log, ctx: ctx, cancel: cancel, ln: ln, conns: map[net.Conn]struct{}{}}
	p.transport = &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return p.dial(ctx, host, port)
		},
		ResponseHeaderTimeout: 2 * time.Minute,
	}
	p.fwd = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL = r.In.URL
			r.Out.Host = r.In.Host
		},
		Transport: p.transport,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			var blocked *BlockedHostError
			if errors.As(err, &blocked) {
				http.Error(w, blocked.Error(), http.StatusForbidden)
				return
			}
			http.Error(w, "the git server could not be reached", http.StatusBadGateway)
		},
	}
	p.srv = &http.Server{
		Handler:           p,
		ReadHeaderTimeout: 30 * time.Second,
		ErrorLog:          stdlog.New(io.Discard, "", 0),
	}
	go func() { _ = p.srv.Serve(ln) }()
	return p, nil
}

// URL is git's http.proxy.
func (p *gitProxy) URL() string { return "http://" + p.ln.Addr().String() }

// Addr is where git-dial asks for its tunnel.
func (p *gitProxy) Addr() string { return p.ln.Addr().String() }

// Refused is the first connection the proxy refused, if any.
func (p *gitProxy) Refused() *BlockedHostError {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.refused
}

// Close stops the listener and every open tunnel, and waits for the
// requests in flight, so nothing writes to the log afterwards.
func (p *gitProxy) Close() {
	p.mu.Lock()
	p.closed = true
	conns := p.conns
	p.conns = map[net.Conn]struct{}{}
	p.mu.Unlock()
	p.cancel()
	_ = p.srv.Close()
	p.transport.CloseIdleConnections()
	for c := range conns {
		_ = c.Close()
	}
	p.handlers.Wait()
}

func (p *gitProxy) track(c net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false
	}
	p.conns[c] = struct{}{}
	return true
}

func (p *gitProxy) untrack(c net.Conn) {
	p.mu.Lock()
	delete(p.conns, c)
	p.mu.Unlock()
	_ = c.Close()
}

// dial connects to host:port with the fetch's policy.
func (p *gitProxy) dial(ctx context.Context, host, port string) (net.Conn, error) {
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		select {
		case <-p.ctx.Done():
			stop()
		case <-ctx.Done():
		}
	}()
	target := net.JoinHostPort(strings.Trim(host, "[]"), port)
	conn, err := netguard.DialContext(ctx, target, gitDialTimeout, p.policy.internalAllowed(host, port))
	var blocked *netguard.BlockedError
	if errors.As(err, &blocked) {
		e := &BlockedHostError{Target: target, Reason: blocked.Error()}
		if blocked.Addr.IsValid() && normHost(host) != blocked.Addr.String() {
			e.Reason = fmt.Sprintf("%s resolves to %s, %s", host, blocked.Addr, blocked.What)
		}
		p.mu.Lock()
		if p.refused == nil {
			p.refused = e
		}
		p.mu.Unlock()
		fmt.Fprintf(p.log, "Refused a git connection to %s: %s\n", target, e.Reason)
		return nil, e
	}
	return conn, err
}

func (p *gitProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		http.Error(w, "the fetch is over", http.StatusServiceUnavailable)
		return
	}
	p.handlers.Add(1)
	p.mu.Unlock()
	defer p.handlers.Done()
	switch {
	case r.Method == http.MethodConnect:
		p.tunnel(w, r)
	case r.URL.IsAbs() && r.URL.Scheme == "http":
		// Plain http (only when git's protocol.http.allow lets it).
		p.fwd.ServeHTTP(w, r)
	default:
		http.Error(w, "not a proxy request", http.StatusBadRequest)
	}
}

func (p *gitProxy) tunnel(w http.ResponseWriter, r *http.Request) {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		http.Error(w, "CONNECT needs host:port", http.StatusBadRequest)
		return
	}
	upstream, err := p.dial(r.Context(), host, port)
	if err != nil {
		var blocked *BlockedHostError
		if errors.As(err, &blocked) {
			http.Error(w, blocked.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, "the git server could not be reached", http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		_ = upstream.Close()
		http.Error(w, "no tunnel", http.StatusInternalServerError)
		return
	}
	client, buf, err := hj.Hijack()
	if err != nil {
		_ = upstream.Close()
		return
	}
	if !p.track(client) || !p.track(upstream) {
		_ = client.Close()
		_ = upstream.Close()
		return
	}
	defer p.untrack(client)
	defer p.untrack(upstream)
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		return
	}
	pipe(client, buf.Reader, upstream)
}

// pipe copies both ways until one side is done; local holds what was
// read ahead of the tunnel.
func pipe(local net.Conn, localRead io.Reader, remote net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(remote, localRead)
		closeWrite(remote)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(local, remote)
		closeWrite(local)
		done <- struct{}{}
	}()
	<-done
	<-done
}

func closeWrite(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = c.Close()
}

// GitDial is the `git-dial <proxy> <host:port>` helper ssh runs as its
// ProxyCommand: a CONNECT tunnel through the fetch's proxy, piped to
// stdin and stdout. The target is fixed by the agent (never ssh's %h), so
// a hostile host name in a submodule URL never reaches a shell, and a
// submodule on another ssh host gets this host's key and fails the
// known_hosts check.
func GitDial(ctx context.Context, proxy, target string, stdin io.Reader, stdout io.Writer, stderr io.Writer) error {
	if _, _, err := net.SplitHostPort(target); err != nil {
		return fmt.Errorf("git-dial: %q is not host:port", target)
	}
	ap, err := netip.ParseAddrPort(proxy)
	if err != nil || !ap.Addr().IsLoopback() {
		return fmt.Errorf("git-dial: the proxy must be a loopback address, not %q", proxy)
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", proxy)
	if err != nil {
		return fmt.Errorf("git-dial: %w", err)
	}
	defer conn.Close()
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target); err != nil {
		return fmt.Errorf("git-dial: %w", err)
	}
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		return fmt.Errorf("git-dial: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		_ = res.Body.Close()
		msg := strings.TrimSpace(string(body))
		if msg == "" {
			msg = res.Status
		}
		fmt.Fprintln(stderr, msg)
		return fmt.Errorf("git-dial: %s", res.Status)
	}
	go func() {
		_, _ = io.Copy(conn, stdin)
		closeWrite(conn)
	}()
	// The server closing the connection ends the helper (ssh stops it when
	// it is done in any case).
	_, _ = io.Copy(stdout, br)
	return nil
}

// gitPolicyFor is the policy of one source.
func gitPolicyFor(src *agentv1.GitSource) (gitPolicy, error) {
	t, err := gitTargetOf(src.GetUrl())
	if err != nil {
		return gitPolicy{}, err
	}
	return gitPolicy{source: t, allowInternal: src.GetAllowInternalHost()}, nil
}
