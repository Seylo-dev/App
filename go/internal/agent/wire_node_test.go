package agent

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/systemd"
)

// testReleaseKey is a valid minisign public key (the real release key; public
// halves are safe to commit). Tests set it through updatePublicKeyEnv so they
// never depend on what brand.json holds.
const testReleaseKey = "RWTwvrETQsecIkFOCm1ceiZwfxVq6sFfiEmJfWnUVv7UBIn0jWm2h1ip"

func TestNodeWiring(t *testing.T) {
	t.Setenv(updatePublicKeyEnv, testReleaseKey)
	d, rec := newTestDeps(t)
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	caps := reg.Capabilities()
	for _, c := range []string{"node.update.v1", "node.healthcheck.v1", "node.troubleshoot.v1", "node.reboot.v1", "node.docker-update.v1", "node.panel-update.v1", "node.docker-check.v1", "panel.relocate.v1"} {
		if !slices.Contains(caps, c) {
			t.Errorf("capability %s not advertised: %v", c, caps)
		}
	}
	// The daily Docker version check runs as a component (node.docker-check.v1).
	if !slices.ContainsFunc(d.Components.List(), func(c Component) bool { return c.Name == "docker-check" }) {
		t.Error("no docker-check component")
	}
	panel := rpctest.NewPeer(t, reg)
	ctx := context.Background()

	var health agentv1.RunHealthCheckResponse
	if err := panel.Call(ctx, "RunHealthCheck", &agentv1.RunHealthCheckRequest{}, &health); err != nil {
		t.Fatal(err)
	}
	if len(health.GetResults()) < 10 || health.GetResults()[0].GetId() != "system.kernel" {
		t.Fatalf("results = %v", health.GetResults())
	}

	// A manifest whose signature does not match the release key is refused,
	// and the refusal is reported durably.
	err = panel.Call(ctx, "UpdateAgent", &agentv1.UpdateAgentRequest{Manifest: []byte("{}"), ManifestSignature: []byte("x"), UpdateId: "u1"}, &agentv1.UpdateAgentResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED {
		t.Fatalf("UpdateAgent = %v", s)
	}
	rec.WaitDurable(t, func(e *agentv1.Event) bool {
		r := e.GetUpdateResult()
		return r != nil && r.GetUpdateId() == "u1" && !r.GetSuccess()
	})

	// Without the runtime wiring the panel swap is refused, not faked.
	err = panel.Call(ctx, "UpdatePanel", &agentv1.UpdatePanelRequest{ServiceId: "panel", Image: &agentv1.ImageRef{Reference: "x", Digest: "sha256:1"}}, &agentv1.UpdatePanelResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION && s.GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT && s.GetCode() != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
		t.Fatalf("UpdatePanel = %v", s)
	}

	var report agentv1.TroubleshootResponse
	if err := panel.Call(ctx, "Troubleshoot", &agentv1.TroubleshootRequest{}, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.GetReportMarkdown()) < 100 {
		t.Fatalf("report = %q", report.GetReportMarkdown())
	}
}

func TestNodeUpdateWithoutReleaseKey(t *testing.T) {
	// A build whose release key is still the brand placeholder refuses every
	// update with a clear status, and reports the refusal durably.
	t.Setenv(updatePublicKeyEnv, "PLACEHOLDER_MINISIGN_PUBLIC_KEY")
	d, rec := newTestDeps(t)
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	panel := rpctest.NewPeer(t, reg)
	err = panel.Call(context.Background(), "UpdateAgent", &agentv1.UpdateAgentRequest{Manifest: []byte("{}"), ManifestSignature: []byte("x"), UpdateId: "u2"}, &agentv1.UpdateAgentResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION {
		t.Fatalf("UpdateAgent = %v", s)
	}
	rec.WaitDurable(t, func(e *agentv1.Event) bool {
		r := e.GetUpdateResult()
		return r != nil && r.GetUpdateId() == "u2" && !r.GetSuccess()
	})
}

func TestHealthAlertsOnTransitions(t *testing.T) {
	d, rec := newTestDeps(t)
	h := &healthMemory{last: map[string]agentv1.NodeCheckStatus{}}
	run := func(status agentv1.NodeCheckStatus) {
		h.alerts(context.Background(), d, []*agentv1.NodeCheckResult{{Id: "disk.space", Title: "Disk space", Status: status, Detail: "1 GiB free"}})
	}
	run(agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL) // first run: no history, no alert
	run(agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS) // resolved
	run(agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL) // alert
	run(agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL) // still failing: no repeat
	var alerts []*agentv1.NodeAlert
	for _, e := range rec.Durable() {
		if a := e.GetNodeAlert(); a != nil {
			alerts = append(alerts, a)
		}
	}
	if len(alerts) != 2 || !alerts[0].GetResolved() || alerts[1].GetResolved() || alerts[1].GetKind() != agentv1.NodeAlertKind_NODE_ALERT_KIND_HEALTH_CHECK_FAILED {
		t.Fatalf("alerts = %v", alerts)
	}
	if autoUpdateEnabled(&agentv1.NodeSettings{}) || autoUpdateEnabled(nil) || !autoUpdateEnabled(&agentv1.NodeSettings{AutoUpdate: true}) {
		t.Fatal("auto-update must default to off")
	}
}

// TestBuildxCheckFollowsThePanel: since 0.2.1 the panel decides which nodes
// build, so the buildx health check runs when the panel sends builds
// (max_parallel_builds > 0) although config.yml leaves can_build unset,
// and is skipped only when both are off.
func TestBuildxCheckFollowsThePanel(t *testing.T) {
	buildx := func(d *Deps) *agentv1.NodeCheckResult {
		t.Helper()
		for _, c := range nodeChecks(d) {
			if c.ID() == "docker.buildx" {
				return c.Run(context.Background())
			}
		}
		t.Fatal("no docker.buildx check")
		return nil
	}
	skipped := agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED
	for _, tc := range []struct {
		name        string
		configBuild bool
		parallel    uint32
		wantSkipped bool
	}{
		{"panel sends builds, config unset", false, 2, false},
		{"config can_build, panel sends none", true, 0, false},
		{"both off", false, 0, true},
	} {
		d, _ := newTestDeps(t)
		d.Config.CanBuild = tc.configBuild
		d.Feed.Publish(&agentv1.DesiredState{Revision: 1, Settings: &agentv1.NodeSettings{MaxParallelBuilds: tc.parallel}})
		// The check itself runs the real `docker buildx version`: installed
		// or not, it must not be skipped while builds are on.
		r := buildx(d)
		if got := r.GetStatus() == skipped; got != tc.wantSkipped {
			t.Errorf("%s: status %v %q", tc.name, r.GetStatus(), r.GetDetail())
		}
		if tc.wantSkipped && r.GetDetail() != "builds are off on this node" {
			t.Errorf("%s: detail %q", tc.name, r.GetDetail())
		}
	}

	// Without a feed (no desired state yet) config.yml alone decides.
	d, _ := newTestDeps(t)
	d.Feed = nil
	if r := buildx(d); r.GetStatus() != skipped {
		t.Errorf("no feed, can_build unset: %v", r.GetStatus())
	}
}

type fakeJournal struct{ entries []systemd.JournalEntry }

func (f fakeJournal) Journal(context.Context, string, systemd.JournalOptions) ([]systemd.JournalEntry, error) {
	return f.entries, nil
}

func TestAgentLogs(t *testing.T) {
	j := fakeJournal{entries: []systemd.JournalEntry{
		{Time: time.Unix(100, 0), Level: "info", Message: "joined with token=seylo_join_secretsecret"},
		{Time: time.Unix(101, 0), Level: "error", Message: "dial failed"},
	}}
	res, err := agentLogs(context.Background(), j, &agentv1.AgentLogsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.GetLines()) != 2 || strings.Contains(res.GetLines()[0].GetLine(), "secretsecret") || res.GetLines()[1].GetLevel() != "error" {
		t.Fatalf("lines = %v", res.GetLines())
	}
	if _, err := agentLogs(context.Background(), j, &agentv1.AgentLogsRequest{Tail: 9000}); rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("tail 9000: %v", err)
	}
	d, _ := newTestDeps(t)
	if _, err := Wire(d); err != nil {
		t.Fatal(err)
	}
	if d.PanelControl == nil {
		t.Fatal("PanelControl not set")
	}
	if err := d.PanelControl.Start(context.Background()); err == nil {
		t.Fatal("start without a desired store succeeded")
	}
}
