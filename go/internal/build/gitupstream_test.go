package build

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	neturl "net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// A node whose only way out is an HTTP proxy: git used the agent's
// HTTPS_PROXY, HTTP_PROXY and NO_PROXY before every git connection went
// through the fetch's own proxy, which then dialed every target itself and
// timed out or failed. The fetch's proxy now sends https tunnels and plain
// http requests on to the agent's proxy, after checking the target.

// fakeUpstream is an HTTP proxy (CONNECT and absolute-URI requests) that
// knows names the node cannot reach itself: routes maps the host:port git
// asks for to where it really is.
type fakeUpstream struct {
	addr   string
	routes map[string]string
	deny   bool

	mu    sync.Mutex
	seen  []string
	auths []string
}

func startFakeUpstream(t *testing.T, routes map[string]string, deny bool) *fakeUpstream {
	t.Helper()
	u := &fakeUpstream{routes: routes, deny: deny}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	u.addr = ln.Addr().String()
	srv := &http.Server{Handler: u}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return u
}

func (u *fakeUpstream) route(hostport string) string {
	if to, ok := u.routes[hostport]; ok {
		return to
	}
	return hostport
}

func (u *fakeUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u.mu.Lock()
	if r.Method == http.MethodConnect {
		u.seen = append(u.seen, "CONNECT "+r.Host)
	} else {
		u.seen = append(u.seen, r.Method+" "+r.URL.String())
	}
	u.auths = append(u.auths, r.Header.Get("Proxy-Authorization"))
	u.mu.Unlock()
	if u.deny {
		http.Error(w, "denied by the proxy's rules", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodConnect {
		to := u.route(r.URL.Host)
		(&httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Host = to
			pr.Out.Host = r.Host
		}}).ServeHTTP(w, r)
		return
	}
	remote, err := net.Dial("tcp", u.route(r.Host))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	client, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		_ = remote.Close()
		return
	}
	defer client.Close()
	defer remote.Close()
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		return
	}
	pipe(client, buf.Reader, remote)
}

func (u *fakeUpstream) requests() ([]string, []string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.seen...), append([]string(nil), u.auths...)
}

// setProxyEnv sets the agent's proxy variables in both spellings.
func setProxyEnv(t *testing.T, https, http, no string) {
	t.Helper()
	for k, v := range map[string]string{"HTTPS_PROXY": https, "HTTP_PROXY": http, "NO_PROXY": no} {
		t.Setenv(k, v)
		t.Setenv(strings.ToLower(k), v)
	}
}

func portOf(t *testing.T, rawURL string) string {
	t.Helper()
	rest := rawURL[strings.Index(rawURL, "://")+3:]
	_, port, err := net.SplitHostPort(rest[:strings.IndexByte(rest, '/')])
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func TestGitGoesThroughTheAgentsProxy(t *testing.T) {
	url, _, run, hits := gitServerHits(t, defaultGitUser, "", nil)
	// git.proxied.test has a public address the node cannot reach; only the proxy does.
	nodeDNS(t, map[string]string{"git.proxied.test": "93.184.216.34"})
	named := "git.proxied.test:" + portOf(t, url)
	up := startFakeUpstream(t, map[string]string{named: "127.0.0.1:" + portOf(t, url)}, false)
	setProxyEnv(t, "http://agent:pw@"+up.addr, "", "")
	src := &agentv1.GitSource{Url: "https://" + named + "/repo.git", Ref: "main"}
	ctx := context.Background()

	s := New(Options{Dir: t.TempDir(), Runner: run})
	defer s.Close()
	res, err := s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: src, Path: "a.txt"})
	// Before: the fetch's proxy looked git.proxied.test up itself and failed.
	if err != nil || string(res.GetContent()) != "two\n" {
		t.Fatalf("FetchGitFile through the agent's proxy: %v %q", err, res.GetContent())
	}
	work := t.TempDir()
	var log bytes.Buffer
	if _, err := fetchGit(ctx, run, &log, src, filepath.Join(work, "src"), work, false); err != nil {
		t.Fatalf("build fetch through the agent's proxy: %v\n%s", err, log.String())
	}
	seen, auths := up.requests()
	if len(seen) == 0 || hits.Load() == 0 {
		t.Fatalf("nothing went through the proxy: %v", seen)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("agent:pw"))
	for i, line := range seen {
		// The target as git named it, never an address the node picked; with the agent's proxy credentials.
		if line != "CONNECT "+named || auths[i] != wantAuth {
			t.Fatalf("request %d to the proxy: %q (auth %q)", i, line, auths[i])
		}
	}
}

func TestGitPlainHTTPGoesThroughTheAgentsProxy(t *testing.T) {
	url, hits := plainGitServer(t)
	port := portOf(t, url)
	nodeDNS(t, map[string]string{"git.proxied.test": "93.184.216.34"})
	named := "git.proxied.test:" + port
	up := startFakeUpstream(t, map[string]string{named: "127.0.0.1:" + port}, false)
	setProxyEnv(t, "", "http://"+up.addr, "")
	s := New(Options{Dir: t.TempDir(), Runner: ExecRunner{}})
	defer s.Close()
	res, err := s.FetchFile(context.Background(), &agentv1.FetchGitFileRequest{
		Source: &agentv1.GitSource{Url: "http://" + named + "/internal.git", Ref: "main", AllowPlainHttp: true},
		Path:   "secret.txt",
	})
	// Before: the fetch's proxy dialed git.proxied.test itself.
	if err != nil || !strings.Contains(string(res.GetContent()), "INTERNAL-ONLY-SECRET") {
		t.Fatalf("plain http through the agent's proxy: %v %v", res, err)
	}
	seen, _ := up.requests()
	if len(seen) == 0 || hits.Load() == 0 || !strings.HasPrefix(seen[0], "GET http://"+named+"/internal.git/info/refs") {
		t.Fatalf("requests to the proxy: %v", seen)
	}
}

// NO_PROXY hosts, and ssh, connect directly with the address check, as before.
func TestGitSkipsTheAgentsProxyForNoProxyAndSSH(t *testing.T) {
	up := startFakeUpstream(t, nil, false)
	setProxyEnv(t, "http://"+up.addr, "http://"+up.addr, ".proxied.test")
	_, err := fetchGit(context.Background(), ExecRunner{}, &bytes.Buffer{}, &agentv1.GitSource{Url: "https://git.proxied.test/repo.git", Ref: "main"},
		filepath.Join(t.TempDir(), "src"), t.TempDir(), false)
	if !errors.Is(err, ErrFetch) {
		t.Fatalf("NO_PROXY host: %v", err)
	}

	setProxyEnv(t, "http://"+up.addr, "", "")
	var log bytes.Buffer
	p, err := startGitProxy(gitPolicy{source: gitTarget{host: "git.proxied.test", port: "22"}}, &log)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	var stderr bytes.Buffer
	if err := GitDial(context.Background(), p.Addr(), "git.proxied.test:22", strings.NewReader(""), &bytes.Buffer{}, &stderr); err == nil {
		t.Fatal("git-dial reached git.proxied.test")
	}
	if seen, _ := up.requests(); len(seen) != 0 {
		t.Fatalf("went through the proxy: %v", seen)
	}
}

// The proxy's own answer reaches the build log, and the target check runs
// before anything goes to the proxy.
func TestGitThroughTheAgentsProxyIsChecked(t *testing.T) {
	url, _, run, _ := gitServerHits(t, defaultGitUser, "", nil)
	nodeDNS(t, map[string]string{"git.proxied.test": "93.184.216.34"})
	denied := startFakeUpstream(t, nil, true)
	setProxyEnv(t, "http://"+denied.addr, "", "")
	ctx := context.Background()
	var log bytes.Buffer
	_, err := fetchGit(ctx, run, &log, &agentv1.GitSource{Url: "https://git.proxied.test/repo.git", Ref: "main"}, filepath.Join(t.TempDir(), "src"), t.TempDir(), false)
	if !errors.Is(err, ErrFetch) || !strings.Contains(log.String(), "the proxy answered 403") {
		t.Fatalf("denied by the proxy: %v\n%s", err, log.String())
	}

	// A private address: refused on the node, unless the panel allowed the host.
	up := startFakeUpstream(t, map[string]string{"10.255.255.1:443": "127.0.0.1:" + portOf(t, url)}, false)
	setProxyEnv(t, "http://"+up.addr, "", "")
	log.Reset()
	_, err = fetchGit(ctx, run, &log, &agentv1.GitSource{Url: "https://10.255.255.1/repo.git", Ref: "main"}, filepath.Join(t.TempDir(), "src"), t.TempDir(), false)
	if !errors.Is(err, ErrBlockedHost) || !strings.Contains(err.Error(), "private") {
		t.Fatalf("private address through the proxy: %v\n%s", err, log.String())
	}
	if seen, _ := up.requests(); len(seen) != 0 {
		t.Fatalf("a refused target went to the proxy: %v", seen)
	}
	_, _ = fetchGit(ctx, run, &bytes.Buffer{}, &agentv1.GitSource{Url: "https://10.255.255.1/repo.git", Ref: "main", AllowInternalHost: true},
		filepath.Join(t.TempDir(), "src"), t.TempDir(), false)
	if seen, _ := up.requests(); len(seen) == 0 || seen[0] != "CONNECT 10.255.255.1:443" {
		t.Fatalf("allowed internal host through the proxy: %v", seen)
	}
}

// connectThrough asks the fetch's proxy for a tunnel the way git does and
// returns the status.
func connectThrough(t *testing.T, proxy, target string) int {
	t.Helper()
	c, err := net.Dial("tcp", proxy)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(c), &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

// A name that resolves to an internal address on the node is refused
// before it goes to the proxy (the proxy may well see the same answer).
func TestGitProxyChecksWhatTheNameResolvesToOnTheNode(t *testing.T) {
	up := startFakeUpstream(t, map[string]string{}, true)
	setProxyEnv(t, "http://"+up.addr, "", "")
	nodeDNS(t, map[string]string{"rebind.proxied.test": "10.0.0.7", "meta.proxied.test": "169.254.169.254", "pub.proxied.test": "93.184.216.34"})

	var log bytes.Buffer
	p, err := startGitProxy(gitPolicy{source: gitTarget{host: "rebind.proxied.test", port: "443"}}, &log)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if got := connectThrough(t, p.Addr(), "rebind.proxied.test:443"); got != http.StatusForbidden {
		t.Fatalf("internal answer on the node: %d\n%s", got, log.String())
	}
	if r := p.Refused(); r == nil || !strings.Contains(r.Error(), "10.0.0.7") || !strings.Contains(r.Error(), "git.allowInternalHost") {
		t.Fatalf("refused: %v", r)
	}
	if seen, _ := up.requests(); len(seen) != 0 {
		t.Fatalf("went to the proxy: %v", seen)
	}
	// A public answer goes on (the deny-all proxy then answers 403 itself).
	if got := connectThrough(t, p.Addr(), "pub.proxied.test:443"); got != http.StatusBadGateway {
		t.Fatalf("public answer: %d", got)
	}
	if seen, _ := up.requests(); len(seen) != 1 || seen[0] != "CONNECT pub.proxied.test:443" {
		t.Fatalf("public answer, proxy saw %v", seen)
	}

	allowed, err := startGitProxy(gitPolicy{source: gitTarget{host: "rebind.proxied.test", port: "443"}, allowInternal: true}, &log)
	if err != nil {
		t.Fatal(err)
	}
	defer allowed.Close()
	_ = connectThrough(t, allowed.Addr(), "rebind.proxied.test:443")
	if seen, _ := up.requests(); len(seen) != 2 || seen[1] != "CONNECT rebind.proxied.test:443" {
		t.Fatalf("allowed host, proxy saw %v", seen)
	}
	// The allowance is for the source's host only.
	if got := connectThrough(t, allowed.Addr(), "meta.proxied.test:443"); got != http.StatusForbidden {
		t.Fatalf("another host: %d", got)
	}
	// Metadata never, also for the allowed host.
	meta, err := startGitProxy(gitPolicy{source: gitTarget{host: "meta.proxied.test", port: "443"}, allowInternal: true}, &log)
	if err != nil {
		t.Fatal(err)
	}
	defer meta.Close()
	if got := connectThrough(t, meta.Addr(), "meta.proxied.test:443"); got != http.StatusForbidden || !strings.Contains(meta.Refused().Error(), "metadata") {
		t.Fatalf("metadata: %d %v", got, meta.Refused())
	}
	if seen, _ := up.requests(); len(seen) != 2 {
		t.Fatalf("refused targets went to the proxy: %v", seen)
	}
}

// The agent's proxy itself may be on a private address (the node's operator
// set it), never on a metadata one, and only http:// or https://.
func TestGitAgentsProxyAddress(t *testing.T) {
	nodeDNS(t, map[string]string{"git.proxied.test": "93.184.216.34"})
	for proxy, want := range map[string]string{
		"http://169.254.169.254:80": "cloud metadata",
		"socks5://127.0.0.1:1080":   "only through http:// or https:// proxies",
	} {
		setProxyEnv(t, proxy, "", "")
		var log bytes.Buffer
		p, err := startGitProxy(gitPolicy{source: gitTarget{host: "git.proxied.test", port: "443"}}, &log)
		if err != nil {
			t.Fatal(err)
		}
		if got := connectThrough(t, p.Addr(), "git.proxied.test:443"); got != http.StatusBadGateway || !strings.Contains(log.String(), want) {
			t.Errorf("%s: %d\n%s", proxy, got, log.String())
		}
		p.Close()
	}
	noPort := func(*neturl.URL) (*neturl.URL, error) { return neturl.Parse("http://proxy.lan") }
	up, err := (&gitProxy{upstream: noPort}).upstreamFor("https", "git.example.com", "443")
	if err != nil || up.Host != "proxy.lan:1080" {
		t.Fatalf("a proxy without a port: %v %v", up, err)
	}
}

// A name the node cannot resolve could be anything at the proxy, an
// internal address included: it goes to the proxy only for an allowed
// internal host (agentio-2). Before, it always went on unchecked.
func TestGitProxyRefusesNamesTheNodeCannotResolve(t *testing.T) {
	up := startFakeUpstream(t, map[string]string{}, true)
	setProxyEnv(t, "http://"+up.addr, "http://"+up.addr, "")
	nodeDNS(t, nil)

	var log bytes.Buffer
	p, err := startGitProxy(gitPolicy{source: gitTarget{host: "lan.proxied.test", port: "443"}}, &log)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if got := connectThrough(t, p.Addr(), "lan.proxied.test:443"); got != http.StatusForbidden {
		t.Fatalf("unresolvable name: %d\n%s", got, log.String())
	}
	// The refusal names both ways out: the node's own opt-in and the admin's allowance.
	if r := p.Refused(); r == nil || !strings.Contains(r.Error(), "cannot resolve lan.proxied.test") ||
		!strings.Contains(r.Error(), "git_proxy_resolves: true in /var/lib/seylo/config.yml") || !strings.Contains(r.Error(), "git.allowInternalHost") {
		t.Fatalf("refused: %v", r)
	}
	// Plain http requests take the same check.
	c, err := net.Dial("tcp", p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	_, _ = c.Write([]byte("GET http://lan.proxied.test/repo.git/info/refs HTTP/1.1\r\nHost: lan.proxied.test\r\n\r\n"))
	plain, err := http.ReadResponse(bufio.NewReader(c), nil)
	_ = c.Close()
	if err != nil || plain.StatusCode != http.StatusForbidden {
		t.Fatalf("plain http, unresolvable name: %v %v", plain, err)
	}
	if seen, _ := up.requests(); len(seen) != 0 {
		t.Fatalf("went to the proxy: %v", seen)
	}

	// With allow_internal_host for that host (an admin's git.allowInternalHost), it goes on.
	allowed, err := startGitProxy(gitPolicy{source: gitTarget{host: "lan.proxied.test", port: "443"}, allowInternal: true}, &log)
	if err != nil {
		t.Fatal(err)
	}
	defer allowed.Close()
	_ = connectThrough(t, allowed.Addr(), "lan.proxied.test:443")
	if seen, _ := up.requests(); len(seen) != 1 || seen[0] != "CONNECT lan.proxied.test:443" {
		t.Fatalf("allowed host, proxy saw %v", seen)
	}
	// Only that host.
	if got := connectThrough(t, allowed.Addr(), "other.proxied.test:443"); got != http.StatusForbidden {
		t.Fatalf("another unresolvable host: %d", got)
	}
	if seen, _ := up.requests(); len(seen) != 1 {
		t.Fatalf("another host went to the proxy: %v", seen)
	}
}

// A node whose DNS knows no outside names relies on its HTTP proxy to
// resolve them: its root opts in with config.yml's git_proxy_resolves, and
// then names the node cannot resolve go on to the proxy for any host (a
// redirect or submodule too), as before 0.2. A name that does resolve on
// the node is still checked.
func TestGitProxyResolvesOptIn(t *testing.T) {
	up := startFakeUpstream(t, map[string]string{}, true)
	setProxyEnv(t, "http://"+up.addr, "http://"+up.addr, "")
	nodeDNS(t, map[string]string{"rebind.proxied.test": "10.0.0.7"})

	var log bytes.Buffer
	node := GitNodeConfig{ProxyResolves: true, ConfigFile: "/srv/seylo/config.yml"}
	p, err := startGitProxy(gitPolicy{source: gitTarget{host: "github.com", port: "443"}, node: node}, &log)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	_ = connectThrough(t, p.Addr(), "github.com:443")
	_ = connectThrough(t, p.Addr(), "submodule.proxied.test:443")
	if seen, _ := up.requests(); len(seen) != 2 || seen[0] != "CONNECT github.com:443" || seen[1] != "CONNECT submodule.proxied.test:443" {
		t.Fatalf("proxy saw %v\n%s", seen, log.String())
	}
	if got := connectThrough(t, p.Addr(), "rebind.proxied.test:443"); got != http.StatusForbidden {
		t.Fatalf("a name the node resolves to a private address: %d", got)
	}
	if seen, _ := up.requests(); len(seen) != 2 {
		t.Fatalf("the private name went to the proxy: %v", seen)
	}

	// Without the opt-in a redirect or submodule host the node cannot resolve gets only the
	// node's opt-in as a way out (the admin's allowance covers the source's own host only),
	// with config.yml's real path.
	off, err := startGitProxy(gitPolicy{source: gitTarget{host: "github.com", port: "443"}, node: GitNodeConfig{ConfigFile: node.ConfigFile}}, &log)
	if err != nil {
		t.Fatal(err)
	}
	defer off.Close()
	if got := connectThrough(t, off.Addr(), "submodule.proxied.test:443"); got != http.StatusForbidden {
		t.Fatalf("submodule host without the opt-in: %d", got)
	}
	if r := off.Refused(); r == nil || !strings.Contains(r.Error(), "git_proxy_resolves: true in /srv/seylo/config.yml") || strings.Contains(r.Error(), "git.allowInternalHost") {
		t.Fatalf("refused: %v", r)
	}
}

// nodeDNS makes names (host -> address) the node's DNS for one test; any
// other name does not resolve.
func nodeDNS(t *testing.T, names map[string]string) {
	t.Helper()
	old := gitLookup
	t.Cleanup(func() { gitLookup = old })
	gitLookup = fakeLookup(names)
}

// fakeLookup is the node's DNS for gitLookup.
func fakeLookup(names map[string]string) func(context.Context, string) ([]netip.Addr, error) {
	return func(_ context.Context, host string) ([]netip.Addr, error) {
		if a, ok := names[host]; ok {
			return []netip.Addr{netip.MustParseAddr(a)}, nil
		}
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
}
