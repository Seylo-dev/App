package agent

import (
	"context"
	"crypto/x509"
	"log/slog"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// moveSetup is isolate plus move timing for tests. The fake panel listens
// on 127.0.0.1, which the agent treats as its own node, so loopback stays
// movable unless keepLoopback.
func moveSetup(t *testing.T, keepLoopback bool) {
	t.Helper()
	isolate(t)
	savedOwn, savedRoots, savedDelay, savedRetry, savedStanding := ownNodePanel, panelRoots, moveAttemptDelay, moveRetryAfter, standingFallbackAfter
	t.Cleanup(func() {
		ownNodePanel, panelRoots, moveAttemptDelay, moveRetryAfter, standingFallbackAfter = savedOwn, savedRoots, savedDelay, savedRetry, savedStanding
	})
	if !keepLoopback {
		ownNodePanel = func(string) bool { return false }
	}
	moveAttemptDelay = 20 * time.Millisecond
}

// trusting returns a root pool that trusts srv's certificate, like a node
// trusting a public CA.
func trusting(srv *httptest.Server) *x509.CertPool {
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	return roots
}

// joined writes config.yml for a node that joins panel with a fresh token
// (with its pin when the panel serves TLS).
func joined(t *testing.T, panel *rpctest.FakePanel) datadir.Layout {
	t.Helper()
	pin := ""
	if panel.Server.TLS != nil {
		pin = conn.FormatPin(panel.SPKI())
	}
	return joinedWithPin(t, panel, pin)
}

// joinedWithPin joins with this pin; without one an https:// panel is
// verified with panelRoots, like a domain with a public certificate.
func joinedWithPin(t *testing.T, panel *rpctest.FakePanel, pin string) datadir.Layout {
	t.Helper()
	panel.AddJoinToken("tok")
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tok", Pin: pin}); err != nil {
		t.Fatal(err)
	}
	return layout
}

func loadCfg(t *testing.T, layout datadir.Layout) *FileConfig {
	t.Helper()
	cfg, err := LoadConfig(layout.ConfigFile())
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func host(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Host
}

// moveAlerts returns the PANEL_MOVE_FAILED alerts the panel received.
func moveAlerts(panel *rpctest.FakePanel) []*agentv1.NodeAlert {
	var out []*agentv1.NodeAlert
	for _, r := range panel.Reports() {
		if a := r.Event.GetNodeAlert(); a.GetKind() == agentv1.NodeAlertKind_NODE_ALERT_KIND_PANEL_MOVE_FAILED {
			out = append(out, a)
		}
	}
	return out
}

// A node that joined at an unpinned https:// address moves to the domain
// and forgets the old address after the first reconnect there.
func TestMoveToPanelAddressThenDropFallback(t *testing.T) {
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain := panel.ServeTLS()
	// Both listeners serve httptest's certificate: these roots trust the
	// join address and the domain alike.
	panelRoots = trusting(domain)
	layout := joinedWithPin(t, panel, "")
	panel.SetPanelAddress(domain.URL, "")

	a := startDaemon(t, layout)
	waitUntil(t, "the move in config.yml", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == domain.URL && cfg.Fallback != nil
	})
	cfg := loadCfg(t, layout)
	if cfg.NodeID == "" || cfg.PanelPin != "" || cfg.Fallback.PanelURL != panel.URL() || cfg.JoinToken != "" {
		t.Fatalf("config after the move = %+v (fallback %+v)", cfg, cfg.Fallback)
	}
	nodeID := panel.WaitConnected(cfg.NodeID)
	hosts := panel.AcceptedHosts()
	if len(hosts) != 2 || hosts[0] != host(t, panel.URL()) || hosts[1] != host(t, domain.URL) {
		t.Fatalf("accepted connections = %v, want the join then the domain", hosts)
	}
	if u, _ := a.d.deps.PanelAddress(); u != domain.URL {
		t.Fatalf("PanelAddress = %q after the move", u)
	}
	waitUntil(t, "the resolved move alert", func() bool {
		alerts := moveAlerts(panel)
		return len(alerts) == 1 && alerts[0].GetResolved()
	})

	// A restart connects to the domain; that ends the fallback's cycle.
	a.stop(t)
	panel.WaitDisconnected(nodeID)
	startDaemon(t, layout)
	waitUntil(t, "the fallback dropped", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.Fallback == nil && cfg.PanelURL == domain.URL
	})
	hosts = panel.AcceptedHosts()
	if len(hosts) != 3 || hosts[2] != host(t, domain.URL) {
		t.Fatalf("accepted connections = %v, want the restart on the domain", hosts)
	}
}

func TestMoveWithPin(t *testing.T) {
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain := panel.ServeTLS()
	// No roots trust it: only the pin does.
	panelRoots = x509.NewCertPool()
	pin := conn.FormatPin(conn.SPKIFingerprint(domain.Certificate()))
	layout := joined(t, panel)
	panel.SetPanelAddress(domain.URL, pin)
	startDaemon(t, layout)
	waitUntil(t, "the pinned move", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == domain.URL && cfg.PanelPin == pin
	})
}

func TestMoveFailureKeepsOldAddress(t *testing.T) {
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain := panel.ServeTLS()
	panelRoots = x509.NewCertPool() // the domain's certificate is not trusted
	layout := joined(t, panel)
	panel.SetPanelAddress(domain.URL, "")

	startDaemon(t, layout)
	waitUntil(t, "the move alert", func() bool { return len(moveAlerts(panel)) > 0 })
	alert := moveAlerts(panel)[0]
	if alert.GetResolved() || alert.GetSeverity() != agentv1.AlertSeverity_ALERT_SEVERITY_WARNING ||
		!strings.Contains(alert.GetMessage(), domain.URL) || !strings.Contains(alert.GetMessage(), "certificate") {
		t.Fatalf("alert = %v", alert)
	}
	cfg := loadCfg(t, layout)
	if cfg.PanelURL != panel.URL() || cfg.Fallback != nil || cfg.NodeID == "" {
		t.Fatalf("config after a failed move = %+v", cfg)
	}
	panel.WaitConnected(cfg.NodeID)
	// The move waits for its retry: the node stays on the old address.
	time.Sleep(300 * time.Millisecond)
	hosts := panel.AcceptedHosts()
	if len(hosts) != 2 || hosts[0] != hosts[1] || hosts[1] != host(t, panel.URL()) {
		t.Fatalf("accepted connections = %v, want two on the old address", hosts)
	}
	if n := len(moveAlerts(panel)); n != 1 {
		t.Fatalf("%d move alerts, want 1", n)
	}
}

// moveAndRestart moves a node from panel to domain, stops the agent and
// returns the node id. With restart the agent connects to the domain once
// more first, which ends the fallback's cycle.
func moveAndRestart(t *testing.T, panel *rpctest.FakePanel, domain *httptest.Server, layout datadir.Layout, restart bool) string {
	t.Helper()
	panel.SetPanelAddress(domain.URL, "")
	a := startDaemon(t, layout)
	waitUntil(t, "the move", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == domain.URL && cfg.Fallback != nil
	})
	nodeID := loadCfg(t, layout).NodeID
	panel.WaitConnected(nodeID)
	a.stop(t)
	panel.WaitDisconnected(nodeID)
	if restart {
		a = startDaemon(t, layout)
		waitUntil(t, "the end of the fallback's cycle", func() bool {
			cfg, _ := LoadConfig(layout.ConfigFile())
			return cfg != nil && (cfg.Fallback == nil || cfg.Fallback.Standing)
		})
		panel.WaitConnected(nodeID)
		a.stop(t)
		panel.WaitDisconnected(nodeID)
	}
	return nodeID
}

// The domain stops answering in the move's first cycle: the next start
// tries it, then the pinned old address once, which works; the move from
// there fails, so the old address is panel_url again.
func TestMovedAddressFailsFallsBack(t *testing.T) {
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	layout := joined(t, panel)
	nodeID := moveAndRestart(t, panel, domain, layout, false)

	domain.Close()
	startDaemon(t, layout)
	waitUntil(t, "the old address back in config.yml", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == panel.URL() && cfg.PanelPin == conn.FormatPin(panel.SPKI()) && cfg.Fallback == nil
	})
	panel.WaitConnected(nodeID)
	waitUntil(t, "the move alert", func() bool {
		for _, a := range moveAlerts(panel) {
			if !a.GetResolved() && strings.Contains(a.GetMessage(), domain.URL) {
				return true
			}
		}
		return false
	})
}

// A node on plain HTTP never moves: anyone on the path of that session can
// write its HelloAccepted, and the ServerHello whose panel id the move would
// check. The node stays on its address, config.yml is untouched and no move
// is tried (otherwise plain-HTTP nodes could be handed to another panel).
func TestPlainSessionNeverMoves(t *testing.T) {
	moveSetup(t, false) // the fake panel's loopback address stands in for a remote http:// panel
	panel := rpctest.NewFakePanel(t)
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	layout := joined(t, panel)
	panel.SetPanelAddress(domain.URL, "")

	a := startDaemon(t, layout)
	nodeID := panel.WaitConnected("")
	// A second session names the domain again.
	panel.DropConnections()
	waitUntil(t, "the reconnect", func() bool { return len(panel.AcceptedHosts()) == 2 })
	time.Sleep(300 * time.Millisecond)
	hosts := panel.AcceptedHosts()
	if len(hosts) != 2 || hosts[0] != host(t, panel.URL()) || hosts[1] != host(t, panel.URL()) {
		t.Fatalf("accepted connections = %v, want two on the plain address and none on the domain", hosts)
	}
	cfg := loadCfg(t, layout)
	if cfg.PanelURL != panel.URL() || cfg.PanelPin != "" || cfg.Fallback != nil || cfg.NodeID != nodeID {
		t.Fatalf("config = %+v (fallback %+v): a plain session moved the node", cfg, cfg.Fallback)
	}
	if u, _ := a.d.deps.PanelAddress(); u != panel.URL() {
		t.Fatalf("PanelAddress = %q", u)
	}
	if alerts := moveAlerts(panel); len(alerts) != 0 {
		t.Fatalf("move alerts = %v, want none: no move was tried", alerts)
	}
}

// A plain http:// fallback (a config written by hand) carries the node
// while the domain is down, but its sessions never move the node and it is
// never written back as panel_url.
func TestPlainFallbackNeverMovesOrIsRestored(t *testing.T) {
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t)
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	layout := joined(t, panel)
	a := startDaemon(t, layout)
	nodeID := panel.WaitConnected("")
	waitUntil(t, "the node id in config.yml", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.NodeID == nodeID
	})
	a.stop(t)
	panel.WaitDisconnected(nodeID)
	cfg := loadCfg(t, layout)
	cfg.PanelURL, cfg.Fallback = domain.URL, &PanelAddress{PanelURL: panel.URL()}
	if err := SaveConfig(layout.ConfigFile(), cfg); err != nil {
		t.Fatal(err)
	}

	panel.SetPanelAddress(domain.URL, "")
	domain.Close()
	startDaemon(t, layout)
	waitUntil(t, "a session through the plain fallback", func() bool { return len(panel.AcceptedHosts()) == 2 })
	// The panel also names no address now: still no downgrade.
	panel.SetPanelAddress("", "")
	panel.DropConnections()
	waitUntil(t, "another session through the plain fallback", func() bool { return len(panel.AcceptedHosts()) == 3 })
	time.Sleep(300 * time.Millisecond)
	cfg = loadCfg(t, layout)
	if cfg.PanelURL != domain.URL || cfg.Fallback == nil || cfg.Fallback.PanelURL != panel.URL() || cfg.Fallback.Standing {
		t.Fatalf("config = %+v (fallback %+v): the plain fallback changed panel_url", cfg, cfg.Fallback)
	}
	if alerts := moveAlerts(panel); len(alerts) != 0 {
		t.Fatalf("move alerts = %v, want none: a plain session tried a move", alerts)
	}
}

// A panel_url that answers as another panel (a typo'd or hijacked domain
// serving another installation) is never taken, even when that panel
// would accept the node: the node signs nothing for it, stays, and the
// panel gets one alert with why.
func TestMoveToAnotherPanelFails(t *testing.T) {
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	other := rpctest.NewFakePanel(t, rpctest.WithTLS())
	other.PanelID = "otherpanel"
	panelRoots = x509.NewCertPool()
	layout := joined(t, panel)
	startDaemon(t, layout)
	nodeID := panel.WaitConnected("")
	// The other panel knows the node's key, so it would accept a resume:
	// only the panel id tells the two apart.
	other.AddNode(nodeID, panel.NodeKey(nodeID))
	panel.SetPanelAddress(other.URL(), conn.FormatPin(other.SPKI()))
	panel.DropConnections()

	waitUntil(t, "the move alert", func() bool { return len(moveAlerts(panel)) > 0 })
	alert := moveAlerts(panel)[0]
	if alert.GetResolved() || alert.GetSeverity() != agentv1.AlertSeverity_ALERT_SEVERITY_WARNING ||
		!strings.Contains(alert.GetMessage(), "answers as another panel") || !strings.Contains(alert.GetMessage(), other.URL()) {
		t.Fatalf("alert = %v", alert)
	}
	panel.WaitConnected(nodeID)
	time.Sleep(300 * time.Millisecond)
	if hosts, hellos := other.AcceptedHosts(), other.Hellos(); len(hosts) != 0 || len(hellos) != 0 {
		t.Fatalf("the other panel got hellos %v and accepted %v, want none: the node knows its panel id", hellos, hosts)
	}
	hosts := panel.AcceptedHosts()
	if len(hosts) != 3 {
		t.Fatalf("accepted connections = %v, want the join, the session naming the other panel and the return", hosts)
	}
	for _, h := range hosts {
		if h != host(t, panel.URL()) {
			t.Fatalf("accepted connections = %v, want all on the old address", hosts)
		}
	}
	cfg := loadCfg(t, layout)
	if cfg.PanelURL != panel.URL() || cfg.PanelPin != conn.FormatPin(panel.SPKI()) || cfg.Fallback != nil || cfg.NodeID != nodeID {
		t.Fatalf("config after the refused move = %+v (fallback %+v)", cfg, cfg.Fallback)
	}
	if n := len(moveAlerts(panel)); n != 1 {
		t.Fatalf("%d move alerts, want 1", n)
	}
}

// The panel can still hold the session the agent closed to move: the move
// retries ALREADY_CONNECTED moveAttemptDelay apart and goes through.
func TestMoveRidesOutAlreadyConnected(t *testing.T) {
	moveSetup(t, false)
	saved := moveAttempts
	t.Cleanup(func() { moveAttempts = saved })
	moveAttempts = 100 // 2 s at 20 ms apart, well past the hold
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	panel.HoldClosedSessions(300 * time.Millisecond)
	layout := joined(t, panel)
	panel.SetPanelAddress(domain.URL, "")
	startDaemon(t, layout)

	waitUntil(t, "the move", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == domain.URL
	})
	if rej := panel.WaitRejected(1); rej.GetReason() != agentv1.HelloRejectReason_HELLO_REJECT_REASON_ALREADY_CONNECTED {
		t.Fatalf("rejection = %v, want ALREADY_CONNECTED while the closed session was held", rej)
	}
	waitUntil(t, "the resolved move alert", func() bool {
		alerts := moveAlerts(panel)
		return len(alerts) == 1 && alerts[0].GetResolved()
	})
}

// ALREADY_CONNECTED past moveAttempts fails the move like any other answer:
// the node stays and says why.
func TestMoveGivesUpWhileAlreadyConnected(t *testing.T) {
	moveSetup(t, false)
	saved := moveAttempts
	t.Cleanup(func() { moveAttempts = saved })
	moveAttempts = 2
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	panel.HoldClosedSessions(500 * time.Millisecond)
	layout := joined(t, panel)
	panel.SetPanelAddress(domain.URL, "")
	startDaemon(t, layout)

	waitUntil(t, "the move alert", func() bool { return len(moveAlerts(panel)) > 0 })
	alert := moveAlerts(panel)[0]
	if alert.GetResolved() || !strings.Contains(alert.GetMessage(), "ALREADY_CONNECTED") || !strings.Contains(alert.GetMessage(), domain.URL) {
		t.Fatalf("alert = %v", alert)
	}
	if n := len(panel.Hellos()); n < 3 {
		t.Fatalf("%d hellos, want the join and both move attempts", n)
	}
	cfg := loadCfg(t, layout)
	if cfg.PanelURL != panel.URL() || cfg.PanelPin != conn.FormatPin(panel.SPKI()) || cfg.Fallback != nil {
		t.Fatalf("config after a failed move = %+v", cfg)
	}
}

// After the cycle a pinned old address stays as a standing fallback. When
// the panel's domain is removed, the node reaches the panel there after
// standingFallbackAfter and makes it panel_url again.
func TestPinnedFallbackStandsAfterDomainRemoved(t *testing.T) {
	moveSetup(t, false)
	standingFallbackAfter = 300 * time.Millisecond
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	layout := joined(t, panel)
	nodeID := moveAndRestart(t, panel, domain, layout, true)
	cfg := loadCfg(t, layout)
	if cfg.Fallback == nil || !cfg.Fallback.Standing || cfg.Fallback.PanelURL != panel.URL() || cfg.Fallback.PanelPin != conn.FormatPin(panel.SPKI()) {
		t.Fatalf("fallback after the cycle = %+v", cfg.Fallback)
	}

	panel.SetPanelAddress("", "")
	domain.Close()
	started := time.Now()
	startDaemon(t, layout)
	panel.WaitConnected(nodeID)
	if took := time.Since(started); took < standingFallbackAfter {
		t.Fatalf("the standing fallback was dialed after %s, before %s", took, standingFallbackAfter)
	}
	waitUntil(t, "the pinned address back as panel_url", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == panel.URL() && cfg.Fallback == nil
	})
}

func TestStandingFallbackTiming(t *testing.T) {
	saved := standingFallbackAfter
	t.Cleanup(func() { standingFallbackAfter = saved })
	standingFallbackAfter = time.Hour
	c := &connector{}
	cfg := FileConfig{Fallback: &PanelAddress{PanelURL: "https://10.0.0.1:3443", PanelPin: conn.FormatPin(make([]byte, 32)), Standing: true}}
	c.primaryFailed(cfg)
	if c.useFallback {
		t.Fatal("a standing fallback was used after one failure")
	}
	c.primaryDown = time.Now().Add(-2 * time.Hour)
	c.primaryFailed(cfg)
	if !c.useFallback {
		t.Fatal("the standing fallback was not used after an hour of failures")
	}
	c.useFallback = false
	c.primaryFailed(cfg)
	if c.useFallback {
		t.Fatal("the standing fallback was dialed again right away")
	}
	cfg.Fallback.Standing = false
	c.primaryFailed(cfg)
	if !c.useFallback {
		t.Fatal("a first-cycle fallback was not used at once")
	}
}

// Moving from one domain to the next keeps the pinned address from before.
func TestMovedKeepsPinnedFallback(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yml")
	pin := conn.FormatPin(make([]byte, 32))
	cfg := &FileConfig{PanelURL: "https://one.example.com", NodeID: "n1",
		Fallback: &PanelAddress{PanelURL: "https://10.0.0.1:3443", PanelPin: pin, Standing: true}}
	c := &connector{cfg: cfg, cfgPath: path, deps: &Deps{}, logger: slog.New(slog.DiscardHandler)}
	c.moved(context.Background(), panelTarget{url: "https://one.example.com"}, panelTarget{url: "https://two.example.com"})
	got := loadCfgAt(t, path)
	if got.PanelURL != "https://two.example.com" || got.Fallback == nil || got.Fallback.PanelURL != "https://10.0.0.1:3443" || got.Fallback.Standing {
		t.Fatalf("config = %+v (fallback %+v)", got, got.Fallback)
	}
	// From a pinned address the pinned address itself is the fallback.
	c.moved(context.Background(), panelTarget{url: "https://10.0.0.2:3443", pin: pin}, panelTarget{url: "https://three.example.com"})
	if got := loadCfgAt(t, path); got.Fallback.PanelURL != "https://10.0.0.2:3443" {
		t.Fatalf("fallback = %+v", got.Fallback)
	}
}

func loadCfgAt(t *testing.T, path string) *FileConfig {
	t.Helper()
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestLoopbackPanelKeepsLoopback(t *testing.T) {
	moveSetup(t, true)
	panel := rpctest.NewFakePanel(t)
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	layout := joined(t, panel)
	panel.SetPanelAddress(domain.URL, "")
	startDaemon(t, layout)
	nodeID := panel.WaitConnected("")
	time.Sleep(300 * time.Millisecond)
	if hosts := panel.AcceptedHosts(); len(hosts) != 1 {
		t.Fatalf("accepted connections = %v: the panel node's agent moved off loopback", hosts)
	}
	if cfg := loadCfg(t, layout); cfg.PanelURL != panel.URL() || cfg.Fallback != nil {
		t.Fatalf("config = %+v", cfg)
	}
	if s := panel.Session(nodeID); s == nil {
		t.Fatal("no session")
	}
}

func TestParseMoveTarget(t *testing.T) {
	pin := conn.FormatPin(make([]byte, 32))
	for _, tc := range []struct {
		url, pin string
		ok       bool
	}{
		{"https://panel.example.com", "", true},
		{"wss://panel.example.com", "", true},
		{"https://panel.example.com:8443", pin, true},
		{"http://panel.example.com", "", false},
		{"panel.example.com", "", false},
		{"https://", "", false},
		{"https://panel.example.com", "sha256:nothex", false},
	} {
		got, err := parseMoveTarget(tc.url, tc.pin)
		if (err == nil) != tc.ok {
			t.Errorf("parseMoveTarget(%q, %q) = %v, %v", tc.url, tc.pin, got, err)
		}
		if err == nil && got.pin != tc.pin {
			t.Errorf("pin = %q, want %q", got.pin, tc.pin)
		}
	}
}

func TestDropsPin(t *testing.T) {
	pin := conn.FormatPin(make([]byte, 32))
	other := conn.FormatPin(append(make([]byte, 31), 1))
	for _, tc := range []struct {
		current, next panelTarget
		drops         bool
	}{
		// The panel names the pinned address without a pin: stay pinned.
		{panelTarget{url: "https://panel.example.com", pin: pin}, panelTarget{url: "https://Panel.example.com:443/"}, true},
		{panelTarget{url: "https://10.0.0.1:3443", pin: pin}, panelTarget{url: "wss://10.0.0.1:3443"}, true},
		// Another pin, a pin where there was none, or another address move.
		{panelTarget{url: "https://panel.example.com", pin: pin}, panelTarget{url: "https://panel.example.com", pin: other}, false},
		{panelTarget{url: "https://panel.example.com"}, panelTarget{url: "https://panel.example.com", pin: pin}, false},
		{panelTarget{url: "https://10.0.0.1:3443", pin: pin}, panelTarget{url: "https://panel.example.com"}, false},
	} {
		if got := dropsPin(tc.current, tc.next); got != tc.drops {
			t.Errorf("dropsPin(%v, %v) = %v", tc.current, tc.next, got)
		}
	}
}

func TestMoveTarget(t *testing.T) {
	pin := conn.FormatPin(make([]byte, 32))
	for _, tc := range []struct {
		name     string
		current  panelTarget
		url, pin string
		move     bool
	}{
		{"pinned TLS port to the domain", panelTarget{url: "https://10.0.0.1:3443", pin: pin}, "https://panel.example.com", "", true},
		{"CA-verified to a pinned address", panelTarget{url: "https://panel.example.com"}, "https://panel.example.com", pin, true},
		{"plain HTTP", panelTarget{url: "http://10.0.0.1:3000", insecure: true}, "https://evil.example", "", false},
		{"plain HTTP with a pin", panelTarget{url: "ws://10.0.0.1:3000"}, "https://evil.example", pin, false},
		{"same address without the pin", panelTarget{url: "https://panel.example.com", pin: pin}, "https://panel.example.com/", "", false},
		{"same address", panelTarget{url: "https://panel.example.com"}, "https://PANEL.example.com", "", false},
		{"not https", panelTarget{url: "https://10.0.0.1:3443", pin: pin}, "http://panel.example.com", "", false},
		{"nothing named", panelTarget{url: "https://10.0.0.1:3443", pin: pin}, "", "", false},
		{"loopback", panelTarget{url: "http://127.0.0.1:3000"}, "https://panel.example.com", "", false},
	} {
		c := &connector{logger: slog.New(slog.DiscardHandler)}
		_, got := c.moveTarget(tc.current, &agentv1.HelloAccepted{PanelUrl: tc.url, PanelPin: tc.pin})
		if got != tc.move {
			t.Errorf("%s: moveTarget = %v, want %v", tc.name, got, tc.move)
		}
	}
}

func TestSameTarget(t *testing.T) {
	pin := conn.FormatPin(make([]byte, 32))
	for _, tc := range []struct {
		a, b panelTarget
		same bool
	}{
		{panelTarget{url: "https://Panel.Example.com"}, panelTarget{url: "https://panel.example.com:443/"}, true},
		{panelTarget{url: "https://panel.example.com"}, panelTarget{url: "wss://panel.example.com"}, true},
		{panelTarget{url: "http://10.0.0.1:3000"}, panelTarget{url: "https://10.0.0.1:3443"}, false},
		{panelTarget{url: "https://10.0.0.1:3443", pin: pin}, panelTarget{url: "https://10.0.0.1:3443"}, false},
		{panelTarget{url: "https://[::1]:3443"}, panelTarget{url: "https://[::1]:3443/"}, true},
	} {
		if got := sameTarget(tc.a, tc.b); got != tc.same {
			t.Errorf("sameTarget(%v, %v) = %v", tc.a, tc.b, got)
		}
	}
}

func TestConfigFallbackValidated(t *testing.T) {
	ok := FileConfig{PanelURL: "https://panel.example.com", NodeID: "n1", Fallback: &PanelAddress{PanelURL: "http://10.0.0.1:3000", InsecureTransport: true}}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := ok
	bad.Fallback = &PanelAddress{PanelURL: "ftp://x"}
	if err := bad.Validate(); err == nil {
		t.Fatal("a broken fallback URL passed")
	}
	bad.Fallback = &PanelAddress{PanelURL: "https://x", PanelPin: "sha256:zz"}
	if err := bad.Validate(); err == nil {
		t.Fatal("a broken fallback pin passed")
	}
}

func TestDurationWords(t *testing.T) {
	for d, want := range map[time.Duration]string{time.Hour: "an hour", 2 * time.Hour: "2 hours", 5 * time.Minute: "5 minutes", 1500 * time.Millisecond: "1.5s"} {
		if got := durationWords(d); got != want {
			t.Errorf("durationWords(%s) = %q, want %q", d, got, want)
		}
	}
}
