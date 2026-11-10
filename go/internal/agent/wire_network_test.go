package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/edge"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/reconcile"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

func TestWireNetworkProvidesAndFollows(t *testing.T) {
	d, _ := newTestDeps(t)
	if err := provideNetwork(d); err != nil {
		t.Fatal(err)
	}
	if d.Router == nil || d.Gate == nil || d.Tickets == nil || d.Wings == nil || d.CPU == nil {
		t.Fatalf("missing components: %+v", d)
	}
	if _, ok := d.Gate.(interface{ Tools() edge.Tools }); !ok {
		t.Fatal("the edge tool registry is not reachable")
	}
	if err := wireNetwork(newRegistry(), d); err != nil {
		t.Fatal(err)
	}

	// The handshake hands the edge ticket key to the verifier.
	pub, priv, _ := ed25519.GenerateKey(nil)
	d.Components.connected(context.Background(), ConnInfo{NodeID: "node1", EdgeTicketPublicKey: pub})
	ticket := edge.SignTicket(priv, "box:b1", "u1", "node1", "j1", time.Now().Add(time.Minute))
	if _, err := d.Tickets.Verify(ticket, "box:b1"); err != nil {
		t.Fatalf("ticket after connect: %v", err)
	}

	// Run the desired-state follower.
	var follow func(context.Context) error
	for _, c := range d.Components.List() {
		if c.Name == "network-follow" {
			follow = c.Run
		}
	}
	if follow == nil {
		t.Fatal("no network-follow component")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- follow(ctx) }()

	// A route file from an older run, of a service that is gone.
	p := d.Gate.(*networkParts)
	dir := p.router.Dir()
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(filepath.Join(dir, "seylo-gone.yml"), []byte("http: {}\n"), 0o600)

	spec := &agentv1.ServiceSpec{Id: "svc1", ProjectId: "p1", Routing: &agentv1.Routing{
		Routes:      []*agentv1.Route{{Id: "r1", Hosts: []string{"a.example.com"}}},
		Maintenance: &agentv1.Maintenance{Enabled: true, Html: "<p>back soon</p>"},
	}}
	d.Feed.Publish(&agentv1.DesiredState{Revision: 3, Services: []*agentv1.ServiceSpec{spec}})

	netWaitFor(t, func() bool {
		rec := httptest.NewRecorder()
		p.edge.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, proxy.MaintenancePath+"/svc1", nil))
		return rec.Body.String() == "<p>back soon</p>"
	})
	netWaitFor(t, func() bool {
		_, err := os.Stat(filepath.Join(dir, "seylo-gone.yml"))
		return os.IsNotExist(err)
	})
	if got := projectNetworks(d.Feed.Current()); len(got) != 1 || !strings.HasSuffix(got[0], "-p-p1") {
		t.Fatalf("project networks = %v", got)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHandoffLocation(t *testing.T) {
	h := edge.NewHandoffs()
	loc := handoffLocation(h)
	r := httptest.NewRequest(http.MethodGet, "http://203.0.113.5:31000/dash?x=1", nil)
	if got := loc(r, "https://app.example.com"); got != "https://app.example.com/dash?x=1" {
		t.Fatal(got)
	}
	r.AddCookie(&http.Cookie{Name: "sid", Value: "v"})
	got := loc(r, "https://app.example.com")
	if !strings.HasPrefix(got, "https://app.example.com"+proxy.HandoffPath+"?t=") {
		t.Fatal(got)
	}
	token := strings.TrimPrefix(got, "https://app.example.com"+proxy.HandoffPath+"?t=")
	cookies, to, ok := h.Take(token, "app.example.com")
	if !ok || to != "/dash?x=1" || len(cookies) != 1 || cookies[0].Value != "v" {
		t.Fatalf("%v %q %v", cookies, to, ok)
	}
}

func TestAcmeCA(t *testing.T) {
	if acmeCA("staging") != proxy.LetsEncryptStaging || acmeCA("") != "" || acmeCA("https://pebble:14000/dir") != "https://pebble:14000/dir" {
		t.Fatal("acmeCA")
	}
}

func netWaitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// resolverEngine answers Resolve like reconcile does; nothing else is used.
type resolverEngine struct {
	reconcile.Engine
	resolve func(ctx context.Context, serviceID string, port uint32) (string, error)
}

func (r resolverEngine) Resolve(ctx context.Context, serviceID string, port uint32) (string, error) {
	return r.resolve(ctx, serviceID, port)
}

// TestWireNetworkInVM runs the wired components against the VM's Docker:
// own Traefik, the edge listener on the edge network's gateway, the
// desired-state follower driving maintenance pages and the portgate. Test
// names and high ports only. Run with:
//
//	scripts/dev/vm-gotest.sh ./internal/agent -run TestWireNetworkInVM -v
func TestWireNetworkInVM(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	d, _ := newTestDeps(t)
	if err := provideNetwork(d); err != nil {
		t.Fatal(err)
	}
	p := d.Gate.(*networkParts)
	if p.moby == nil {
		t.Fatal("no docker client")
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	tag := hex.EncodeToString(b[:])
	prefix := "seylo-it-net-" + tag
	projectID := "it-net-" + tag
	projNet := docker.ProjectNetwork(projectID)
	labels := map[string]string{"seylo.test": prefix, docker.LabelManaged: "true"}
	httpPort := netFreePort()
	p.edgeNet, p.edgePort = prefix+"-edge", 0
	p.traefik.Name, p.traefik.Network = prefix+"-traefik", p.edgeNet
	p.traefik.HTTPPort, p.traefik.HTTPSPort, p.traefik.LBPort = uint16(httpPort), uint16(netFreePort()), uint16(netFreePort())
	p.traefik.ExtraLabels = labels
	p.traefik.CgroupParent = ""
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), time.Minute)
		defer ccancel()
		f := client.Filters{}
		f.Add("label", "seylo.test="+prefix)
		if list, err := p.moby.Client().ContainerList(cctx, client.ContainerListOptions{All: true, Filters: f}); err == nil {
			for _, c := range list.Items {
				_ = p.moby.RemoveContainer(cctx, c.ID)
			}
		}
		for _, n := range []string{projNet, p.edgeNet} {
			_, _ = p.moby.Client().NetworkRemove(cctx, n, client.NetworkRemoveOptions{})
		}
	})

	// The app container, as reconcile would run it.
	if _, err := p.moby.EnsureNetwork(ctx, projNet, labels); err != nil {
		t.Fatal(err)
	}
	if err := p.moby.EnsureImage(ctx, "traefik/whoami:v1.11.0"); err != nil {
		t.Fatal(err)
	}
	appName := prefix + "-app"
	id, err := p.moby.CreateContainer(ctx, proxy.ContainerSpec{Name: appName, Image: "traefik/whoami:v1.11.0", Cmd: []string{"-name", "vmapp"}, Labels: labels, Network: projNet})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.moby.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	d.Reconcile = resolverEngine{resolve: func(ctx context.Context, _ string, port uint32) (string, error) {
		info, err := p.moby.InspectContainer(ctx, id)
		if err != nil {
			return "", err
		}
		return net.JoinHostPort(info.IPs[projNet], strconv.Itoa(int(port))), nil
	}}

	if err := wireNetwork(newRegistry(), d); err != nil {
		t.Fatal(err)
	}
	cctx, ccancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	for _, c := range d.Components.List() {
		switch c.Name {
		case "edge-listener", "traefik", "network-follow", "wings-facts":
			wg.Go(func() {
				if err := c.Run(cctx); err != nil && cctx.Err() == nil {
					t.Errorf("%s: %v", c.Name, err)
				}
			})
		}
	}
	defer func() { ccancel(); wg.Wait() }()

	spec := &agentv1.ServiceSpec{Id: "vmsvc", ProjectId: projectID, Name: "web", Generation: 1,
		Ports: []*agentv1.PortSpec{{ContainerPort: 80, Public: &agentv1.PublicPort{}}},
		Routing: &agentv1.Routing{
			Routes:      []*agentv1.Route{{Id: "r1", Hosts: []string{"vm.it.test"}, TargetPort: 80, Https: agentv1.HttpsMode_HTTPS_MODE_OFF}},
			Maintenance: &agentv1.Maintenance{Html: "<p>vm maintenance</p>"},
		}}
	d.Feed.Publish(&agentv1.DesiredState{Revision: 1, Services: []*agentv1.ServiceSpec{spec}})

	// Reconcile's part: write the route, then verify through Traefik (the
	// probe address and the project network attach come from the traefik
	// component).
	if err := d.Router.Apply(ctx, spec, []proxy.Upstream{{URL: "http://" + appName + ":80"}}); err != nil {
		t.Fatal(err)
	}
	vctx, vcancel := context.WithTimeout(ctx, 60*time.Second)
	defer vcancel()
	if err := d.Router.Verify(vctx, "vmsvc"); err != nil {
		t.Fatal(err)
	}
	get := func(host string) (int, string) {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", httpPort), nil)
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	if code, body := get("vm.it.test"); code != 200 || !strings.Contains(body, "Name: vmapp") {
		t.Fatalf("through Traefik: %d %q", code, body)
	}

	// The first-run public port, opened by the follower from the spec.
	var port uint32
	netWaitFor(t, func() bool {
		ports := d.Gate.Ports("vmsvc")
		if len(ports) == 1 {
			port = ports[0].GetHostPort()
		}
		return port != 0
	})
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", port))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !strings.Contains(string(body), "Name: vmapp") {
		t.Fatalf("public port: %q", body)
	}

	// Maintenance on: the edge serves the service's page through Traefik.
	spec.Routing.Maintenance.Enabled = true
	d.Feed.Publish(&agentv1.DesiredState{Revision: 2, Services: []*agentv1.ServiceSpec{spec}})
	if err := d.Router.Apply(ctx, spec, []proxy.Upstream{{URL: "http://" + appName + ":80"}}); err != nil {
		t.Fatal(err)
	}
	if err := d.Router.Verify(vctx, "vmsvc"); err != nil {
		t.Fatal(err)
	}
	netWaitFor(t, func() bool {
		code, body := get("vm.it.test")
		return code == 503 && body == "<p>vm maintenance</p>"
	})
}

// netFreePort asks the kernel for a free port (the VM is shared, so a random
// pick can collide).
func netFreePort() int {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		panic(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// TestEdgeBridgeProblem: an edge network made before every creator passed
// docker.NetworkOptions has a br-<id> bridge; the agent says how to repair
// it, since the installer's firewall rule names the interface.
func TestEdgeBridgeProblem(t *testing.T) {
	if msg := edgeBridgeProblem(docker.EdgeNetwork, proxy.NetworkInfo{BridgeName: docker.EdgeNetwork}); msg != "" {
		t.Fatalf("named bridge: %q", msg)
	}
	msg := edgeBridgeProblem(docker.EdgeNetwork, proxy.NetworkInfo{})
	if !strings.Contains(msg, "docker network rm "+docker.EdgeNetwork) || !strings.Contains(msg, "ufw allow in on "+docker.EdgeNetwork) {
		t.Fatalf("br-<id> bridge: %q", msg)
	}
	// A name too long for an interface never gets a bridge name: nothing to say.
	if msg := edgeBridgeProblem("a-network-name-longer-than-15", proxy.NetworkInfo{}); msg != "" {
		t.Fatalf("long name: %q", msg)
	}
}

// The edge signs origin proofs with the node key the handshake uses, so
// the panel checks them against the key it stored at the join; the
// capability is advertised only with that key.
func TestWireNetworkOriginProof(t *testing.T) {
	d, _ := newTestDeps(t)
	if err := provideNetwork(d); err != nil {
		t.Fatal(err)
	}
	reg := newRegistry()
	if err := wireNetwork(reg, d); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(reg.Capabilities(), edge.OriginCapability) {
		t.Fatal("advertised without a node key")
	}

	pub, key, _ := ed25519.GenerateKey(nil)
	d, _ = newTestDeps(t)
	d.Identity = key
	if err := provideNetwork(d); err != nil {
		t.Fatal(err)
	}
	reg = newRegistry()
	if err := wireNetwork(reg, d); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(reg.Capabilities(), edge.OriginCapability) {
		t.Fatalf("capability not advertised: %v", reg.Capabilities())
	}
	challenge := "panel-challenge-0123456789"
	req := httptest.NewRequest(http.MethodGet, proxy.OriginPath+challenge, nil)
	req.Host = "shop.example.com"
	rec := httptest.NewRecorder()
	d.Gate.(*networkParts).edge.ServeHTTP(rec, req)
	sig, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(rec.Body.String()))
	if rec.Code != http.StatusOK || err != nil || !ed25519.Verify(pub, edge.OriginSignedBytes("shop.example.com", challenge), sig) {
		t.Fatalf("proof %d %q: %v", rec.Code, rec.Body.String(), err)
	}
}

// refreshEngine records Refresh calls; nothing else of reconcile is used.
type refreshEngine struct {
	reconcile.Engine
	refreshed chan string
}

func (r refreshEngine) Refresh(serviceID string) { r.refreshed <- serviceID }

func TestWireNetworkRetryCertificate(t *testing.T) {
	d, _ := newTestDeps(t)
	if err := provideNetwork(d); err != nil {
		t.Fatal(err)
	}
	engine := refreshEngine{refreshed: make(chan string, 4)}
	d.Reconcile = engine
	reg := newRegistry()
	if err := wireNetwork(reg, d); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(reg.Capabilities(), "routing.certificate-retry.v1") {
		t.Fatalf("capability not advertised: %v", reg.Capabilities())
	}
	ctx := context.Background()
	spec := &agentv1.ServiceSpec{Id: "svc1", ProjectId: "p1", Routing: &agentv1.Routing{Routes: []*agentv1.Route{
		{Id: "r1", Hosts: []string{"a.example.com"}, TargetPort: 3000, Https: agentv1.HttpsMode_HTTPS_MODE_ACME},
		{Id: "r2", Hosts: []string{"b.example.com"}, TargetPort: 3000, Https: agentv1.HttpsMode_HTTPS_MODE_OFF},
	}}}
	if err := d.Router.Apply(ctx, spec, []proxy.Upstream{{URL: "http://seylo-svc1-1:3000"}}); err != nil {
		t.Fatal(err)
	}
	panel := rpctest.NewPeer(t, reg)
	var resp agentv1.RetryCertificateResponse
	if err := panel.Call(ctx, "RetryCertificate", &agentv1.RetryCertificateRequest{ServiceId: "svc1", RouteId: "r1"}, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.GetStatus().GetState() != agentv1.RouteState_ROUTE_STATE_CERTIFICATE_PENDING || !slices.Equal(resp.GetHosts(), []string{"a.example.com"}) {
		t.Fatalf("response %v", &resp)
	}
	if got := <-engine.refreshed; got != "svc1" {
		t.Fatalf("refreshed %q", got)
	}
	data, err := os.ReadFile(filepath.Join(d.Gate.(*networkParts).router.Dir(), "seylo-svc1.yml"))
	if err != nil || !strings.Contains(string(data), "seylo-svc1-r-r1-c1:") {
		t.Fatalf("route file not renamed: %v\n%s", err, data)
	}
	code := func(err error) agentv1.StatusCode { return rpc.StatusOf(err).GetCode() }
	for _, tc := range []struct {
		req  *agentv1.RetryCertificateRequest
		want agentv1.StatusCode
	}{
		{&agentv1.RetryCertificateRequest{ServiceId: "svc1", RouteId: "nope"}, agentv1.StatusCode_STATUS_CODE_NOT_FOUND},
		{&agentv1.RetryCertificateRequest{ServiceId: "svc1", RouteId: "r2"}, agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION},
		{&agentv1.RetryCertificateRequest{ServiceId: "svc1"}, agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT},
	} {
		err := panel.Call(ctx, "RetryCertificate", tc.req, &agentv1.RetryCertificateResponse{})
		if code(err) != tc.want || rpc.StatusOf(err).GetMessage() == "" {
			t.Errorf("%v: %v, want %v", tc.req, err, tc.want)
		}
	}
}

// The edge asks the panel through PanelService.CheckEdgeAccess whether a
// tool session's user still has access (runtime-1).
func TestEdgeAccessAsksThePanel(t *testing.T) {
	mux := rpc.NewPanelMux()
	var asked []string
	rpc.HandleUnary(mux, rpc.MethodCheckEdgeAccess, func(_ context.Context, req *agentv1.CheckEdgeAccessRequest) (*agentv1.CheckEdgeAccessResponse, error) {
		asked = append(asked, req.GetSubject()+" "+req.GetUserId())
		return &agentv1.CheckEdgeAccessResponse{Allowed: req.GetUserId() == "u1"}, nil
	})
	d := &Deps{Panel: rpc.NewPanelClient(rpctest.NewPeer(t, mux))}
	check := edgeAccess(d)
	for uid, want := range map[string]bool{"u1": true, "u2": false} {
		got, err := check.CheckAccess(t.Context(), "box:b1", uid)
		if err != nil || got != want {
			t.Fatalf("%s: %v %v, want %v", uid, got, err, want)
		}
	}
	if len(asked) != 2 {
		t.Fatalf("asked %v", asked)
	}
	if edgeAccess(&Deps{}) != nil {
		t.Fatal("a checker without a panel client")
	}
}
