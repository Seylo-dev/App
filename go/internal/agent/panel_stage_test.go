package agent

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/registry"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/update"
)

const stageMove = "mv00000000000001"

// stageSetup is moveSetup with the staging handlers and a short wait
// before the staged address is dialed.
func stageSetup(t *testing.T, keepLoopback bool) {
	t.Helper()
	moveSetup(t, keepLoopback)
	saved := stagedAfter
	t.Cleanup(func() { stagedAfter = saved })
	stagedAfter = 50 * time.Millisecond
	owners = append(owners, owner{"test-stage", func(*Deps) error { return nil }, func(reg *Registry, d *Deps) error {
		// All nine, or panel.relocate.v1 is not advertised and the panel never calls.
		registerPanelMove(reg, d, update.NewPanelMover(update.MoveOptions{DataDir: d.Layout.Root()}, nil))
		return nil
	}})
}

// movedPanel is the same panel at another address, as a move leaves it:
// the panel id, the identity key and the node's key are the old panel's;
// its TLS key is its own here (the real move ships the old one; the pin
// is whatever StagePanelAddress names).
func movedPanel(t *testing.T, from *rpctest.FakePanel, nodeID string) *rpctest.FakePanel {
	t.Helper()
	to := rpctest.NewFakePanel(t, rpctest.WithTLS())
	to.PanelID, to.EdgeKey, to.EdgePrivate = from.PanelID, from.EdgeKey, from.EdgePrivate
	to.AddNode(nodeID, from.NodeKey(nodeID))
	return to
}

func stage(t *testing.T, panel *rpctest.FakePanel, nodeID string, req *agentv1.StagePanelAddressRequest) (*agentv1.StagePanelAddressResponse, error) {
	t.Helper()
	var res agentv1.StagePanelAddressResponse
	err := panel.Session(nodeID).Call(context.Background(), "StagePanelAddress", req, &res)
	return &res, err
}

// retire closes the old panel's listener and its sessions, as RetirePanel
// does: connects there fail from now on.
func retire(panel *rpctest.FakePanel) {
	panel.Server.Close()
	panel.DropConnections()
}

// A node pinned to the old panel's address fails over to the staged one
// once the old panel goes away, and forgets the old address for good.
func TestStagedAddressTakesOverWhenThePanelGoesAway(t *testing.T) {
	stageSetup(t, false)
	old := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout := joined(t, old)
	a := startDaemon(t, layout)
	nodeID := old.WaitConnected("")
	moved := movedPanel(t, old, nodeID)
	pin := conn.FormatPin(moved.SPKI())

	if _, err := stage(t, old, nodeID, &agentv1.StagePanelAddressRequest{MoveId: stageMove, PanelUrl: moved.URL(), PanelPin: pin, Probe: true}); err != nil {
		t.Fatal(err)
	}
	cfg := loadCfg(t, layout)
	if cfg.Staged == nil || cfg.Staged.PanelURL != moved.URL() || cfg.Staged.PanelPin != pin || cfg.StagedMove != stageMove {
		t.Fatalf("staged = %+v (%q)", cfg.Staged, cfg.StagedMove)
	}
	// Reconnects to the old panel keep it: the move is not over until the
	// old panel goes.
	old.DropConnections()
	old.WaitConnected(nodeID)
	if cfg := loadCfg(t, layout); cfg.Staged == nil || cfg.PanelURL != old.URL() {
		t.Fatalf("config after a reconnect = %+v", cfg)
	}
	if hosts := moved.AcceptedHosts(); len(hosts) != 0 {
		t.Fatalf("the moved panel got %v before the old one went", hosts)
	}

	retire(old)
	moved.WaitConnected(nodeID)
	waitUntil(t, "the staged address as panel_url", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == moved.URL() && cfg.PanelPin == pin && cfg.Staged == nil && cfg.StagedMove == "" && cfg.Fallback == nil
	})
	if u, p := a.d.deps.PanelAddress(); u != moved.URL() || p != pin {
		t.Fatalf("PanelAddress = %q %q", u, p)
	}
	if alerts := moveAlerts(moved); len(alerts) != 0 {
		t.Fatalf("move alerts = %v, want none", alerts)
	}
	// The next connect goes straight to the new address.
	moved.DropConnections()
	moved.WaitConnected(nodeID)
	if hosts := moved.AcceptedHosts(); len(hosts) != 2 {
		t.Fatalf("accepted at the new address: %v", hosts)
	}
}

// The panel's own node dials loopback over plain HTTP and never moves
// otherwise: it leaves through the staged address too.
func TestLoopbackPanelNodeLeavesThroughTheStagedAddress(t *testing.T) {
	stageSetup(t, true)
	old := rpctest.NewFakePanel(t)
	layout := joined(t, old)
	startDaemon(t, layout)
	nodeID := old.WaitConnected("")
	moved := movedPanel(t, old, nodeID)
	pin := conn.FormatPin(moved.SPKI())
	if _, err := stage(t, old, nodeID, &agentv1.StagePanelAddressRequest{MoveId: stageMove, PanelUrl: moved.URL(), PanelPin: pin, Probe: true}); err != nil {
		t.Fatalf("staging over loopback: %v", err)
	}
	retire(old)
	moved.WaitConnected(nodeID)
	waitUntil(t, "the moved panel as panel_url", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == moved.URL() && cfg.PanelPin == pin && !cfg.InsecureTransport && cfg.Staged == nil
	})
}

// A refusal from the old panel is not "gone": the staged address waits.
func TestStagedAddressIsNotDialedAfterARefusal(t *testing.T) {
	stageSetup(t, false)
	old := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout := joined(t, old)
	startDaemon(t, layout)
	nodeID := old.WaitConnected("")
	moved := movedPanel(t, old, nodeID)
	if _, err := stage(t, old, nodeID, &agentv1.StagePanelAddressRequest{MoveId: stageMove, PanelUrl: moved.URL(), PanelPin: conn.FormatPin(moved.SPKI())}); err != nil {
		t.Fatal(err)
	}
	old.RefuseAgentsOlderThan("99.0.0")
	old.DropConnections()
	old.WaitRejected(2)
	time.Sleep(300 * time.Millisecond)
	if hellos := moved.Hellos(); len(hellos) != 0 {
		t.Fatalf("the staged address got %d hellos after a refusal", len(hellos))
	}
	if cfg := loadCfg(t, layout); cfg.PanelURL != old.URL() || cfg.Staged == nil {
		t.Fatalf("config = %+v", cfg)
	}
}

// A staged address that answers as another panel is never taken: the node
// signs nothing for it and keeps its address.
func TestStagedAddressOfAnotherPanelIsNotTaken(t *testing.T) {
	stageSetup(t, false)
	old := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout := joined(t, old)
	a := startDaemon(t, layout)
	nodeID := old.WaitConnected("")
	other := movedPanel(t, old, nodeID)
	other.PanelID = "otherpanel"
	if _, err := stage(t, old, nodeID, &agentv1.StagePanelAddressRequest{MoveId: stageMove, PanelUrl: other.URL(), PanelPin: conn.FormatPin(other.SPKI())}); err != nil {
		t.Fatal(err)
	}
	retire(old)
	waitUntil(t, "the refused staged address", func() bool {
		st, _ := a.d.conn.status.snapshot()
		return strings.Contains(st.LastError, errOtherPanel.Error())
	})
	if hellos := other.Hellos(); len(hellos) != 0 {
		t.Fatalf("the other panel got hellos %v", hellos)
	}
	cfg := loadCfg(t, layout)
	if cfg.PanelURL != old.URL() || cfg.Staged == nil || cfg.Staged.PanelURL != other.URL() {
		t.Fatalf("config = %+v", cfg)
	}
}

// ImportPanelData, ImportRegistry, StartMovedPanel and CommitMovedPanel
// ship the panel's keys or switch the nodes: refused over a plain-HTTP
// session from another host, like StagePanelAddress. Loopback is the
// panel's own node.
func TestMoveStepsRefusedOverPlainHTTP(t *testing.T) {
	ctx := context.Background()
	for session, plain := range map[string]bool{
		"http://10.0.0.1:3000":   true,
		"ws://panel.example.com": true,
		"":                       true,
		"http://127.0.0.1:3000":  false,
		"https://10.0.0.1:3443":  false,
	} {
		reg := newRegistry()
		registerPanelMove(reg, &Deps{PanelStage: stageConnector(t, session)}, update.NewPanelMover(update.MoveOptions{DataDir: t.TempDir()}, nil))
		panel := rpctest.NewPeer(t, reg)
		calls := map[string]error{
			"StartMovedPanel":  panel.Call(ctx, "StartMovedPanel", &agentv1.StartMovedPanelRequest{MoveId: stageMove}, &agentv1.StartMovedPanelResponse{}),
			"CommitMovedPanel": panel.Call(ctx, "CommitMovedPanel", &agentv1.CommitMovedPanelRequest{MoveId: stageMove}, &agentv1.CommitMovedPanelResponse{}),
		}
		s, err := panel.Open(ctx, "ImportPanelData", &agentv1.ImportPanelDataRequest{MoveId: stageMove})
		if err != nil {
			t.Fatal(err)
		}
		_ = s.CloseSend()
		calls["ImportPanelData"] = s.Finish(nil)
		s, err = panel.Open(ctx, "ImportRegistry", &agentv1.ImportRegistryRequest{MoveId: stageMove})
		if err != nil {
			t.Fatal(err)
		}
		_ = s.CloseSend()
		calls["ImportRegistry"] = s.Finish(nil)
		for method, err := range calls {
			st := rpc.StatusOf(err)
			refused := st.GetCode() == agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION && detailsReason(err) == reasonPlainHTTP
			if refused != plain {
				t.Errorf("session %q, %s: %v", session, method, st)
			}
		}
	}
}

// stageConnector is a connector with a config.yml, for the handler rules.
func stageConnector(t *testing.T, session string) *connector {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yml")
	cfg := &FileConfig{PanelURL: "https://198.51.100.4:3443", PanelPin: conn.FormatPin(make([]byte, 32)), NodeID: "n1"}
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	return &connector{cfg: cfg, cfgPath: path, deps: &Deps{}, logger: slog.New(slog.DiscardHandler), sessionURL: session}
}

func detailsReason(err error) string {
	return rpc.StatusOf(err).GetDetails()["reason"]
}

func TestStagePanelAddressRules(t *testing.T) {
	pin := conn.FormatPin(make([]byte, 32))
	ctx := context.Background()
	good := &agentv1.StagePanelAddressRequest{MoveId: stageMove, PanelUrl: "https://203.0.113.7:3443", PanelPin: pin}

	for _, session := range []string{"http://10.0.0.1:3000", "ws://panel.example.com", ""} {
		c := stageConnector(t, session)
		_, err := c.StagePanelAddress(ctx, good)
		if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION || detailsReason(err) != reasonPlainHTTP {
			t.Errorf("session %q: %v", session, s)
		}
		if loadCfgAt(t, c.cfgPath).Staged != nil {
			t.Errorf("session %q staged an address", session)
		}
	}
	for name, req := range map[string]*agentv1.StagePanelAddressRequest{
		"http":     {MoveId: stageMove, PanelUrl: "http://203.0.113.7:3000", PanelPin: pin},
		"path":     {MoveId: stageMove, PanelUrl: "https://203.0.113.7:3443/x", PanelPin: pin},
		"user":     {MoveId: stageMove, PanelUrl: "https://u:p@203.0.113.7:3443", PanelPin: pin},
		"query":    {MoveId: stageMove, PanelUrl: "https://203.0.113.7:3443?a=b", PanelPin: pin},
		"no host":  {MoveId: stageMove, PanelUrl: "https://", PanelPin: pin},
		"no pin":   {MoveId: stageMove, PanelUrl: "https://203.0.113.7:3443"},
		"bad pin":  {MoveId: stageMove, PanelUrl: "https://203.0.113.7:3443", PanelPin: "sha256:zz"},
		"bad move": {MoveId: "../x", PanelUrl: "https://203.0.113.7:3443", PanelPin: pin},
	} {
		c := stageConnector(t, "https://198.51.100.4:3443")
		if _, err := c.StagePanelAddress(ctx, req); rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
			t.Errorf("%s: %v", name, rpc.StatusOf(err))
		}
	}

	// Loopback over plain HTTP is the panel's own node: fine.
	c := stageConnector(t, "http://127.0.0.1:3000")
	if _, err := c.StagePanelAddress(ctx, good); err != nil {
		t.Fatal(err)
	}
	got := loadCfgAt(t, c.cfgPath)
	if got.Staged == nil || got.Staged.PanelURL != "https://203.0.113.7:3443" || got.Staged.PanelPin != pin || got.StagedMove != stageMove {
		t.Fatalf("config = %+v (%+v)", got, got.Staged)
	}
	// Another move's clear keeps it; its own clears it.
	if err := c.ClearPanelAddress(ctx, &agentv1.ClearPanelAddressRequest{MoveId: "mv00000000000002"}); err != nil {
		t.Fatal(err)
	}
	if loadCfgAt(t, c.cfgPath).Staged == nil {
		t.Fatal("another move's clear dropped the staged address")
	}
	if err := c.ClearPanelAddress(ctx, &agentv1.ClearPanelAddressRequest{MoveId: stageMove}); err != nil {
		t.Fatal(err)
	}
	if got := loadCfgAt(t, c.cfgPath); got.Staged != nil || got.StagedMove != "" || got.PanelURL != "https://198.51.100.4:3443" {
		t.Fatalf("config after the clear = %+v", got)
	}
}

func TestStagePanelAddressProbe(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	defer srv.Close()
	pin := conn.FormatPin(conn.SPKIFingerprint(srv.Certificate()))

	c := stageConnector(t, "https://198.51.100.4:3443")
	res, err := c.StagePanelAddress(ctx, &agentv1.StagePanelAddressRequest{MoveId: stageMove, PanelUrl: srv.URL, PanelPin: pin, Probe: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.GetProbeMillis() > 10000 {
		t.Fatalf("probe took %d ms", res.GetProbeMillis())
	}
	if got := loadCfgAt(t, c.cfgPath); got.Staged == nil || got.Staged.PanelURL != srv.URL {
		t.Fatalf("not staged: %+v", got)
	}

	// Another key at that address, or nothing listening: refused, nothing staged.
	c = stageConnector(t, "https://198.51.100.4:3443")
	_, err = c.StagePanelAddress(ctx, &agentv1.StagePanelAddressRequest{MoveId: stageMove, PanelUrl: srv.URL, PanelPin: conn.FormatPin(make([]byte, 32)), Probe: true})
	if detailsReason(err) != reasonProbe || !strings.Contains(rpc.StatusOf(err).GetMessage(), "another key") {
		t.Fatalf("wrong pin: %v", rpc.StatusOf(err))
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := "https://" + l.Addr().String()
	l.Close()
	_, err = c.StagePanelAddress(ctx, &agentv1.StagePanelAddressRequest{MoveId: stageMove, PanelUrl: closed, PanelPin: pin, Probe: true})
	if detailsReason(err) != reasonProbe {
		t.Fatalf("closed port: %v", rpc.StatusOf(err))
	}
	if loadCfgAt(t, c.cfgPath).Staged != nil {
		t.Fatal("a failed probe staged the address")
	}
}

type arrivals struct {
	mu  sync.Mutex
	ids []string
}

func (a *arrivals) PanelArrived(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ids = append(a.ids, id)
}

// The update.Updater methods a fake needs to sit in Deps.Updater.
func (a *arrivals) UpdateAgent(context.Context, *agentv1.UpdateAgentRequest) error { return nil }
func (a *arrivals) UpdatePanel(context.Context, *agentv1.UpdatePanelRequest) error { return nil }
func (a *arrivals) UpdateDocker(context.Context, *agentv1.UpdateDockerRequest) (*agentv1.UpdateDockerResponse, error) {
	return nil, nil
}
func (a *arrivals) Reboot(context.Context, time.Duration) error { return nil }
func (a *arrivals) Busy() string                                { return "" }

func TestPromoteStagedForgetsTheOldPanel(t *testing.T) {
	pin := conn.FormatPin(make([]byte, 32))
	c := stageConnector(t, "https://198.51.100.4:3443")
	arr := &arrivals{}
	c.deps.Updater = arr
	c.cfg.Fallback = &PanelAddress{PanelURL: "https://panel.example.com", Standing: true}
	c.cfg.Staged, c.cfg.StagedMove = &PanelAddress{PanelURL: "https://127.0.0.1:3443", PanelPin: pin}, stageMove
	c.cfg.InsecureTransport, c.cfg.TrustOnFirstUse = true, true
	c.promoteStaged(stagedTarget(*c.cfg))
	got := loadCfgAt(t, c.cfgPath)
	if got.PanelURL != "https://127.0.0.1:3443" || got.PanelPin != pin || got.Fallback != nil || got.Staged != nil || got.StagedMove != "" ||
		got.InsecureTransport || got.TrustOnFirstUse || got.NodeID != "n1" {
		t.Fatalf("config = %+v", got)
	}
	if !slices.Equal(arr.ids, []string{stageMove}) {
		t.Fatalf("arrivals = %v", arr.ids)
	}
}

func TestStagedAddressTiming(t *testing.T) {
	saved := stagedAfter
	t.Cleanup(func() { stagedAfter = saved })
	stagedAfter = time.Hour
	pin := conn.FormatPin(make([]byte, 32))
	cfg := FileConfig{
		Staged:   &PanelAddress{PanelURL: "https://203.0.113.7:3443", PanelPin: pin},
		Fallback: &PanelAddress{PanelURL: "https://10.0.0.1:3443", PanelPin: pin},
	}
	c := &connector{}
	c.primaryFailed(cfg)
	if c.useStaged || !c.useFallback {
		t.Fatalf("first failure: staged %v, fallback %v; the first-cycle fallback goes first", c.useStaged, c.useFallback)
	}
	c.useFallback = false
	c.primaryDown = time.Now().Add(-2 * time.Hour)
	c.primaryFailed(cfg)
	if !c.useStaged || c.useFallback {
		t.Fatalf("after stagedAfter: staged %v, fallback %v", c.useStaged, c.useFallback)
	}
}

func TestConfigStagedValidated(t *testing.T) {
	pin := conn.FormatPin(make([]byte, 32))
	ok := FileConfig{PanelURL: "https://panel.example.com", NodeID: "n1", Staged: &PanelAddress{PanelURL: "https://10.0.0.2:3443", PanelPin: pin}, StagedMove: stageMove}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, st := range []*PanelAddress{
		{PanelURL: "http://10.0.0.2:3000", PanelPin: pin},
		{PanelURL: "https://10.0.0.2:3443"},
		{PanelURL: "https://10.0.0.2:3443", PanelPin: "sha256:zz"},
	} {
		bad := ok
		bad.Staged = st
		if err := bad.Validate(); err == nil {
			t.Errorf("staged %+v passed", st)
		}
	}
}

func TestPanelMoveWiring(t *testing.T) {
	t.Setenv(updatePublicKeyEnv, testReleaseKey)
	d, _ := newTestDeps(t)
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(reg.Capabilities(), "panel.relocate.v1") {
		t.Fatalf("panel.relocate.v1 not advertised: %v", reg.Capabilities())
	}
	panel := rpctest.NewPeer(t, reg)
	ctx := context.Background()
	// Without the connector the staging is unavailable, not faked, and so
	// are the steps that need to know the session.
	err = panel.Call(ctx, "StagePanelAddress", &agentv1.StagePanelAddressRequest{MoveId: stageMove}, &agentv1.StagePanelAddressResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
		t.Fatalf("StagePanelAddress = %v", s)
	}
	err = panel.Call(ctx, "CommitMovedPanel", &agentv1.CommitMovedPanelRequest{MoveId: stageMove}, &agentv1.CommitMovedPanelResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
		t.Fatalf("CommitMovedPanel = %v", s)
	}
	// Refusals carry their reason.
	err = panel.Call(ctx, "RemoveOldPanel", &agentv1.RemoveOldPanelRequest{ServiceId: "app0000000000000"}, &agentv1.RemoveOldPanelResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT || s.GetDetails()["reason"] != update.ReasonBadRequest {
		t.Fatalf("RemoveOldPanel = %v", s)
	}
	// Nothing of a move here: an abort has nothing to do.
	if err := panel.Call(ctx, "AbortMovedPanel", &agentv1.AbortMovedPanelRequest{MoveId: stageMove}, &agentv1.AbortMovedPanelResponse{}); err != nil {
		t.Fatalf("AbortMovedPanel = %v", err)
	}
}

func TestMoveStatus(t *testing.T) {
	err := moveStatus(&update.MoveError{Code: agentv1.StatusCode_STATUS_CODE_RESOURCE_EXHAUSTED, Reason: update.ReasonNoSpace, Err: errors.New("no room")})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_RESOURCE_EXHAUSTED || s.GetMessage() != "no room" || s.GetDetails()["reason"] != update.ReasonNoSpace {
		t.Fatalf("status = %v", s)
	}
	if s := rpc.StatusOf(moveStatus(update.ErrBusy)); s.GetCode() != agentv1.StatusCode_STATUS_CODE_ABORTED {
		t.Fatalf("busy = %v", s)
	}
}

// `seylo panel start` never starts the copy a move retired here.
func TestPanelStartRefusesARetiredCopy(t *testing.T) {
	t.Setenv(updatePublicKeyEnv, testReleaseKey)
	d, _ := newTestDeps(t)
	if _, err := Wire(d); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(d.Layout.Root(), "update", "panel-retire.json")
	if err := os.MkdirAll(filepath.Dir(journal), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(journal, []byte(`{"moveId":"`+stageMove+`","serviceId":"panel00000000000","phase":"retired"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	err := d.PanelControl.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "moved to another node") {
		t.Fatalf("start = %v", err)
	}
}

func TestMoveHostFindsThePanelAndTheRegistry(t *testing.T) {
	eng := dockertest.New()
	d := &Deps{Docker: eng}
	panelLabels := map[string]string{docker.LabelManaged: "true", docker.LabelService: docker.PanelServiceID, docker.LabelProtected: "true"}
	running := eng.AddContainer(docker.ContainerSpec{Name: "seylo-panel00000000000-5", Labels: panelLabels}, true)
	stopped := eng.AddContainer(docker.ContainerSpec{Name: "seylo-panel00000000000-4", Labels: panelLabels}, false)
	// Not the protected panel: an app that reuses the id, and the registry.
	eng.AddContainer(docker.ContainerSpec{Name: "x", Labels: map[string]string{docker.LabelManaged: "true", docker.LabelService: docker.PanelServiceID}}, true)
	reg := eng.AddContainer(docker.ContainerSpec{Name: registry.ContainerName, Labels: map[string]string{docker.LabelManaged: "true", docker.LabelRole: registry.RoleRegistry, docker.LabelProtected: "true"}}, true)
	h := moveHost(d)
	ctx := context.Background()
	list, err := h.PanelContainers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	slices.SortFunc(list, func(a, b update.PanelContainer) int { return strings.Compare(a.Name, b.Name) })
	if len(list) != 2 || list[0].ID != stopped || list[0].Running || list[1].ID != running || !list[1].Running {
		t.Fatalf("panel containers = %+v", list)
	}
	if err := h.StopRegistry(ctx); err != nil {
		t.Fatal(err)
	}
	if c, _ := eng.Get(reg); c.Running {
		t.Fatal("the registry still runs")
	}
	if err := h.RemoveContainer(ctx, running); err != nil {
		t.Fatal(err)
	}
	if _, ok := eng.Get(running); ok {
		t.Fatal("the container is still there")
	}
	if err := h.RemoveRegistry(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := eng.Get(reg); ok {
		t.Fatal("the registry container is still there")
	}
}
