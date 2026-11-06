//go:build integration

package edge

// Runs in the test VM: scripts/dev/vm-gotest.sh ./internal/edge -run Integration -v
// A Box route through a real Traefik reaches the edge listener on the edge
// network's gateway, which checks a panel-signed ticket locally, sets its
// cookie and proxies to the tool's container.

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/proxy"
)

func TestIntegrationBoxTicketThroughTraefik(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	d, err := proxy.NewMobyDocker()
	if err != nil {
		t.Fatal(err)
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	prefix := "seylo-it-edg-" + hex.EncodeToString(b[:])
	labels := map[string]string{"seylo.test": prefix, "seylo.managed": "true"}
	edgeNet, projNet := prefix+"-edge", prefix+"-p"
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), time.Minute)
		defer ccancel()
		f := client.Filters{}
		f.Add("label", "seylo.test="+prefix)
		if list, err := d.Client().ContainerList(cctx, client.ContainerListOptions{All: true, Filters: f}); err == nil {
			for _, c := range list.Items {
				_ = d.RemoveContainer(cctx, c.ID)
			}
		}
		for _, n := range []string{projNet, edgeNet} {
			_, _ = d.Client().NetworkRemove(cctx, n, client.NetworkRemoveOptions{})
		}
	})

	if _, err := d.EnsureNetwork(ctx, projNet, labels); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	httpPort, tlsPort := uint16(freePort()), uint16(freePort())
	cfg := proxy.TraefikConfig{Name: prefix + "-traefik", Network: edgeNet, DynamicDir: filepath.Join(dir, "dynamic"), DataDir: filepath.Join(dir, "acme"),
		HTTPPort: httpPort, HTTPSPort: tlsPort, ExtraLabels: labels}
	st, err := (&proxy.Traefik{Docker: d, Config: cfg}).Ensure(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// The Box's container (whoami stands in for code-server).
	if err := d.EnsureImage(ctx, "traefik/whoami:v1.11.0"); err != nil {
		t.Fatal(err)
	}
	id, err := d.CreateContainer(ctx, proxy.ContainerSpec{Name: prefix + "-box", Image: "traefik/whoami:v1.11.0", Cmd: []string{"-name", "box"}, Labels: labels, Network: projNet})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	info, err := d.InspectContainer(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	boxAddr := "http://" + net.JoinHostPort(info.IPs[projNet], "80")

	// The edge, as the agent wires it.
	pub, priv, _ := ed25519.GenerateKey(nil)
	v := NewVerifier("node1")
	v.SetKey(pub)
	srv := NewHTTPServer(Config{Tickets: v})
	woke := make(chan struct{}, 8)
	srv.Register("box:bx1", ToolFunc(func(context.Context) (string, error) { woke <- struct{}{}; return boxAddr, nil }))
	l, err := net.Listen("tcp", net.JoinHostPort(st.Gateway, "0"))
	if err != nil {
		t.Fatal(err)
	}
	sctx, scancel := context.WithCancel(ctx)
	defer scancel()
	go func() { _ = srv.Serve(sctx, l) }()

	router := proxy.NewFileRouter(proxy.FileConfig{Dir: cfg.DynamicDir})
	router.SetEdge("http://" + l.Addr().String())
	router.SetProbe(net.JoinHostPort(st.IP, "80"), st.Gateway)
	box := &agentv1.ServiceSpec{Id: "bx1", Kind: agentv1.ServiceKind_SERVICE_KIND_BOX, Routing: &agentv1.Routing{Routes: []*agentv1.Route{
		{Id: "r1", Hosts: []string{"box.it.test"}, Https: agentv1.HttpsMode_HTTPS_MODE_OFF},
	}}}
	if err := router.Apply(ctx, box, nil); err != nil {
		t.Fatal(err)
	}
	vctx, vcancel := context.WithTimeout(ctx, 30*time.Second)
	defer vcancel()
	if err := router.Verify(vctx, "bx1"); err != nil {
		t.Fatal(err)
	}

	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar, Timeout: 5 * time.Second, Transport: &http.Transport{
		// Every request goes to Traefik with Host box.it.test.
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, fmt.Sprintf("127.0.0.1:%d", httpPort))
		},
	}}
	get := func(path string) (int, string) {
		resp, err := c.Get("http://box.it.test" + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	if code, _ := get("/"); code != http.StatusUnauthorized {
		t.Fatalf("no ticket: %d", code)
	}
	ticket := SignTicket(priv, "box:bx1", "u1", "node1", "it-1", time.Now().Add(time.Minute))
	code, body := get(proxy.TicketPath + "?t=" + url.QueryEscape(ticket) + "&to=/ws/files")
	if code != 200 || !strings.Contains(body, "Name: box") || !strings.Contains(body, "GET /ws/files") {
		t.Fatalf("after the ticket: %d %q", code, body)
	}
	if strings.Contains(body, sessionCookie+"=") {
		t.Fatalf("the edge cookie reached the tool:\n%s", body)
	}
	select {
	case <-woke:
	default:
		t.Fatal("the tool was not woken")
	}
	// A client sending its own tool header does not choose the tool:
	// Traefik overwrites it, so the bx1 session still works.
	req, _ := http.NewRequest(http.MethodGet, "http://box.it.test/again", nil)
	req.Header.Set(proxy.HeaderTool, "box:other")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("spoofed tool header changed the tool: %d", resp.StatusCode)
	}
	// The ticket is spent; a fresh browser cannot reuse it.
	fresh := &http.Client{Timeout: 5 * time.Second, Transport: c.Transport}
	resp, err = fresh.Get("http://box.it.test" + proxy.TicketPath + "?t=" + url.QueryEscape(ticket))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replayed ticket: %d", resp.StatusCode)
	}

	// The tool host under the node's wildcard domain (what the panel links
	// to), over HTTPS with Traefik's default certificate.
	router.SetSettings(&agentv1.NodeSettings{WildcardDomain: "n1.it.test"})
	if err := router.Verify(vctx, "bx1"); err != nil {
		t.Fatal(err)
	}
	toolHost := proxy.ToolHost(proxy.ToolBox, "bx1", "n1.it.test")
	jar2, _ := cookiejar.New(nil)
	tc := &http.Client{Jar: jar2, Timeout: 5 * time.Second, Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true, ServerName: toolHost},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, fmt.Sprintf("127.0.0.1:%d", tlsPort))
		},
	}}
	ticket2 := SignTicket(priv, "box:bx1", "u1", "", "it-2", time.Now().Add(time.Minute))
	var lastErr error
	for range 20 {
		resp, err = tc.Get("https://" + toolHost + proxy.TicketPath + "?t=" + url.QueryEscape(ticket2))
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == 200 && strings.Contains(string(b), "Name: box") {
				lastErr = nil
				break
			}
			lastErr = fmt.Errorf("%d %q", resp.StatusCode, b)
			break // the ticket is spent either way
		}
		lastErr = err
		time.Sleep(300 * time.Millisecond)
	}
	if lastErr != nil {
		t.Fatalf("tool host over https: %v", lastErr)
	}

	// Cookie handoff from an IP:port redirect lands on the domain through
	// Traefik with the visitor's Host.
	app := &agentv1.ServiceSpec{Id: "ap1", Ports: []*agentv1.PortSpec{{ContainerPort: 80, Public: &agentv1.PublicPort{Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_REDIRECT, RedirectUrl: "http://app.it.test"}}},
		Routing: &agentv1.Routing{Routes: []*agentv1.Route{{Id: "r1", Hosts: []string{"app.it.test"}, Https: agentv1.HttpsMode_HTTPS_MODE_OFF}}}}
	// Reconcile attaches Traefik to the project network of routed apps.
	if err := d.ConnectNetwork(ctx, projNet, cfg.Name); err != nil {
		t.Fatal(err)
	}
	if err := router.Apply(ctx, app, []proxy.Upstream{{URL: boxAddr}}); err != nil {
		t.Fatal(err)
	}
	if err := router.Verify(vctx, "ap1"); err != nil {
		t.Fatal(err)
	}
	token := srv.Handoffs().Put("app.it.test", "/after?x=1", []*http.Cookie{{Name: "sid", Value: "s3"}})
	hreq, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s?t=%s", httpPort, proxy.HandoffPath, token), nil)
	hreq.Host = "app.it.test"
	hresp, err := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(hreq)
	if err != nil {
		t.Fatal(err)
	}
	_ = hresp.Body.Close()
	if hresp.Header.Get("Location") != "/after?x=1" || !strings.Contains(hresp.Header.Get("Set-Cookie"), "sid=s3") {
		t.Fatalf("handoff through Traefik: %d %v", hresp.StatusCode, hresp.Header)
	}
}

// freePort asks the kernel for a free port (the VM is shared, so a random
// pick can collide).
func freePort() int {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		panic(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
