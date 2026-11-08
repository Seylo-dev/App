package agent

import (
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// impostorAtDomain moves a node to its panel's domain, finishes the move's
// cycle (the pinned old address stays as a standing fallback) and then
// hands the domain to an impostor with the same panel id (public: every
// ServerHello names it) that knows nothing of the node.
func impostorAtDomain(t *testing.T, signs bool) (panel, impostor *rpctest.FakePanel, layoutCfg *FileConfig, start func() *running) {
	t.Helper()
	moveSetup(t, false)
	standingFallbackAfter = 300 * time.Millisecond
	panel = rpctest.NewFakePanel(t, rpctest.WithTLS())
	panel.SignAccepts(signs)
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	layout := joined(t, panel)
	moveAndRestart(t, panel, domain, layout, true)
	cfg := loadCfg(t, layout)
	if cfg.Fallback == nil || !cfg.Fallback.Standing || cfg.Fallback.PanelURL != panel.URL() || cfg.PanelProves != signs {
		t.Fatalf("after the move: fallback %+v, panel_proves %v", cfg.Fallback, cfg.PanelProves)
	}
	panel.SetPanelAddress("", "")
	domain.Close()

	impostor = rpctest.NewFakePanel(t, rpctest.WithTLS())
	impostor.PanelID = panel.PanelID
	cfg.PanelURL = impostor.URL()
	if err := SaveConfig(layout.ConfigFile(), cfg); err != nil {
		t.Fatal(err)
	}
	panelRoots = trusting(impostor.Server)
	return panel, impostor, cfg, func() *running { return startDaemon(t, layout) }
}

// sec-protocol-1: an unsigned HelloRejected from whoever answers at the
// domain is not the panel's word. The node treats it like a failed
// connection, so the pinned standing fallback reaches its real panel.
func TestImpostorRejectionStillReachesThePinnedPanel(t *testing.T) {
	for _, signs := range []bool{false, true} {
		t.Run(map[bool]string{false: "panel does not sign", true: "panel signs"}[signs], func(t *testing.T) {
			panel, impostor, cfg, start := impostorAtDomain(t, signs)
			accepted := len(panel.AcceptedHosts())
			start()
			if rej := impostor.WaitRejected(1); rej.GetReason() != agentv1.HelloRejectReason_HELLO_REJECT_REASON_UNKNOWN_NODE {
				t.Fatalf("impostor rejection = %v", rej.GetReason())
			}
			waitUntil(t, "the real panel through the pinned fallback", func() bool { return len(panel.AcceptedHosts()) > accepted })
			if got := panel.AcceptedHosts()[accepted]; got != host(t, cfg.Fallback.PanelURL) {
				t.Fatalf("reached the panel at %s, want the fallback %s", got, cfg.Fallback.PanelURL)
			}
		})
	}
}

// An unsigned AGENT_TOO_OLD from the impostor does not make a node whose
// panel signs update itself; a signed one from the panel does.
func TestUnsignedTooOldDoesNotUpdate(t *testing.T) {
	fake := &fakeSelfUpdater{}
	_, impostor, _, start := impostorAtDomain(t, true)
	owners = append(owners, owner{"test-updater", func(d *Deps) error { d.Updater = fake; return nil }, func(*Registry, *Deps) error { return nil }})
	impostor.RefuseAgentsOlderThan("9.0.0")
	a := start()
	impostor.WaitRejected(2)
	waitUntil(t, "the unsigned rejection in the status", func() bool { return strings.Contains(statusErr(a), "not signed") })
	if calls := fake.called(); len(calls) != 0 {
		t.Fatalf("self-updated on an unsigned AGENT_TOO_OLD: %v", calls)
	}
}

// A rejection the panel signs with the recorded key is still the panel's
// answer on the domain: rejectedRetry, no fallback, and AGENT_TOO_OLD
// updates the agent.
func TestSignedRejectionIsHonoured(t *testing.T) {
	fake := &fakeSelfUpdater{}
	moveSetup(t, false)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	panel.SignAccepts(true)
	domain := panel.ServeTLS()
	panelRoots = trusting(domain)
	layout := joined(t, panel)
	moveAndRestart(t, panel, domain, layout, true)
	owners = append(owners, owner{"test-updater", func(d *Deps) error { d.Updater = fake; return nil }, func(*Registry, *Deps) error { return nil }})
	panel.RefuseAgentsOlderThan("9.0.0")
	startDaemon(t, layout)
	if r := panel.WaitRejected(1); len(r.GetPanelSignature()) == 0 {
		t.Fatal("the fake panel did not sign its rejection")
	}
	waitUntil(t, "the self-update", func() bool {
		calls := fake.called()
		return len(calls) > 0 && calls[0] == "9.0.0"
	})
}
