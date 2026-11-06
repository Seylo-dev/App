package nodecheck

import (
	"context"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

type fakeCheck struct {
	id  string
	run func(context.Context) *agentv1.NodeCheckResult
}

func (f fakeCheck) ID() string    { return f.id }
func (f fakeCheck) Title() string { return "title of " + f.id }
func (f fakeCheck) Run(ctx context.Context) *agentv1.NodeCheckResult {
	return f.run(ctx)
}

func TestRunFillsIdentityAndContainsFailures(t *testing.T) {
	checks := []Check{
		fakeCheck{"ok", func(context.Context) *agentv1.NodeCheckResult {
			return &agentv1.NodeCheckResult{Status: agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS}
		}},
		fakeCheck{"panics", func(context.Context) *agentv1.NodeCheckResult { panic("boom") }},
		fakeCheck{"nil", func(context.Context) *agentv1.NodeCheckResult { return nil }},
	}
	results := Run(context.Background(), checks)
	if len(results) != 3 {
		t.Fatalf("results = %d", len(results))
	}
	want := []agentv1.NodeCheckStatus{
		agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS,
		agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
		agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
	}
	for i, r := range results {
		if r.GetId() != checks[i].ID() || r.GetTitle() != checks[i].Title() {
			t.Errorf("result %d identity = %q/%q", i, r.GetId(), r.GetTitle())
		}
		if r.GetStatus() != want[i] {
			t.Errorf("result %d status = %v, want %v", i, r.GetStatus(), want[i])
		}
	}
	if !strings.Contains(results[1].GetDetail(), "boom") {
		t.Errorf("panic detail = %q", results[1].GetDetail())
	}
}

func TestRunSkipsAfterCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	results := Run(ctx, []Check{fakeCheck{"x", func(context.Context) *agentv1.NodeCheckResult {
		t.Fatal("check ran after cancel")
		return nil
	}}})
	if results[0].GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED {
		t.Fatalf("status = %v", results[0].GetStatus())
	}
}
