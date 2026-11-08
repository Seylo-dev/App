package agent

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/tailnet"
	"github.com/seylo-dev/app/go/internal/tailnet/tailnettest"
)

// Both tailnet capabilities are advertised once wiring is done, and
// tailnet.login.v1 only with both of its methods.
func TestTailnetCapabilities(t *testing.T) {
	d, _ := newTestDeps(t)
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	caps := d.Facts.Get().GetCapabilities()
	for _, name := range []string{"tailnet.login.v1", "tailnet.serve.v1"} {
		if !slices.Contains(caps, name) {
			t.Fatalf("%s not advertised: %v", name, caps)
		}
	}
	for _, m := range []string{"TailscaleLogin", "TailscaleSetDns"} {
		if _, ok := reg.Lookup(m); !ok {
			t.Fatalf("%s not registered", m)
		}
	}
	names := []string{}
	for _, c := range d.Components.List() {
		names = append(names, c.Name)
	}
	if !slices.Contains(names, "tailnet") {
		t.Fatalf("components = %v", names)
	}

	half := rpc.NewAgentMux()
	rpc.HandleUnary(half, "TailscaleLogin", func(context.Context, *agentv1.TailscaleLoginRequest) (*agentv1.TailscaleLoginResponse, error) {
		return &agentv1.TailscaleLoginResponse{}, nil
	})
	if slices.Contains(half.Capabilities(), "tailnet.login.v1") {
		t.Fatal("tailnet.login.v1 advertised with TailscaleSetDns missing")
	}
}

// tailnetDeps is newTestDeps with a data dir short enough for unix
// sockets and the agent pointed at a fake tailscaled.
func tailnetDeps(t *testing.T, f *tailnettest.Fake, noTailnet bool) (*Deps, *rpctest.Peer) {
	t.Helper()
	d, _ := newTestDeps(t)
	d.Layout = datadir.New(tailnettest.ShortDir(t))
	d.Config.TailscaleSocket = filepath.Join(tailnettest.ShortDir(t), "none.sock")
	if f != nil {
		d.Config.TailscaleSocket = f.Socket
	}
	d.Config.NoTailnet = noTailnet
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	return d, rpctest.NewPeer(t, reg)
}

func TestTailscaleLoginRPC(t *testing.T) {
	f := tailnettest.New(t, "status-needs-login", "prefs-fresh")
	f.Login("https://login.tailscale.com/a/0f1e2d3c4b5a", 0)
	d, panel := tailnetDeps(t, f, false)
	var resp agentv1.TailscaleLoginResponse
	if err := panel.Call(context.Background(), "TailscaleLogin", &agentv1.TailscaleLoginRequest{}, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.GetAuthUrl() != "https://login.tailscale.com/a/0f1e2d3c4b5a" || resp.GetInfo().GetBackendState() != "NeedsLogin" || resp.GetInfo().GetAcceptDns() {
		t.Fatalf("resp = %v", &resp)
	}
	if got := d.Facts.Get().GetTailscale(); got.GetBackendState() != "NeedsLogin" {
		t.Fatalf("facts = %v", got)
	}

	var dns agentv1.TailscaleSetDnsResponse
	if err := panel.Call(context.Background(), "TailscaleSetDns", &agentv1.TailscaleSetDnsRequest{AcceptDns: true}, &dns); err != nil {
		t.Fatal(err)
	}
	if !dns.GetInfo().GetAcceptDns() || f.Prefs()["CorpDNS"] != true {
		t.Fatalf("set dns = %v", &dns)
	}
}

func TestTailscaleRPCRefusals(t *testing.T) {
	ctx := context.Background()
	call := func(panel *rpctest.Peer, method string) agentv1.StatusCode {
		t.Helper()
		var err error
		if method == "TailscaleLogin" {
			err = panel.Call(ctx, method, &agentv1.TailscaleLoginRequest{}, &agentv1.TailscaleLoginResponse{})
		} else {
			err = panel.Call(ctx, method, &agentv1.TailscaleSetDnsRequest{}, &agentv1.TailscaleSetDnsResponse{})
		}
		return rpc.StatusOf(err).GetCode()
	}
	_, none := tailnetDeps(t, nil, false)
	for _, m := range []string{"TailscaleLogin", "TailscaleSetDns"} {
		if code := call(none, m); code != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
			t.Errorf("%s without tailscaled = %v, want UNAVAILABLE", m, code)
		}
	}
	running := tailnettest.New(t, "status-running", "prefs-signed-in")
	_, panel := tailnetDeps(t, running, false)
	if code := call(panel, "TailscaleLogin"); code != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION {
		t.Errorf("TailscaleLogin while Running = %v, want FAILED_PRECONDITION", code)
	}
	off := tailnettest.New(t, "status-needs-login", "prefs-fresh")
	_, panel = tailnetDeps(t, off, true)
	for _, m := range []string{"TailscaleLogin", "TailscaleSetDns"} {
		if code := call(panel, m); code != agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED {
			t.Errorf("%s with no_tailnet = %v, want PERMISSION_DENIED", m, code)
		}
	}
	if len(off.Writes()) != 0 {
		t.Fatalf("no_tailnet wrote %+v", off.Writes())
	}
	slow := tailnettest.New(t, "status-needs-login", "prefs-fresh") // no link ever comes
	_, panel = tailnetDeps(t, slow, false)
	cctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	err := panel.Call(cctx, "TailscaleLogin", &agentv1.TailscaleLoginRequest{}, &agentv1.TailscaleLoginResponse{})
	if code := rpc.StatusOf(err).GetCode(); code != agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED && code != agentv1.StatusCode_STATUS_CODE_CANCELLED {
		t.Errorf("TailscaleLogin without a link = %v", rpc.StatusOf(err))
	}
}

func panelDesired(rev uint64, serve bool) *agentv1.DesiredState {
	return &agentv1.DesiredState{
		Revision: rev,
		Settings: &agentv1.NodeSettings{Tailnet: &agentv1.TailnetServe{Panel: serve}},
		Services: []*agentv1.ServiceSpec{{Id: "panel00000000000", Name: PanelServiceName, Protected: true}},
	}
}

// The component follows NodeSettings.tailnet: on adds the entry and
// reports it in the facts, off removes it, without waiting for the tick.
func TestTailnetComponentFollowsTheDesiredState(t *testing.T) {
	f := tailnettest.New(t, "status-running", "prefs-signed-in")
	d, _ := tailnetDeps(t, f, false)
	sock := tailnet.PanelSocket(d.Layout.Root())
	if err := os.MkdirAll(filepath.Dir(sock), 0o700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}), ReadHeaderTimeout: time.Second}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	target, _ := tailnet.Targets(sock)

	var run func(context.Context) error
	for _, c := range d.Components.List() {
		if c.Name == "tailnet" {
			run = c.Run
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	waitUntil(t, "the first facts", func() bool { return d.Facts.Get().GetTailscale().GetBackendState() == "Running" })
	if d.Facts.Get().GetTailscale().GetServe() != nil || string(f.Serve()) != "null" {
		t.Fatalf("acted before a desired state: %v %s", d.Facts.Get().GetTailscale(), f.Serve())
	}

	d.Feed.Publish(panelDesired(1, true))
	waitUntil(t, "the entry", func() bool {
		return d.Facts.Get().GetTailscale().GetServe().GetState() == agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE
	})
	serve := d.Facts.Get().GetTailscale().GetServe()
	if serve.GetUrl() != "https://panel.tail1234.ts.net" || serve.GetProxy() != target || !serve.GetPanelAnswers() || !strings.Contains(string(f.Serve()), target) {
		t.Fatalf("serve = %v, config %s", serve, f.Serve())
	}

	d.Feed.Publish(panelDesired(2, false))
	waitUntil(t, "the entry removed", func() bool {
		return d.Facts.Get().GetTailscale().GetServe().GetState() == agentv1.TailnetServeState_TAILNET_SERVE_STATE_OFF
	})
	if strings.Contains(string(f.Serve()), target) {
		t.Fatalf("entry left after off: %s", f.Serve())
	}
}

func TestTailscaleSocketMustBeAbsolute(t *testing.T) {
	cfg := &FileConfig{PanelURL: "https://panel.example.com", NodeID: "n1", TailscaleSocket: "run/tailscaled.sock"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "tailscale_socket") {
		t.Fatalf("Validate = %v", err)
	}
	cfg.TailscaleSocket = "/run/tailscale/tailscaled.sock"
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}
