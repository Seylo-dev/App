package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
	"github.com/seylo-dev/app/go/internal/metrics"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// observeTestDeps wires the observe area with a Docker client that cannot
// connect, and a desired state with one service and one volume.
func observeTestDeps(t *testing.T) (*Deps, *Registry) {
	t.Helper()
	saved := newObserveDocker
	t.Cleanup(func() { newObserveDocker = saved })
	sock := filepath.Join(t.TempDir(), "no-docker.sock")
	newObserveDocker = func() observeDocker { return dockerapi.New(sock) }
	d, _ := newTestDeps(t)
	d.Feed.Publish(&agentv1.DesiredState{Revision: 1, Services: []*agentv1.ServiceSpec{
		{Id: "svc1", Volumes: []*agentv1.VolumeMount{{Name: "data", ContainerPath: "/data"}, {Name: "shared", OwnerServiceId: "svc2"}}},
	}})
	if err := provideObserve(d); err != nil {
		t.Fatal(err)
	}
	reg := rpc.NewAgentMux()
	if err := wireObserve(reg, d); err != nil {
		t.Fatal(err)
	}
	return d, reg
}

func TestObserveCapabilities(t *testing.T) {
	_, reg := observeTestDeps(t)
	caps := reg.Capabilities()
	for _, want := range []string{"exec.run.v1", "terminal.console.v1", "terminal.shell.v1", "fs.basic.v1", "fs.archive.v1", "logs.follow.v1", "logs.search.v1", "metrics.read.v1"} {
		if !slices.Contains(caps, want) {
			t.Errorf("capability %s not advertised (have %v)", want, caps)
		}
	}
}

func code(err error) agentv1.StatusCode { return rpc.StatusOf(err).GetCode() }

func TestObserveFilesOverRPC(t *testing.T) {
	d, reg := observeTestDeps(t)
	panel := rpctest.NewPeer(t, reg, rpctest.WithWindow(16<<10))
	ctx := context.Background()
	root := &agentv1.FsRoot{ServiceId: "svc1", Volume: "data"}

	// Upload 300 KB through several flow-control windows, then read it back.
	content := make([]byte, 300_000)
	_, _ = rand.Read(content)
	up, err := panel.Open(ctx, "FsWrite", &agentv1.FsWriteRequest{Root: root, Path: "/in/blob.bin", CreateParents: true, SizeBytes: uint64(len(content))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := up.Write(content); err != nil {
		t.Fatal(err)
	}
	_ = up.CloseSend()
	var wresp agentv1.FsWriteResponse
	if err := up.Finish(&wresp); err != nil {
		t.Fatal(err)
	}
	if wresp.GetInfo().GetSize() != uint64(len(content)) || wresp.GetInfo().GetPath() != "in/blob.bin" {
		t.Fatalf("write info = %v", wresp.GetInfo())
	}
	vol, _ := d.Layout.ServiceVolume("svc1", "data")
	if b, _ := os.ReadFile(filepath.Join(vol, "in", "blob.bin")); !bytes.Equal(b, content) {
		t.Fatal("file on disk differs")
	}

	down, err := panel.Open(ctx, "FsRead", &agentv1.FsReadRequest{Root: root, Path: "in/blob.bin"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(down)
	if err != nil {
		t.Fatal(err)
	}
	var rresp agentv1.FsReadResponse
	if err := down.Finish(&rresp); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("downloaded %d bytes, differ", len(got))
	}

	var list agentv1.FsListResponse
	if err := panel.Call(ctx, "FsList", &agentv1.FsListRequest{Root: root, Path: "/"}, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.GetEntries()) != 1 || list.GetEntries()[0].GetName() != "in" {
		t.Fatalf("list = %v", list.GetEntries())
	}

	// A symlink planted by the container must not lead the agent out.
	if err := os.Symlink("/etc", filepath.Join(vol, "etc")); err != nil {
		t.Fatal(err)
	}
	err = panel.Call(ctx, "FsList", &agentv1.FsListRequest{Root: root, Path: "etc"}, &list)
	if code(err) != agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED {
		t.Fatalf("list through escaping link = %v", err)
	}
	down, _ = panel.Open(ctx, "FsRead", &agentv1.FsReadRequest{Root: root, Path: "etc/hosts"})
	_, _ = io.ReadAll(down)
	if err := down.Finish(&rresp); code(err) != agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED {
		t.Fatalf("read through escaping link = %v", err)
	}

	err = panel.Call(ctx, "FsMkdir", &agentv1.FsMkdirRequest{Root: root, Path: "in"}, &agentv1.FsMkdirResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_ALREADY_EXISTS {
		t.Fatalf("mkdir existing = %v", err)
	}
	err = panel.Call(ctx, "FsStat", &agentv1.FsStatRequest{Root: root, Path: "../x"}, &agentv1.FsStatResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("stat .. = %v", err)
	}
	err = panel.Call(ctx, "FsList", &agentv1.FsListRequest{Root: &agentv1.FsRoot{ServiceId: "svc1", Volume: "nope"}}, &list)
	if code(err) != agentv1.StatusCode_STATUS_CODE_NOT_FOUND {
		t.Fatalf("unknown volume = %v", err)
	}

	// A compose volume lives in its owner's folder.
	if err := panel.Call(ctx, "FsMkdir", &agentv1.FsMkdirRequest{Root: &agentv1.FsRoot{ServiceId: "svc1", Volume: "shared"}, Path: "x"}, &agentv1.FsMkdirResponse{}); err != nil {
		t.Fatal(err)
	}
	owner, _ := d.Layout.ServiceVolume("svc2", "shared")
	if _, err := os.Stat(filepath.Join(owner, "x")); err != nil {
		t.Fatal("shared volume not in the owner's folder")
	}

	var arch agentv1.FsArchiveResponse
	if err := panel.Call(ctx, "FsArchive", &agentv1.FsArchiveRequest{Root: root, Paths: []string{"in"}, Destination: "in.tar.gz"}, &arch); err != nil {
		t.Fatal(err)
	}
	if err := panel.Call(ctx, "FsExtract", &agentv1.FsExtractRequest{Root: root, ArchivePath: "in.tar.gz", Destination: "out"}, &agentv1.FsExtractResponse{}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(vol, "out", "in", "blob.bin")); !bytes.Equal(b, content) {
		t.Fatal("extracted file differs")
	}
	if err := panel.Call(ctx, "FsDelete", &agentv1.FsDeleteRequest{Root: root, Paths: []string{"out", "in.tar.gz"}}, &agentv1.FsDeleteResponse{}); err != nil {
		t.Fatal(err)
	}
}

// TestObserveFilesKeepServiceFoldersPrivate: the file manager can be the
// first to touch a service on a node (a stopped clone never deployed here,
// a first deploy that failed before reconcile made the folder). The folders
// it creates are private like reconcile's: services/ and services/<id>/
// 0700, the volume folder 0755. They used to come out 0755, so a local
// account could read what was uploaded until the next agent restart.
func TestObserveFilesKeepServiceFoldersPrivate(t *testing.T) {
	d, reg := observeTestDeps(t)
	panel := rpctest.NewPeer(t, reg)
	ctx := context.Background()
	services := d.Layout.ServicesDir()
	if _, err := os.Lstat(services); err == nil {
		t.Fatal("services/ exists before the file manager touched a volume")
	}
	for _, root := range []*agentv1.FsRoot{{ServiceId: "svc1", Volume: "data"}, {ServiceId: "svc1", Volume: "shared"}} {
		var list agentv1.FsListResponse
		if err := panel.Call(ctx, "FsList", &agentv1.FsListRequest{Root: root, Path: "/"}, &list); err != nil {
			t.Fatalf("list %s/%s: %v", root.GetServiceId(), root.GetVolume(), err)
		}
	}
	data, _ := d.Layout.ServiceVolume("svc1", "data")
	shared, _ := d.Layout.ServiceVolume("svc2", "shared")
	for _, dir := range []string{services, filepath.Join(services, "svc1"), filepath.Join(services, "svc2")} {
		st, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o700 {
			t.Errorf("%s is %v after the file manager made it, want 0700", dir, st.Mode().Perm())
		}
	}
	for _, dir := range []string{data, shared} {
		st, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o755 {
			t.Errorf("volume folder %s is %v, want 0755", dir, st.Mode().Perm())
		}
	}
	// An unknown volume creates nothing.
	err := panel.Call(ctx, "FsList", &agentv1.FsListRequest{Root: &agentv1.FsRoot{ServiceId: "ghost", Volume: "data"}}, &agentv1.FsListResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_NOT_FOUND {
		t.Fatalf("unknown service = %v", err)
	}
	if _, err := os.Lstat(filepath.Join(services, "ghost")); err == nil {
		t.Fatal("an unknown service got a folder")
	}
}

func TestObserveLogsOverRPC(t *testing.T) {
	d, reg := observeTestDeps(t)
	panel := rpctest.NewPeer(t, reg)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for i, line := range []string{"booting", "listening on :3000", "GET / 200"} {
		if err := d.Logs.Append("svc1", &agentv1.LogEntry{Time: timestamppb.Now(), Stream: agentv1.LogStream_LOG_STREAM_STDOUT, Generation: uint64(i + 1), Line: line}); err != nil {
			t.Fatal(err)
		}
	}
	var search agentv1.LogsSearchResponse
	if err := panel.Call(ctx, "LogsSearch", &agentv1.LogsSearchRequest{ServiceId: "svc1", Query: "LISTENING"}, &search); err != nil {
		t.Fatal(err)
	}
	if len(search.GetEntries()) != 1 || search.GetEntries()[0].GetGeneration() != 2 {
		t.Fatalf("search = %v", search.GetEntries())
	}
	err := panel.Call(ctx, "LogsSearch", &agentv1.LogsSearchRequest{ServiceId: "svc1", Query: "(", Regex: true}, &search)
	if code(err) != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("bad regex = %v", err)
	}

	st, err := panel.Open(ctx, "LogsFollow", &agentv1.LogsFollowRequest{Target: &agentv1.LogsFollowRequest_ServiceId{ServiceId: "svc1"}, Tail: 2})
	if err != nil {
		t.Fatal(err)
	}
	var batch agentv1.LogsFollowResponse
	if err := st.Recv(&batch); err != nil {
		t.Fatal(err)
	}
	if len(batch.GetEntries()) != 2 || batch.GetEntries()[1].GetLine() != "GET / 200" {
		t.Fatalf("history = %v", batch.GetEntries())
	}
	_ = d.Logs.Append("svc1", &agentv1.LogEntry{Time: timestamppb.Now(), Stream: agentv1.LogStream_LOG_STREAM_SYSTEM, Line: "deploy 4 started"})
	if err := st.Recv(&batch); err != nil {
		t.Fatal(err)
	}
	if batch.GetEntries()[0].GetLine() != "deploy 4 started" {
		t.Fatalf("live = %v", batch.GetEntries())
	}
	cancel()
}

func TestObserveDockerDownErrors(t *testing.T) {
	_, reg := observeTestDeps(t)
	panel := rpctest.NewPeer(t, reg)
	ctx := context.Background()
	err := panel.Call(ctx, "Exec", &agentv1.ExecRequest{ServiceId: "svc1"}, &agentv1.ExecResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("empty command = %v", err)
	}
	st, err := panel.Open(ctx, "Console", &agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Stdin{Stdin: []byte("x")}})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Finish(nil); code(err) != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("console without open = %v", err)
	}
	st, _ = panel.Open(ctx, "Shell", &agentv1.ShellRequest{Message: &agentv1.ShellRequest_Open{Open: &agentv1.ShellOpen{ServiceId: "svc1", DatabaseClient: true}}})
	if err := st.Finish(nil); code(err) != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("database shell on an app = %v", err)
	}
	var m agentv1.GetMetricsResponse
	if err := panel.Call(ctx, "GetMetrics", &agentv1.GetMetricsRequest{}, &m); err != nil || len(m.GetSamples()) != 0 {
		t.Fatalf("metrics before any sample = %v %v", m.GetSamples(), err)
	}
}

// watchRecorder answers WatchMetrics with one sample, then ends as a
// lease that ran out does, and keeps the options it was asked for.
type watchRecorder struct {
	metrics.Collector
	got chan metrics.WatchOptions
}

func (w *watchRecorder) Watch(_ context.Context, o metrics.WatchOptions, fn func(*agentv1.MetricsReport) error) error {
	w.got <- o
	return fn(&agentv1.MetricsReport{Node: &agentv1.NodeUsage{CpuPercent: 7}})
}

func TestWatchMetricsTakesLightAndLease(t *testing.T) {
	d, reg := observeTestDeps(t)
	rec := &watchRecorder{got: make(chan metrics.WatchOptions, 2)}
	d.Metrics = rec
	panel := rpctest.NewPeer(t, reg)
	ctx := context.Background()

	st, err := panel.Open(ctx, "WatchMetrics", &agentv1.WatchMetricsRequest{
		Interval: durationpb.New(2 * time.Second),
		Light:    true,
		Lease:    durationpb.New(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	var sample agentv1.WatchMetricsResponse
	if err := st.Recv(&sample); err != nil || sample.GetSample().GetNode().GetCpuPercent() != 7 {
		t.Fatalf("sample = %v, %v", &sample, err)
	}
	// The lease ran out: the stream closes with OK, not an error.
	if err := st.Finish(nil); err != nil {
		t.Fatalf("watch end = %v", err)
	}
	if o := <-rec.got; o.Interval != 2*time.Second || !o.Light || o.Lease != time.Minute || len(o.ServiceIDs) != 0 {
		t.Fatalf("options = %+v", o)
	}

	// An older panel's request: full samples of the listed services, no lease.
	st, _ = panel.Open(ctx, "WatchMetrics", &agentv1.WatchMetricsRequest{ServiceIds: []string{"svc1"}})
	_ = st.Recv(&sample)
	_ = st.Finish(nil)
	if o := <-rec.got; o.Interval != 0 || o.Light || o.Lease != 0 || !slices.Equal(o.ServiceIDs, []string{"svc1"}) {
		t.Fatalf("older panel's options = %+v", o)
	}
}
