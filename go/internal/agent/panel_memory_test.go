package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"log"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// connectedOnce joins a node to panel at its pinned address, waits for
// the node id in config.yml and stops the agent again.
func connectedOnce(t *testing.T, panel *rpctest.FakePanel) (datadir.Layout, string) {
	t.Helper()
	layout := joined(t, panel)
	a := startDaemon(t, layout)
	nodeID := joinedAs(t, panel, layout)
	a.stop(t)
	panel.WaitDisconnected(nodeID)
	return layout, nodeID
}

// joinedAs waits for the agent's first session and for its node id in
// config.yml. An agent stopped in between joins again on its next start
// with the token the panel already used, and the panel refuses it.
func joinedAs(t *testing.T, panel *rpctest.FakePanel, layout datadir.Layout) string {
	t.Helper()
	nodeID := panel.WaitConnected("")
	waitUntil(t, "the node id in config.yml", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.NodeID == nodeID
	})
	return nodeID
}

// onDomainWithStandingFallback writes config.yml of a node that moved to
// domain earlier (the move worked then) and kept its pinned join address
// as the standing fallback: the node of the incident.
func onDomainWithStandingFallback(t *testing.T, layout datadir.Layout, panel *rpctest.FakePanel, domain string) {
	t.Helper()
	cfg := loadCfg(t, layout)
	cfg.Fallback = &PanelAddress{PanelURL: panel.URL(), PanelPin: cfg.PanelPin, Standing: true}
	cfg.PanelURL, cfg.PanelPin = domain, ""
	if err := SaveConfig(layout.ConfigFile(), cfg); err != nil {
		t.Fatal(err)
	}
}

func loadMemory(t *testing.T, layout datadir.Layout) panelMemory {
	t.Helper()
	m, err := loadPanelMemory(panelMemoryPath(layout))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// The node's network starts re-signing the panel domain's certificate
// (TLS inspection): the agent dials its standing pinned fallback right
// after the first failure instead of after standingFallbackAfter, records
// the failed move from there without dialing the domain again (which would
// drop the session the panel just accepted), makes the pinned address
// panel_url again and tells the panel why, marked as an inspected
// certificate. Before, the node stayed offline for standingFallbackAfter
// (5 minutes) after every panel restart.
func TestUntrustedPrimaryDialsTheStandingFallbackAtOnce(t *testing.T) {
	moveSetup(t, false)
	standingFallbackAfter = time.Hour // the 5-minute rule would never let this test connect
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout, nodeID := connectedOnce(t, panel)
	pin := loadCfg(t, layout).PanelPin
	domain, dials := untrustedAddress(t)
	panelRoots = x509.NewCertPool()
	onDomainWithStandingFallback(t, layout, panel, domain.URL)
	panel.SetPanelAddress(domain.URL, "") // the panel keeps naming its domain

	started := time.Now()
	startDaemon(t, layout)
	panel.WaitConnected(nodeID)
	if took := time.Since(started); took > 10*time.Second {
		t.Fatalf("connected through the fallback after %s", took)
	}
	waitUntil(t, "the pinned address back as panel_url", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == panel.URL() && cfg.PanelPin == pin && cfg.Fallback == nil
	})
	waitUntil(t, "the move alert", func() bool { return len(moveAlerts(panel)) > 0 })
	time.Sleep(300 * time.Millisecond)
	if n := dials.Load(); n != 1 {
		t.Fatalf("%d connections to the domain, want 1: the fallback session dialed it again", n)
	}
	if hosts := panel.AcceptedHosts(); len(hosts) != 2 {
		t.Fatalf("accepted connections = %v, want the first one and the fallback's, which stays", hosts)
	}
	alerts := moveAlerts(panel)
	if len(alerts) != 1 || !alerts[0].GetInspectedCertificate() || alerts[0].GetResolved() ||
		!strings.Contains(alerts[0].GetMessage(), domain.URL) || !strings.Contains(alerts[0].GetMessage(), "TLS inspection") {
		t.Fatalf("move alerts = %v", alerts)
	}
	if m := loadMemory(t, layout); len(m.MoveWaits) != 1 || m.MoveWaits[0].URL != domain.URL {
		t.Fatalf("panel.json = %+v, want the domain's wait", m)
	}
}

// A primary that times out keeps the wait: a panel restart (or a short
// outage) does not move the node to its fallback.
func TestTimingOutPrimaryKeepsTheStandingFallbackWait(t *testing.T) {
	moveSetup(t, false)
	standingFallbackAfter = time.Hour
	savedDial := dialTimeout
	t.Cleanup(func() { dialTimeout = savedDial })
	dialTimeout = 100 * time.Millisecond
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout, _ := connectedOnce(t, panel)
	// Accepts TCP and never answers the TLS handshake.
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var heldMu sync.Mutex
	var held []net.Conn
	t.Cleanup(func() {
		silent.Close()
		heldMu.Lock()
		defer heldMu.Unlock()
		for _, c := range held {
			c.Close()
		}
	})
	go func() {
		for {
			c, err := silent.Accept()
			if err != nil {
				return
			}
			heldMu.Lock()
			held = append(held, c)
			heldMu.Unlock()
		}
	}()
	onDomainWithStandingFallback(t, layout, panel, "https://"+silent.Addr().String())

	a := startDaemon(t, layout)
	waitUntil(t, "a few timed out connects", func() bool {
		s, _ := a.d.backend.Status(context.Background())
		return s.Connection.Attempts >= 3
	})
	if hosts := panel.AcceptedHosts(); len(hosts) != 1 {
		t.Fatalf("accepted connections = %v: a timeout dialed the standing fallback before its wait", hosts)
	}
}

// traefikDefaultAddress is an https:// address that answers with
// Traefik's own default certificate (self-signed, "TRAEFIK DEFAULT CERT"):
// the panel's proxy has no certificate for the name for a while. It names
// 127.0.0.1, so the issuer is what the node refuses, counting the
// connections the agent opens to it.
func traefikDefaultAddress(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "TRAEFIK DEFAULT CERT"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	var dials atomic.Int32
	srv := httptest.NewUnstartedServer(http.NotFoundHandler())
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			dials.Add(1)
		}
	}
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, &dials
}

// Traefik's own certificate at panel_url is the panel's proxy without a
// certificate for a while (restarted, certificate store lost, a
// certificate issued again), not TLS inspection: the standing fallback
// keeps its 5 minutes, for a domain verified with the CA roots and for a
// pinned one. Before, the node went to its pinned address at once, and the
// failed move from there kept it on Stay for good.
func TestTraefikDefaultCertificateKeepsTheStandingFallbackWait(t *testing.T) {
	for _, pinned := range []bool{false, true} {
		t.Run(fmt.Sprintf("pinned=%v", pinned), func(t *testing.T) {
			moveSetup(t, false)
			standingFallbackAfter = time.Hour
			panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
			layout, _ := connectedOnce(t, panel)
			domain, dials := traefikDefaultAddress(t)
			panelRoots = x509.NewCertPool()
			onDomainWithStandingFallback(t, layout, panel, domain.URL)
			if pinned {
				cfg := loadCfg(t, layout)
				cfg.PanelPin = conn.FormatPin(panel.SPKI()) // not the key Traefik answers with
				if err := SaveConfig(layout.ConfigFile(), cfg); err != nil {
					t.Fatal(err)
				}
			}
			panel.SetPanelAddress(domain.URL, "")

			a := startDaemon(t, layout)
			waitUntil(t, "a few refused connects", func() bool { return dials.Load() >= 2 })
			time.Sleep(300 * time.Millisecond)
			if hosts := panel.AcceptedHosts(); len(hosts) != 1 {
				t.Fatalf("accepted connections = %v: Traefik's own certificate dialed the standing fallback before its wait", hosts)
			}
			if s, _ := a.d.backend.Status(context.Background()); !strings.Contains(s.Connection.LastError, "answers with Traefik's own certificate") {
				t.Fatalf("last error = %q", s.Connection.LastError)
			}
			if m := loadMemory(t, layout); len(m.MoveWaits) != 0 {
				t.Fatalf("panel.json = %+v, want no move waits", m)
			}
		})
	}
}

// A move to an address that answers with Traefik's own certificate fails
// as before (an hour's wait, in memory only) and the alert does not call
// it an inspected certificate, so the panel does not keep the node on
// Stay for it.
func TestMoveToTraefikDefaultCertificateIsNoInspection(t *testing.T) {
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain, dials := traefikDefaultAddress(t)
	panelRoots = x509.NewCertPool()
	layout := joined(t, panel)
	panel.SetPanelAddress(domain.URL, "")

	startDaemon(t, layout)
	waitUntil(t, "the failed move and the session after it", func() bool { return dials.Load() > 0 && len(panel.AcceptedHosts()) >= 2 })
	waitUntil(t, "the move alert", func() bool { return len(moveAlerts(panel)) > 0 })
	alerts := moveAlerts(panel)
	if len(alerts) != 1 || alerts[0].GetInspectedCertificate() || strings.Contains(alerts[0].GetMessage(), "TLS inspection") ||
		!strings.Contains(alerts[0].GetMessage(), "tries again in an hour") || !strings.Contains(alerts[0].GetMessage(), "Traefik answered with its own") {
		t.Fatalf("move alerts = %v", alerts)
	}
	if m := loadMemory(t, layout); len(m.MoveWaits) != 0 {
		t.Fatalf("panel.json = %+v, want no move waits", m)
	}
}

// A join's stay request ends with the join, also when the panel cannot
// read it (before 0.2.15): sent again on a resume after the panel updated,
// it would read as `seylo set-panel` and keep the node off the domain the
// owner adds later.
func TestJoinStayRequestEndsWithTheJoin(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	panel.BeforePanelAddress(true)
	layout := joined(t, panel)
	// What a join with --pin at the panel's public IP writes (the fake
	// panel listens on loopback, which never asks to stay).
	cfg := loadCfg(t, layout)
	cfg.StayOnAddress = true
	if err := SaveConfig(layout.ConfigFile(), cfg); err != nil {
		t.Fatal(err)
	}

	startDaemon(t, layout)
	nodeID := joinedAs(t, panel, layout)
	if h := panel.Hellos(); !h[0].GetStayOnAddress() || h[0].GetJoin() == nil {
		t.Fatalf("the join's hello = %v, want it to ask to stay", h[0])
	}
	waitUntil(t, "the request gone from config.yml", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && !cfg.StayOnAddress
	})

	// The panel updates to 0.2.15: the node's resume does not ask to stay.
	panel.BeforePanelAddress(false)
	hellos := len(panel.Hellos())
	panel.DropConnections()
	waitUntil(t, "the reconnect", func() bool { return len(panel.Hellos()) > hellos })
	panel.WaitConnected(nodeID)
	if h := panel.Hellos()[hellos]; h.GetStayOnAddress() || h.GetResume() == nil {
		t.Fatalf("the resume after the join = %v, want no stay request", h)
	}
	if got := panel.PanelAddressChoice(nodeID); got != agentv1.PanelAddressChoice_PANEL_ADDRESS_CHOICE_FOLLOW {
		t.Fatalf("panel address = %v, want FOLLOW", got)
	}
}

// A move that failed on an inspected certificate is remembered across
// restarts: the next agent start (an update, say) keeps the first session
// the panel accepts and raises no second alert. Once the panel stops
// naming the address the wait goes, and naming it again tries it at once.
func TestFailedMoveWaitSurvivesARestart(t *testing.T) {
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain, dials := untrustedAddress(t)
	panelRoots = x509.NewCertPool()
	layout := joined(t, panel)
	panel.SetPanelAddress(domain.URL, "")

	a := startDaemon(t, layout)
	waitUntil(t, "the failed move and the session after it", func() bool { return dials.Load() > 0 && len(panel.AcceptedHosts()) >= 2 })
	nodeID := panel.WaitConnected(loadCfg(t, layout).NodeID)
	waitUntil(t, "the move alert", func() bool { return len(moveAlerts(panel)) == 1 })
	m := loadMemory(t, layout)
	if len(m.MoveWaits) != 1 || m.MoveWaits[0].URL != domain.URL || time.Until(m.MoveWaits[0].Until) < 23*time.Hour {
		t.Fatalf("panel.json = %+v, want the domain's 24-hour wait", m)
	}
	a.stop(t)
	panel.WaitDisconnected(nodeID)

	a = startDaemon(t, layout)
	panel.WaitConnected(nodeID)
	time.Sleep(300 * time.Millisecond)
	if n := dials.Load(); n != 1 {
		t.Fatalf("%d connections to the domain after the restart, want still 1", n)
	}
	if hosts := panel.AcceptedHosts(); len(hosts) != 3 {
		t.Fatalf("accepted connections = %v, want one more, kept", hosts)
	}
	if n := len(moveAlerts(panel)); n != 1 {
		t.Fatalf("%d move alerts after the restart, want still 1", n)
	}

	// The panel names no address now (the owner chose Stay): the wait goes.
	panel.SetPanelAddress("", "")
	panel.DropConnections()
	panel.WaitConnected(nodeID)
	waitUntil(t, "the wait gone from panel.json", func() bool {
		m, _ := loadPanelMemory(panelMemoryPath(layout))
		return len(m.MoveWaits) == 0
	})
	// Named again (Follow): tried at once.
	panel.SetPanelAddress(domain.URL, "")
	panel.DropConnections()
	waitUntil(t, "the move tried again", func() bool { return dials.Load() == 2 })
	a.stop(t)
}

// A wait for another address goes when the panel names a new one.
func TestForgetUnnamedMoves(t *testing.T) {
	c := &connector{moveRetry: map[string]moveWait{}}
	pinned := panelTarget{url: "https://203.0.113.4:3443", pin: conn.FormatPin(make([]byte, 32))}
	a, b := panelTarget{url: "https://a.example.com"}, panelTarget{url: "https://b.example.com"}
	later := time.Now().Add(time.Hour)
	c.moveRetry[moveKey(a)] = moveWait{target: a, until: later, kept: true}
	c.moveRetry[moveKey(b)] = moveWait{target: b, until: later}
	if c.forgetUnnamedMoves(pinned, &agentv1.HelloAccepted{PanelUrl: a.url}) {
		t.Fatal("a kept wait went though only an unkept one did")
	}
	if _, ok := c.moveRetry[moveKey(a)]; !ok || len(c.moveRetry) != 1 {
		t.Fatalf("waits = %v, want only a's", c.moveRetry)
	}
	// A plain session proves nothing: nothing goes.
	if c.forgetUnnamedMoves(panelTarget{url: "http://203.0.113.4:3000"}, &agentv1.HelloAccepted{}) || len(c.moveRetry) != 1 {
		t.Fatalf("a plain session dropped waits: %v", c.moveRetry)
	}
	if !c.forgetUnnamedMoves(pinned, &agentv1.HelloAccepted{}) || len(c.moveRetry) != 0 {
		t.Fatalf("waits = %v after the panel named nothing", c.moveRetry)
	}
}

// `seylo set-panel` asks the panel to keep the node on the new address:
// the agent sends stay_on_address until the panel answers with the
// node's Panel address, then drops it from config.yml.
func TestSetPanelAsksThePanelToStay(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout, _ := domainNode(t, panel, false)
	pin := conn.FormatPin(panel.SPKI())
	if _, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), Pin: pin}); err != nil {
		t.Fatal(err)
	}
	if cfg := loadCfg(t, layout); !cfg.StayOnAddress {
		t.Fatalf("config.yml = %+v, want stay_on_address", cfg)
	}
	panel.WaitDisconnected("node7")

	startDaemon(t, layout)
	panel.WaitConnected("node7")
	waitUntil(t, "the answered request gone from config.yml", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && !cfg.StayOnAddress
	})
	if got := panel.PanelAddressChoice("node7"); got != agentv1.PanelAddressChoice_PANEL_ADDRESS_CHOICE_STAY {
		t.Fatalf("panel address = %v, want STAY", got)
	}
	hellos := panel.Hellos()
	if !hellos[len(hellos)-1].GetStayOnAddress() {
		t.Fatalf("the agent's hello did not ask to stay: %v", hellos[len(hellos)-1])
	}
	// The next connect does not ask again.
	panel.DropConnections()
	waitUntil(t, "the reconnect", func() bool { return len(panel.Hellos()) >= len(hellos)+1 })
	if h := panel.Hellos(); h[len(h)-1].GetStayOnAddress() {
		t.Fatal("the agent asked to stay again after the panel answered")
	}
}

// set-panel to the address config.yml already has (put there by hand)
// still asks the panel to keep the node there.
func TestSetPanelSameAddressStillAsksToStay(t *testing.T) {
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout, _ := domainNode(t, panel, false)
	cfg := loadCfg(t, layout)
	cfg.PanelURL, cfg.PanelPin = panel.URL(), conn.FormatPin(panel.SPKI())
	if err := SaveConfig(layout.ConfigFile(), cfg); err != nil {
		t.Fatal(err)
	}
	res, err := setPanelAt(t, layout, SetPanelOptions{PanelURL: panel.URL(), Pin: cfg.PanelPin})
	if err != nil || !res.Unchanged || !res.StayRequested {
		t.Fatalf("res = %+v, err = %v", res, err)
	}
	if got := loadCfg(t, layout); !got.StayOnAddress || got.PanelURL != panel.URL() {
		t.Fatalf("config.yml = %+v", got)
	}
	if panel.Connects() != 0 {
		t.Fatal("an unchanged address was dialed")
	}
}

// A join with --pin at an IP address asks to stay; a join at a domain, or
// at an IP without a pin, does not, and a re-join starts over.
func TestJoinAtAnIPWithThePinAsksToStay(t *testing.T) {
	pin := "sha256:" + strings.Repeat("ab", 32)
	for _, tc := range []struct {
		url, pin string
		stay     bool
	}{
		{"https://203.0.113.7:3443", pin, true},
		{"https://[2001:db8::7]:3443", pin, true},
		{"https://panel.example.com", pin, false},
		{"https://panel.example.com", "", false},
		{"http://203.0.113.7:3000", "", false},
		{"http://127.0.0.1:3000", "", false},
	} {
		layout := shortLayout(t)
		if err := Join(layout, JoinOptions{PanelURL: tc.url, Token: "t", Pin: tc.pin, Insecure: true}); err != nil {
			t.Fatal(err)
		}
		if got := loadCfg(t, layout).StayOnAddress; got != tc.stay {
			t.Errorf("join at %s (pin %q): stay_on_address = %v, want %v", tc.url, tc.pin, got, tc.stay)
		}
	}
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: "https://203.0.113.7:3443", Token: "t", Pin: pin}); err != nil {
		t.Fatal(err)
	}
	if err := Join(layout, JoinOptions{PanelURL: "https://panel.example.com", Token: "t2", Force: true}); err != nil {
		t.Fatal(err)
	}
	if loadCfg(t, layout).StayOnAddress {
		t.Fatal("a re-join at the domain kept the stay request")
	}
}

// `seylo status` names the node as the panel does once it connected, also
// after a restart before the next connect; the hostname (or the name
// asked for at the join) only before the first connect. A rename the
// desired state carries shows at once.
func TestStatusNamesTheNodeAsThePanelDoes(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t)
	layout := joined(t, panel)
	a := startDaemon(t, layout)
	host := a.d.deps.Facts.Get().GetHostname()
	nodeID := joinedAs(t, panel, layout)
	a.stop(t)
	panel.WaitDisconnected(nodeID)
	if s, _ := a.d.backend.Status(context.Background()); s.NodeName != host {
		t.Fatalf("name = %q before the panel named the node, want the hostname %q", s.NodeName, host)
	}

	panel.SetNodeName(nodeID, "edge-east")
	a = startDaemon(t, layout)
	panel.WaitConnected(nodeID)
	waitUntil(t, "the panel's name", func() bool {
		s, _ := a.d.backend.Status(context.Background())
		return s.NodeName == "edge-east"
	})
	a.stop(t)
	panel.WaitDisconnected(nodeID)

	// Restarted while the panel is away: still the panel's name.
	panel.RefuseAgents(true)
	a = startDaemon(t, layout)
	if s, _ := a.d.backend.Status(context.Background()); s.NodeName != "edge-east" {
		t.Fatalf("name = %q after a restart, want the panel's", s.NodeName)
	}
	if _, _, err := a.d.deps.DesiredSync.Sync(context.Background(), &agentv1.DesiredState{Revision: 7, Settings: &agentv1.NodeSettings{NodeName: "edge-east-2"}}); err != nil {
		t.Fatal(err)
	}
	if s, _ := a.d.backend.Status(context.Background()); s.NodeName != "edge-east-2" {
		t.Fatalf("name = %q, want the desired state's", s.NodeName)
	}
}

// Connects that fail while the panel is away are reported in the next
// hello (AwayReport), across an agent restart, and only once.
func TestAwayReportAfterFailedConnects(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t)
	layout := joined(t, panel)
	a := startDaemon(t, layout)
	nodeID := joinedAs(t, panel, layout)
	if h := panel.Hellos(); h[0].GetAway() != nil {
		t.Fatalf("the first hello reported %v", h[0].GetAway())
	}
	a.stop(t)
	panel.WaitDisconnected(nodeID)

	panel.RefuseAgents(true)
	lost := time.Now()
	a = startDaemon(t, layout)
	panel.WaitConnects(panel.Connects() + 2)
	a.stop(t)
	if m := loadMemory(t, layout); m.Away == nil || !strings.Contains(m.Away.LastError, "503") {
		t.Fatalf("panel.json = %+v, want the connect error", m)
	}
	hellos := len(panel.Hellos())
	panel.RefuseAgents(false)
	startDaemon(t, layout)
	panel.WaitConnected(nodeID)
	h := panel.Hellos()
	if len(h) != hellos+1 {
		t.Fatalf("%d hellos, want %d", len(h), hellos+1)
	}
	away := h[len(h)-1].GetAway()
	// panel.json is written when the error changes (or once a minute), so the count is the stored one.
	if away == nil || !strings.Contains(away.GetLastError(), "503") || away.GetFailedAttempts() < 1 ||
		away.GetSince().AsTime().Before(lost.Add(-time.Second)) || away.GetLastErrorAt().AsTime().Before(lost) {
		t.Fatalf("away report = %v", away)
	}
	waitUntil(t, "the away state gone from panel.json", func() bool {
		m, err := loadPanelMemory(panelMemoryPath(layout))
		return err == nil && m.Away == nil
	})
	panel.DropConnections()
	waitUntil(t, "the reconnect", func() bool { return len(panel.Hellos()) == hellos+2 })
	if again := panel.Hellos()[hellos+1].GetAway(); again != nil {
		t.Fatalf("the report was sent again: %v", again)
	}
}

func TestPanelMemoryUnreadableStartsEmpty(t *testing.T) {
	path := t.TempDir() + "/panel.json"
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadPanelMemory(path); err == nil {
		t.Fatal("garbage parsed")
	}
	c := &connector{memPath: path, logger: slog.New(slog.DiscardHandler)}
	c.restoreMemory(time.Now())
	if c.panelNodeName() != "" || len(c.moveRetry) != 0 || c.away.Since.IsZero() {
		t.Fatalf("connector after an unreadable memory: name %q, waits %v, away %+v", c.panelNodeName(), c.moveRetry, c.away)
	}
}
