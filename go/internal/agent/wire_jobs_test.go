package agent

import (
	"context"
	"slices"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

func TestWireJobsRegistersAndMapsErrors(t *testing.T) {
	d, _ := newTestDeps(t)
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"cron.run.v1", "backup.run.v1", "node.prune.v1"} {
		if !slices.Contains(reg.Capabilities(), c) {
			t.Errorf("capability %s not advertised: %v", c, reg.Capabilities())
		}
	}
	panel := rpctest.NewPeer(t, reg)
	ctx := context.Background()
	code := func(err error) agentv1.StatusCode { return rpc.StatusOf(err).GetCode() }

	err = panel.Call(ctx, "RunCronNow", &agentv1.RunCronNowRequest{ServiceId: "nope"}, &agentv1.RunCronNowResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_NOT_FOUND {
		t.Fatalf("RunCronNow unknown = %v", err)
	}
	// A job from the feed, before the scheduler loop runs: not started yet.
	d.Feed.Publish(&agentv1.DesiredState{Revision: 1, Services: []*agentv1.ServiceSpec{{
		Id: "s1", ProjectId: "p1", Kind: agentv1.ServiceKind_SERVICE_KIND_APP, Image: &agentv1.ImageRef{Reference: "alpine"},
		CronJobs: []*agentv1.CronJob{{Id: "j1", Schedule: "@daily", Command: []string{"true"}}},
	}}})
	err = panel.Call(ctx, "RunCronNow", &agentv1.RunCronNowRequest{ServiceId: "s1", CronJobId: "j1"}, &agentv1.RunCronNowResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
		t.Fatalf("RunCronNow before start = %v", err)
	}
	err = panel.Call(ctx, "RunBackup", &agentv1.RunBackupRequest{RunId: "r1", Subject: &agentv1.BackupSubject{ServiceId: "gone", What: &agentv1.BackupSubject_Volume{Volume: "v"}}}, &agentv1.RunBackupResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_NOT_FOUND {
		t.Fatalf("RunBackup unknown service = %v", err)
	}
	err = panel.Call(ctx, "RestoreBackup", &agentv1.RestoreBackupRequest{ObjectKey: "a/b.zip", Subject: &agentv1.BackupSubject{ServiceId: "s1", What: &agentv1.BackupSubject_Volume{Volume: "v"}}}, &agentv1.RestoreBackupResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("RestoreBackup bad key = %v", err)
	}
	if rpc.StatusOf(err).GetMessage() == "" {
		t.Fatal("status lost its message")
	}
}
