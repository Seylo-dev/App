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

func TestNodeWiring(t *testing.T) {
	t.Setenv(updatePublicKeyEnv, "")
	d, rec := newTestDeps(t)
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	caps := reg.Capabilities()
	for _, c := range []string{"node.update.v1", "node.healthcheck.v1", "node.troubleshoot.v1", "node.reboot.v1", "node.docker-update.v1", "node.panel-update.v1"} {
		if !slices.Contains(caps, c) {
			t.Errorf("capability %s not advertised: %v", c, caps)
		}
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

	// This build carries the placeholder release key: updates are refused
	// with a clear status, and the refusal is reported durably.
	err = panel.Call(ctx, "UpdateAgent", &agentv1.UpdateAgentRequest{Manifest: []byte("{}"), ManifestSignature: []byte("x"), UpdateId: "u1"}, &agentv1.UpdateAgentResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION {
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
