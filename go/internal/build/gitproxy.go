package build

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
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

	"golang.org/x/net/http/httpproxy"

	"github.com/seylo-dev/app/go/gen/brand"
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
//
// A node whose only way out is an HTTP proxy (the agent's HTTPS_PROXY,
// HTTP_PROXY and NO_PROXY, which git used before) keeps cloning: https
// tunnels and plain http requests go on to that proxy, the way curl sent
// them. The node cannot see where the proxy connects, so then the check is
// on the target before the request goes out (an IP address exactly; a name
// by what it resolves to on the node; a name the node cannot resolve only
// for an allowed internal host, or on a node whose config.yml sets
// git_proxy_resolves), and the proxy's own rules decide the rest. ssh
// connects directly, as it did before.
//
// The node's own addresses count as internal (netguard), public ones
// included: a git server on the node, reached by its public name, needs
// allow_internal_host like one on a private address. The panel counts the
// nodes' addresses as internal too, so an admin's save allows such a host.

const gitDialTimeout = 30 * time.Second

// gitDialHeader marks git-dial's CONNECT (ssh), which never goes to the
// agent's HTTP proxy.
const gitDialHeader = "Git-Dial"

// gitUpstream is the agent's own proxy settings (HTTPS_PROXY, HTTP_PROXY,
// NO_PROXY), read for every fetch. Tests replace it.
var gitUpstream = httpproxy.FromEnvironment

// gitLookup resolves a name on the node before a request goes to the
// agent's HTTP proxy. Tests replace it.
var gitLookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

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
	// Hint is what can be done about it, if anything.
	Hint string
}

func (e *BlockedHostError) Error() string {
	msg := fmt.Sprintf("%s: the node refused to connect to %s: %s", ErrFetch, e.Target, e.Reason)
	if e.Hint != "" {
		msg += ". " + e.Hint
	}
	return msg
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
	// node is what the node's own config.yml says about git fetches.
	node GitNodeConfig
}

// GitNodeConfig is the part of the node's config.yml that git fetches
// read. Only someone with root on the node sets it; the panel cannot.
type GitNodeConfig struct {
	// ProxyResolves is config.yml's git_proxy_resolves: behind the agent's
	// HTTP proxy, a name the node cannot resolve goes on to the proxy
	// unchecked (nodes whose DNS knows no outside names), so the proxy's
	// own rules decide where it connects. Off, such a name is refused
	// unless allow_internal_host covers it.
	ProxyResolves bool
	// ConfigFile is config.yml's path, for messages. Empty: the default.
	ConfigFile string
}

func (n GitNodeConfig) configFile() string {
	if n.ConfigFile == "" {
		return brand.DataDir + "/config.yml"
	}
	return n.ConfigFile
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
	// upstream is the agent's HTTP proxy for a request URL (nil: connect
	// directly); viaUpstream forwards plain http requests to it.
	upstream    func(*url.URL) (*url.URL, error)
	viaUpstream *http.Transport

	mu       sync.Mutex
	conns    map[net.Conn]struct{}
	refused  *BlockedHostError
	closed   bool
	handlers sync.WaitGroup
	// failedTarget and failedErr are the first connection the proxy could
	// not make (not one it refused): what git asked for and why.
	failedTarget, failedErr string
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
	p := &gitProxy{policy: policy, log: log, ctx: ctx, cancel: cancel, ln: ln, conns: map[net.Conn]struct{}{}, upstream: gitUpstream().ProxyFunc()}
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
	// Plain http through the agent's HTTP proxy: the request goes to the
	// proxy (dialed like the tunnels'), which connects to the target.
	p.viaUpstream = &http.Transport{
		Proxy: func(r *http.Request) (*url.URL, error) {
			return p.upstreamFor("http", r.URL.Hostname(), portOr(r.URL.Port(), "80"))
		},
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			return p.dialProxyServer(ctx, addr)
		},
		ResponseHeaderTimeout: 2 * time.Minute,
	}
	p.fwd = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL = r.In.URL
			r.Out.Host = r.In.Host
		},
		Transport: forwardTransport{p},
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

// ConnFailed is the first connection the proxy could not make: the
// host:port git asked for and the error; "" when every one worked.
func (p *gitProxy) ConnFailed() (target, text string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.failedTarget, p.failedErr
}

// connFailed records a connection to target that failed (one the policy
// refused is recorded by refuse), and logs it when logIt (the paths
// through the agent's HTTP proxy log their own). A request git gave up on
// itself (ctx done) is not the fetch's failure.
func (p *gitProxy) connFailed(ctx context.Context, target string, err error, logIt bool) {
	var blocked *BlockedHostError
	if err == nil || ctx.Err() != nil || errors.As(err, &blocked) {
		return
	}
	p.mu.Lock()
	if p.failedErr == "" {
		p.failedTarget, p.failedErr = target, err.Error()
	}
	p.mu.Unlock()
	if logIt {
		fmt.Fprintf(p.log, "The git connection to %s failed: %v\n", target, err)
	}
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
	p.viaUpstream.CloseIdleConnections()
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
		return nil, p.refuse(host, port, blocked)
	}
	return conn, err
}

// refuse records and logs a connection the policy does not allow.
func (p *gitProxy) refuse(host, port string, blocked *netguard.BlockedError) *BlockedHostError {
	target := net.JoinHostPort(strings.Trim(host, "[]"), port)
	e := &BlockedHostError{Target: target, Reason: blocked.Error()}
	if blocked.Addr.IsValid() && normHost(host) != blocked.Addr.String() {
		e.Reason = fmt.Sprintf("%s resolves to %s, %s", host, blocked.Addr, blocked.What)
	}
	switch class, _ := netguard.Classify(blocked.Addr); {
	case blocked.Addr.IsValid() && class == netguard.Metadata:
		e.Hint = "Nodes never connect to cloud metadata addresses"
	case p.ownSource(host, port):
		e.Hint = "Nodes clone only from public addresses other than their own; " + allowHostHint
	default:
		e.Hint = "Nodes clone from public addresses only, and from internal ones only for the source's own host when an admin allowed it, never for a redirect or submodule to another host"
	}
	return p.record(e)
}

// allowHostHint is how an admin lets nodes clone the source's host from
// internal addresses (the node's own included).
const allowHostHint = "an admin can allow internal addresses of this host for the project " +
	"(the project's Settings > Internal git hosts, or git.allowInternalHost)"

// refuseUnresolvable refuses a name the node cannot resolve before it goes
// to the agent's HTTP proxy; the hint names config.yml's opt-in.
func (p *gitProxy) refuseUnresolvable(host, port, name string) *BlockedHostError {
	e := &BlockedHostError{
		Target: net.JoinHostPort(strings.Trim(host, "[]"), port),
		Reason: "the node cannot resolve " + name + ", so it cannot check where the agent's HTTP proxy would connect",
		Hint: "If this node relies on its HTTP proxy to resolve names, its root can set git_proxy_resolves: true in " +
			p.policy.node.configFile() + " and restart the agent (the proxy's own rules then decide where such names go)",
	}
	if p.ownSource(host, port) {
		e.Hint += "; or " + allowHostHint
	}
	return p.record(e)
}

// ownSource says whether host:port is the source's own host and port.
func (p *gitProxy) ownSource(host, port string) bool {
	return normHost(host) == p.policy.source.host && port == p.policy.source.port
}

// record keeps the first refusal and logs every one.
func (p *gitProxy) record(e *BlockedHostError) *BlockedHostError {
	p.mu.Lock()
	if p.refused == nil {
		p.refused = e
	}
	p.mu.Unlock()
	fmt.Fprintf(p.log, "Refused a git connection to %s: %s\n", e.Target, e.Reason)
	return e
}

func portOr(port, def string) string {
	if port == "" {
		return def
	}
	return port
}

// upstreamFor is the agent's HTTP proxy for a connection git makes for
// scheme ("https" or "http") to host:port, or nil to connect directly
// (no proxy set, NO_PROXY, loopback).
func (p *gitProxy) upstreamFor(scheme, host, port string) (*url.URL, error) {
	shared, err := p.upstream(&url.URL{Scheme: scheme, Host: net.JoinHostPort(strings.Trim(host, "[]"), port)})
	if err != nil || shared == nil {
		return nil, err
	}
	// httpproxy hands out the same URL every time.
	up := *shared
	if shared.User != nil {
		user := *shared.User
		up.User = &user
	}
	switch up.Scheme {
	case "http", "https":
	default:
		return nil, fmt.Errorf("the agent's proxy %s: git goes only through http:// or https:// proxies", up.Redacted())
	}
	if up.Port() == "" {
		// curl's defaults, which git used before.
		up.Host = net.JoinHostPort(up.Hostname(), map[string]string{"http": "1080", "https": "443"}[up.Scheme])
	}
	return &up, nil
}

// checkBeforeUpstream applies the fetch's policy to a target the agent's
// HTTP proxy will connect to: an IP address exactly, a name by what it
// resolves to on the node. A name the node cannot resolve goes on only when
// internal addresses are allowed for it (allow_internal_host) or the node's
// root said the proxy resolves names (git_proxy_resolves): the proxy could
// resolve it to anything, an internal address included.
func (p *gitProxy) checkBeforeUpstream(ctx context.Context, host, port string) error {
	allowed := p.policy.internalAllowed(host, port)
	name := strings.Trim(host, "[]")
	if a, err := netip.ParseAddr(name); err == nil {
		var blocked *netguard.BlockedError
		if errors.As(netguard.Check(net.JoinHostPort(a.String(), port), allowed), &blocked) {
			return p.refuse(host, port, blocked)
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	addrs, err := gitLookup(ctx, name)
	if err != nil || len(addrs) == 0 {
		if allowed || p.policy.node.ProxyResolves {
			return nil
		}
		return p.refuseUnresolvable(host, port, name)
	}
	for _, a := range addrs {
		var blocked *netguard.BlockedError
		if errors.As(netguard.Check(net.JoinHostPort(a.String(), port), allowed), &blocked) {
			return p.refuse(host, port, blocked)
		}
	}
	return nil
}

// dialProxyServer connects to the agent's HTTP proxy itself. The node's
// operator set it (often on a private address), so internal addresses are
// fine; metadata endpoints are not.
func (p *gitProxy) dialProxyServer(ctx context.Context, addr string) (net.Conn, error) {
	conn, err := netguard.DialContext(ctx, addr, gitDialTimeout, true)
	if err != nil {
		err = fmt.Errorf("connecting to the agent's proxy %s: %w", addr, err)
		fmt.Fprintf(p.log, "The git connection could not reach the proxy: %v\n", err)
	}
	return conn, err
}

// dialVia opens a CONNECT tunnel to host:port through the agent's HTTP
// proxy up.
func (p *gitProxy) dialVia(ctx context.Context, up *url.URL, host, port string) (net.Conn, error) {
	if err := p.checkBeforeUpstream(ctx, host, port); err != nil {
		return nil, err
	}
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		select {
		case <-p.ctx.Done():
			stop()
		case <-ctx.Done():
		}
	}()
	conn, err := p.dialProxyServer(ctx, up.Host)
	if err != nil {
		return nil, err
	}
	target := net.JoinHostPort(strings.Trim(host, "[]"), port)
	fail := func(err error) (net.Conn, error) {
		_ = conn.Close()
		err = fmt.Errorf("the tunnel to %s through the agent's proxy %s: %w", target, up.Redacted(), err)
		fmt.Fprintf(p.log, "The git connection failed: %v\n", err)
		return nil, err
	}
	// The handshake with the proxy has gitDialTimeout, and ends when the fetch does.
	raw := conn
	_ = raw.SetDeadline(time.Now().Add(gitDialTimeout))
	done := context.AfterFunc(ctx, func() { _ = raw.SetDeadline(time.Unix(1, 0)) })
	defer done()
	if up.Scheme == "https" {
		tc := tls.Client(conn, &tls.Config{ServerName: up.Hostname(), MinVersion: tls.VersionTLS12})
		if err := tc.HandshakeContext(ctx); err != nil {
			return fail(err)
		}
		conn = tc
	}
	req := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n"
	if up.User != nil {
		pass, _ := up.User.Password()
		req += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(up.User.Username()+":"+pass)) + "\r\n"
	}
	if _, err := io.WriteString(conn, req+"\r\n"); err != nil {
		return fail(err)
	}
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		return fail(err)
	}
	if res.StatusCode != http.StatusOK {
		_ = res.Body.Close()
		return fail(fmt.Errorf("the proxy answered %s", res.Status))
	}
	if !done() {
		return fail(ctx.Err())
	}
	_ = conn.SetDeadline(time.Time{})
	if br.Buffered() > 0 {
		return &readAheadConn{Conn: conn, r: br}, nil
	}
	return conn, nil
}

// readAheadConn is a connection whose first bytes a bufio.Reader already
// read.
type readAheadConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *readAheadConn) Read(b []byte) (int, error) { return c.r.Read(b) }

// CloseWrite half-closes the tunnel when the connection under it can.
func (c *readAheadConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return c.Conn.Close()
}

// forwardTransport sends plain http requests (only when git's
// protocol.http.allow lets them) to their server, or to the agent's HTTP
// proxy after the same check as a tunnel.
type forwardTransport struct{ p *gitProxy }

func (f forwardTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	host, port := r.URL.Hostname(), portOr(r.URL.Port(), "80")
	up, err := f.p.upstreamFor("http", host, port)
	if err != nil {
		return nil, err
	}
	target := net.JoinHostPort(host, port)
	if up == nil {
		res, err := f.p.transport.RoundTrip(r)
		f.p.connFailed(r.Context(), target, err, true)
		return res, err
	}
	if err := f.p.checkBeforeUpstream(r.Context(), host, port); err != nil {
		return nil, err
	}
	res, err := f.p.viaUpstream.RoundTrip(r)
	// dialProxyServer logged a proxy it could not reach.
	f.p.connFailed(r.Context(), target, err, false)
	return res, err
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
	var upstream net.Conn
	// git's own https (curl) goes to the agent's HTTP proxy when one is set; ssh never did.
	up, err := p.upstreamFor("https", host, port)
	direct := false
	switch {
	case err != nil:
		fmt.Fprintf(p.log, "The git connection to %s failed: %v\n", r.Host, err)
	case up != nil && r.Header.Get(gitDialHeader) == "":
		upstream, err = p.dialVia(r.Context(), up, host, port)
	default:
		direct = true
		upstream, err = p.dial(r.Context(), host, port)
	}
	if err != nil {
		var blocked *BlockedHostError
		if errors.As(err, &blocked) {
			http.Error(w, blocked.Error(), http.StatusForbidden)
			return
		}
		// git only sees a 502 ("CONNECT tunnel failed, response 502"): the
		// fetch's error names this one (networkErr). dialVia logged its own.
		p.connFailed(r.Context(), r.Host, err, direct)
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
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n%s: ssh\r\n\r\n", target, target, gitDialHeader); err != nil {
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

// gitPolicyFor is the policy of one source on this node.
func gitPolicyFor(src *agentv1.GitSource, node GitNodeConfig) (gitPolicy, error) {
	t, err := gitTargetOf(src.GetUrl())
	if err != nil {
		return gitPolicy{}, err
	}
	return gitPolicy{source: t, allowInternal: src.GetAllowInternalHost(), node: node}, nil
}
