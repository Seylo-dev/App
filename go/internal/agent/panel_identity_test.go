package agent

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// joinedAndIdentified joins panel with its pin, waits until config.yml
// holds the node id and the panel's identity, and stops the agent.
func joinedAndIdentified(t *testing.T, panel *rpctest.FakePanel) (datadir.Layout, string) {
	t.Helper()
	layout := joined(t, panel)
	a := startDaemon(t, layout)
	nodeID := panel.WaitConnected("")
	waitUntil(t, "the panel's identity in config.yml", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.NodeID == nodeID && cfg.PanelKey != ""
	})
	a.stop(t)
	panel.WaitDisconnected(nodeID)
	return layout, nodeID
}

// hijack points the node's panel_url at attacker the way a taken-over
// panel domain would: no pin, a certificate the node's roots trust.
func hijack(t *testing.T, layout datadir.Layout, attacker *rpctest.FakePanel) {
	t.Helper()
	panelRoots = trusting(attacker.Server)
	cfg := loadCfg(t, layout)
	cfg.PanelURL, cfg.PanelPin, cfg.Fallback = attacker.URL(), "", nil
	if err := SaveConfig(layout.ConfigFile(), cfg); err != nil {
		t.Fatal(err)
	}
}

// statusErr is the agent's last connection error.
func statusErr(a *running) string {
	c, _ := a.d.conn.status.snapshot()
	return c.LastError
}

func TestPanelIdentityRecordedAtJoin(t *testing.T) {
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	layout, nodeID := joinedAndIdentified(t, panel)
	cfg := loadCfg(t, layout)
	if cfg.PanelID != panel.PanelID || cfg.PanelKey != base64.StdEncoding.EncodeToString(panel.EdgeKey) || cfg.PanelProves {
		t.Fatalf("identity after the join = %q %q %v", cfg.PanelID, cfg.PanelKey, cfg.PanelProves)
	}
	// A panel that starts signing its HelloAccepted is held to it.
	panel.SignAccepts(true)
	a := startDaemon(t, layout)
	panel.WaitConnected(nodeID)
	waitUntil(t, "panel_proves in config.yml", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelProves
	})
	a.stop(t)
	panel.WaitDisconnected(nodeID)
	panel.SignAccepts(false)
	a = startDaemon(t, layout)
	waitUntil(t, "the unsigned accept refused", func() bool { return strings.Contains(statusErr(a), "did not prove the panel's identity") })
}

// protocol-4: someone with a valid certificate for the panel's domain
// (lapsed domain, hijacked DNS) answers as the panel. A node that knows its
// panel refuses them on every connect, signs nothing for another panel id,
// serves nothing to a session with another identity key, and follows no
// panel_url they name.
func TestDomainTakeoverIsRefused(t *testing.T) {
	cases := []struct {
		name string
		// signs: the real panel signs its HelloAccepted.
		signs bool
		setup func(real, attacker *rpctest.FakePanel)
		// hello: the attacker gets a ClientHello (the panel id matched).
		hello bool
		want  string
	}{
		{"another panel id", false, func(_, a *rpctest.FakePanel) { a.PanelID = "attacker" }, false, "answers as another panel"},
		{"copied panel id, own key", false, func(r, a *rpctest.FakePanel) { a.PanelID = r.PanelID }, true, "another panel identity key"},
		{"copied id and public key, no signature", true, func(r, a *rpctest.FakePanel) {
			a.PanelID, a.EdgeKey = r.PanelID, r.EdgeKey
		}, true, "did not prove the panel's identity"},
		{"copied id and public key, signed with its own key", true, func(r, a *rpctest.FakePanel) {
			a.PanelID, a.EdgeKey = r.PanelID, r.EdgeKey
			a.SignAccepts(true)
		}, true, "signature does not match"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			moveSetup(t, false)
			panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
			panel.SignAccepts(c.signs)
			layout, nodeID := joinedAndIdentified(t, panel)
			if cfg := loadCfg(t, layout); cfg.PanelProves != c.signs {
				t.Fatalf("panel_proves = %v", cfg.PanelProves)
			}

			attacker := rpctest.NewFakePanel(t, rpctest.WithTLS())
			c.setup(panel, attacker)
			// It knows the node's public key, so it would accept the resume,
			// and it tries to keep the node with a panel_url of its own.
			attacker.AddNode(nodeID, panel.NodeKey(nodeID))
			evil := attacker.ServeTLS()
			attacker.SetPanelAddress(evil.URL, "")
			attacker.SetDesired(&agentv1.DesiredState{Revision: 7})
			hijack(t, layout, attacker)
			before := loadCfg(t, layout)

			a := startDaemon(t, layout)
			if err := a.d.deps.Reports.Event(context.Background(), &agentv1.Event{Payload: &agentv1.Event_CronRun{CronRun: &agentv1.CronRun{RunId: "r1"}}}); err != nil {
				t.Fatal(err)
			}
			waitUntil(t, "the refusal", func() bool { return strings.Contains(statusErr(a), c.want) })
			// Several connects, all refused.
			time.Sleep(3 * rejectedRetry)
			if !strings.Contains(statusErr(a), c.want) {
				t.Fatalf("status error = %q, want %q", statusErr(a), c.want)
			}
			if got := len(attacker.Hellos()) > 0; got != c.hello {
				t.Fatalf("attacker got a ClientHello: %v, want %v", got, c.hello)
			}
			if r := attacker.Reports(); len(r) != 0 {
				t.Fatalf("the attacker's session was served: reports %v", r)
			}
			if rev := a.d.deps.DesiredSync.Revision(); rev != 0 {
				t.Fatalf("desired state from the attacker applied (revision %d)", rev)
			}
			after := loadCfg(t, layout)
			if after.PanelURL != before.PanelURL || after.PanelID != before.PanelID || after.PanelKey != before.PanelKey ||
				after.PanelProves != before.PanelProves || after.Fallback != nil {
				t.Fatalf("config.yml changed: %+v -> %+v", before, after)
			}
			if hosts := attacker.AcceptedHosts(); len(hosts) > 0 && hosts[len(hosts)-1] == host(t, evil.URL) {
				t.Fatalf("the node followed the attacker's panel_url: %v", hosts)
			}
		})
	}
}

// A node that moved to the domain keeps its pinned address as a standing
// fallback. When the domain is taken over, the node refuses it, reaches its
// real panel through the pinned address and, as the panel still names the
// (hijacked) domain, refuses the move there too and makes the pinned
// address its panel_url again: a takeover costs at most a few minutes, not
// the node.
func TestDomainTakeoverFallsBackToPinnedAddress(t *testing.T) {
	moveSetup(t, false)
	standingFallbackAfter = 300 * time.Millisecond
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	layout := joined(t, panel)
	nodeID := moveAndRestart(t, panel, domain, layout, true)
	cfg := loadCfg(t, layout)
	if cfg.PanelURL != domain.URL || cfg.Fallback == nil || !cfg.Fallback.Standing || cfg.PanelKey == "" {
		t.Fatalf("config after the move = %+v (fallback %+v)", cfg, cfg.Fallback)
	}

	attacker := rpctest.NewFakePanel(t, rpctest.WithTLS())
	attacker.PanelID = panel.PanelID
	attacker.AddNode(nodeID, panel.NodeKey(nodeID))
	// The domain now leads to the attacker; the real panel still names it.
	cfg.PanelURL = attacker.URL()
	if err := SaveConfig(layout.ConfigFile(), cfg); err != nil {
		t.Fatal(err)
	}
	panel.SetPanelAddress(attacker.URL(), "")
	panelRoots = trusting(attacker.Server)

	startDaemon(t, layout)
	waitUntil(t, "the pinned address as panel_url again", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelURL == panel.URL() && cfg.PanelPin != "" && cfg.Fallback == nil
	})
	panel.WaitConnected(nodeID)
	waitUntil(t, "the move alert naming the takeover", func() bool {
		for _, a := range moveAlerts(panel) {
			if !a.GetResolved() && strings.Contains(a.GetMessage(), "another panel identity key") {
				return true
			}
		}
		return false
	})
	if r := attacker.Reports(); len(r) != 0 {
		t.Fatalf("the attacker's sessions were served: %v", r)
	}
}
