package agent

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/state"
)

func TestWireRuntime(t *testing.T) {
	d, rec := newTestDeps(t)
	eng := dockertest.New()
	d.Docker = eng
	store := state.NewMemoryStore()
	d.State = store
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	caps := d.Facts.Get().GetCapabilities()
	// panel.publish-bind.v1: the panel closes IP access only on a panel
	// node that advertises it (apps/panel/src/modules/settings).
	// volume.import-limits.v1: the panel sends an uploaded export file's
	// volume data only to agents that advertise it (modules/serviceTransfer).
	for _, c := range []string{"state.sync.v1", "volume.transfer.v1", "panel.publish-bind.v1", "volume.import-limits.v1"} {
		if !slices.Contains(caps, c) {
			t.Fatalf("capability %s not advertised: %v", c, caps)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = d.Reconcile.Run(ctx) }()

	panel := rpctest.NewPeer(t, reg)
	spec := &agentv1.ServiceSpec{
		Id: "web", ProjectId: "p1", Name: "web", Generation: 1,
		Kind:    agentv1.ServiceKind_SERVICE_KIND_APP,
		Image:   &agentv1.ImageRef{Reference: "nginx:1"},
		Volumes: []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}},
	}
	var applied agentv1.ApplyServiceResponse
	if err := panel.Call(ctx, "ApplyService", &agentv1.ApplyServiceRequest{Revision: 3, Service: spec}, &applied); err != nil {
		t.Fatal(err)
	}
	if applied.GetAcceptedRevision() != 3 {
		t.Fatalf("accepted %d", applied.GetAcceptedRevision())
	}
	rec.WaitDurable(t, func(e *agentv1.Event) bool {
		return e.GetDeployProgress().GetStage() == agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED
	})
	if c, ok := eng.Get(docker.ContainerName("web", 1, 0)); !ok || !c.Running {
		t.Fatal("service not running")
	}
	deadline := time.Now().Add(5 * time.Second)
	running := func() bool {
		s := store.Snapshot().GetServices()
		return len(s) == 1 && s[0].GetPhase() == agentv1.ServicePhase_SERVICE_PHASE_RUNNING
	}
	for !running() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if s := store.Snapshot(); len(s.GetServices()) != 1 || s.GetServices()[0].GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_RUNNING {
		t.Fatalf("snapshot = %v", s)
	}

	bad := &agentv1.ApplyServiceRequest{Revision: 4, Service: &agentv1.ServiceSpec{Id: "../etc", ProjectId: "p1"}}
	if err := panel.Call(ctx, "ApplyService", bad, &agentv1.ApplyServiceResponse{}); rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("bad id = %v", err)
	}
	// In a SyncDesired the bad spec is refused alone and listed.
	var mixed agentv1.SyncDesiredResponse
	err = panel.Call(ctx, "SyncDesired", &agentv1.SyncDesiredRequest{State: &agentv1.DesiredState{Revision: 4,
		Services: []*agentv1.ServiceSpec{spec, bad.GetService()}}}, &mixed)
	if err != nil || mixed.GetAcceptedRevision() != 4 || len(mixed.GetRefused()) != 1 || mixed.GetRefused()[0].GetServiceId() != "../etc" ||
		mixed.GetRefused()[0].GetMessage() == "" {
		t.Fatalf("sync with one bad spec = %v, %v", &mixed, err)
	}
	err = panel.Call(ctx, "RestartService", &agentv1.RestartServiceRequest{ServiceId: "nope"}, &agentv1.RestartServiceResponse{})
	if rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_NOT_FOUND {
		t.Fatalf("restart unknown = %v", err)
	}
	if err := panel.Call(ctx, "RestartService", &agentv1.RestartServiceRequest{ServiceId: "web"}, &agentv1.RestartServiceResponse{}); err != nil {
		t.Fatal(err)
	}

	// Volume export and import through raw streams.
	vol, _ := d.Layout.ServiceVolume("web", "data")
	if err := os.WriteFile(filepath.Join(vol, "hello.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := panel.Open(ctx, "ExportVolume", &agentv1.ExportVolumeRequest{ServiceId: "web", Volume: "data"})
	if err != nil {
		t.Fatal(err)
	}
	archive, err := io.ReadAll(st)
	if err != nil {
		t.Fatal(err)
	}
	var exp agentv1.ExportVolumeResponse
	if err := st.Finish(&exp); err != nil || exp.GetSizeBytes() != 2 || exp.GetEntries() != 1 {
		t.Fatalf("export = %v, %v", &exp, err)
	}

	// Into a running service: refused.
	up, err := panel.Open(ctx, "ImportVolume", &agentv1.ImportVolumeRequest{ServiceId: "web", Volume: "data", Replace: true})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = up.Write(archive)
	_ = up.CloseSend()
	if err := up.Finish(&agentv1.ImportVolumeResponse{}); rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION {
		t.Fatalf("import into running service = %v", err)
	}
	// Into a new service on this node: works.
	up, err = panel.Open(ctx, "ImportVolume", &agentv1.ImportVolumeRequest{ServiceId: "moved", Volume: "data"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(up, bytes.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
	_ = up.CloseSend()
	var imp agentv1.ImportVolumeResponse
	if err := up.Finish(&imp); err != nil || imp.GetSizeBytes() != 2 {
		t.Fatalf("import = %v, %v", &imp, err)
	}
	moved, _ := d.Layout.ServiceVolume("moved", "data")
	if b, _ := os.ReadFile(filepath.Join(moved, "hello.txt")); string(b) != "hi" {
		t.Fatalf("imported file = %q", b)
	}

	// With the limits of an uploaded file: another hash is refused with its
	// reason and leaves the volume empty; too many entries too.
	for _, c := range []struct {
		req    *agentv1.ImportVolumeRequest
		code   agentv1.StatusCode
		reason string
	}{
		{&agentv1.ImportVolumeRequest{ServiceId: "moved", Volume: "data", Replace: true, Sha256: strings.Repeat("0", 64)},
			agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "checksum"},
		{&agentv1.ImportVolumeRequest{ServiceId: "moved", Volume: "data", Replace: true, MaxEntries: 0, MaxBytes: 1},
			agentv1.StatusCode_STATUS_CODE_RESOURCE_EXHAUSTED, ""},
	} {
		up, err = panel.Open(ctx, "ImportVolume", c.req)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(up, bytes.NewReader(archive)); err != nil {
			t.Fatal(err)
		}
		_ = up.CloseSend()
		err = up.Finish(&agentv1.ImportVolumeResponse{})
		st := rpc.StatusOf(err)
		if st.GetCode() != c.code || (c.reason != "" && st.GetDetails()["reason"] != c.reason) {
			t.Fatalf("import with %v = %v", c.req, st)
		}
		if left, _ := os.ReadDir(moved); len(left) != 0 {
			t.Fatalf("a refused import left %v", left)
		}
	}

	var rm agentv1.RemoveServiceResponse
	if err := panel.Call(ctx, "RemoveService", &agentv1.RemoveServiceRequest{Revision: 5, ServiceId: "web"}, &rm); err != nil || rm.GetAcceptedRevision() != 5 {
		t.Fatalf("remove = %v, %v", &rm, err)
	}
	var syncd agentv1.SyncDesiredResponse
	if err := panel.Call(ctx, "SyncDesired", &agentv1.SyncDesiredRequest{State: &agentv1.DesiredState{Revision: 4}}, &syncd); err != nil || syncd.GetAcceptedRevision() != 5 {
		t.Fatalf("stale sync = %v, %v", &syncd, err)
	}
}
