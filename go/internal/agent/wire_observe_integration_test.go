//go:build integration

package agent

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/metrics"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// Integration tests for the observe area against the VM's real Docker.
// Run with: scripts/dev/vm-gotest.sh ./internal/agent -run TestIT -v
// Every container is named seylo-it-ob-<random>-... and removed afterwards.

const itImage = "busybox:1.37"

type itEnv struct {
	t      *testing.T
	dk     *dockerapi.Client
	d      *Deps
	reg    *Registry
	panel  *rpctest.Peer
	prefix string
	svc    string
}

func newITEnv(t *testing.T, volumes ...string) *itEnv {
	t.Helper()
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("set SEYLO_IT=1 (scripts/dev/vm-gotest.sh does)")
	}
	dk := dockerapi.New("")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := dk.Ping(ctx); err != nil {
		t.Fatalf("docker: %v", err)
	}
	if err := dk.PullImage(ctx, itImage); err != nil {
		t.Fatalf("pull: %v", err)
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	e := &itEnv{t: t, dk: dk, prefix: "seylo-it-ob-" + id, svc: "obsvc" + id}

	saved := newObserveDocker
	t.Cleanup(func() { newObserveDocker = saved })
	newObserveDocker = func() observeDocker { return dk }
	d, _ := newTestDeps(t)
	spec := &agentv1.ServiceSpec{Id: e.svc, Kind: agentv1.ServiceKind_SERVICE_KIND_APP}
	for _, v := range volumes {
		spec.Volumes = append(spec.Volumes, &agentv1.VolumeMount{Name: v, ContainerPath: "/" + v})
	}
	d.Feed.Publish(&agentv1.DesiredState{Revision: 1, Services: []*agentv1.ServiceSpec{spec}})
	if err := provideObserve(d); err != nil {
		t.Fatal(err)
	}
	reg := rpc.NewAgentMux()
	if err := wireObserve(reg, d); err != nil {
		t.Fatal(err)
	}
	e.d, e.reg = d, reg
	e.panel = rpctest.NewPeer(t, reg)
	return e
}

// run starts a container of the test service.
func (e *itEnv) run(gen uint64, o dockerapi.CreateOptions) string {
	e.t.Helper()
	ctx := context.Background()
	if o.Image == "" {
		o.Image = itImage
	}
	o.Name = fmt.Sprintf("%s-%d-%d", e.prefix, gen, time.Now().UnixNano()%100000)
	o.Labels = map[string]string{
		docker.LabelService:       e.svc,
		docker.LabelGeneration:    fmt.Sprint(gen),
		docker.LabelReplica:       "0",
		docker.LabelKind:          "app",
		docker.LabelPrefix + "it": "observe",
	}
	id, err := e.dk.Create(ctx, o)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { _ = e.dk.Remove(context.Background(), id) })
	if err := e.dk.Start(ctx, id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

// component starts one of the wired background loops until the returned
// stop is called.
func (e *itEnv) component(name string) (stop func()) {
	e.t.Helper()
	for _, c := range e.d.Components.List() {
		if c.Name == name {
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				defer close(done)
				if err := c.Run(ctx); err != nil {
					e.t.Errorf("%s: %v", name, err)
				}
			}()
			return func() { cancel(); <-done }
		}
	}
	e.t.Fatalf("no component %s", name)
	return nil
}

func eventually(t *testing.T, what string, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (e *itEnv) search(query string) []*agentv1.LogEntry {
	e.t.Helper()
	var resp agentv1.LogsSearchResponse
	if err := e.panel.Call(context.Background(), "LogsSearch", &agentv1.LogsSearchRequest{ServiceId: e.svc, Query: query}, &resp); err != nil {
		e.t.Fatal(err)
	}
	return resp.GetEntries()
}

func TestITLogsAcrossGenerations(t *testing.T) {
	e := newITEnv(t)
	stop := e.component("logs-capture")
	ctx := context.Background()

	gen1 := e.run(1, dockerapi.CreateOptions{Cmd: []string{"sh", "-c", "echo gen1-out; echo gen1-err >&2; sleep 1"}})
	if code, err := e.dk.Wait(ctx, gen1); err != nil || code != 0 {
		t.Fatalf("gen1 exit %d %v", code, err)
	}
	eventually(t, "gen1 lines", 10*time.Second, func() bool { return len(e.search("gen1-")) == 2 })
	// The deploy removes the old container; its logs stay.
	if err := e.dk.Remove(ctx, gen1); err != nil {
		t.Fatal(err)
	}
	e.run(2, dockerapi.CreateOptions{Cmd: []string{"sh", "-c", "echo gen2-start; i=0; while true; i=$((i+1)); do echo tick $i; sleep 0.3; done"}})

	st, err := e.panel.Open(ctx, "LogsFollow", &agentv1.LogsFollowRequest{Target: &agentv1.LogsFollowRequest_ServiceId{ServiceId: e.svc}, Tail: 100})
	if err != nil {
		t.Fatal(err)
	}
	var seen []*agentv1.LogEntry
	deadline := time.Now().Add(15 * time.Second)
	for !hasLine(seen, "tick 5") {
		if time.Now().After(deadline) {
			t.Fatalf("follow saw %d lines, no tick 5", len(seen))
		}
		var batch agentv1.LogsFollowResponse
		if err := st.Recv(&batch); err != nil {
			t.Fatal(err)
		}
		seen = append(seen, batch.GetEntries()...)
	}
	for _, want := range []string{"gen1-out", "gen1-err", "gen2-start"} {
		if !hasLine(seen, want) {
			t.Fatalf("follow missed %q", want)
		}
	}
	errLine := e.search("gen1-err")
	if len(errLine) != 1 || errLine[0].GetStream() != agentv1.LogStream_LOG_STREAM_STDERR || errLine[0].GetGeneration() != 1 {
		t.Fatalf("gen1 stderr line = %v", errLine)
	}
	if g := e.search("gen2-start"); len(g) != 1 || g[0].GetGeneration() != 2 || len(g[0].GetContainerId()) != 12 {
		t.Fatalf("gen2 = %v", g)
	}

	// Agent restart: a new capturer continues from the saved cursor without
	// repeating lines.
	stop()
	time.Sleep(1 * time.Second)
	stop = e.component("logs-capture")
	defer stop()
	last := len(e.search("tick"))
	eventually(t, "ticks after restart", 10*time.Second, func() bool { return len(e.search("tick")) > last+3 })
	if n := len(e.search("gen2-start")); n != 1 {
		t.Fatalf("gen2-start captured %d times after restart", n)
	}
	ticks := e.search("tick ")
	seenTick := map[string]bool{}
	for _, l := range ticks {
		if seenTick[l.GetLine()] {
			t.Fatalf("duplicate %q after restart", l.GetLine())
		}
		seenTick[l.GetLine()] = true
	}
	// Ticks taken while no capturer ran were caught up from Docker.
	for i := 1; i < len(ticks); i++ {
		if !seenTick[fmt.Sprintf("tick %d", i)] {
			t.Fatalf("tick %d missing (have %d ticks)", i, len(ticks))
		}
	}
	tail, err := e.d.Logs.Tail(e.svc, 3)
	if err != nil || len(tail) != 3 || !strings.HasPrefix(tail[2], "tick ") {
		t.Fatalf("Tail = %v %v", tail, err)
	}
}

func hasLine(es []*agentv1.LogEntry, line string) bool {
	for _, e := range es {
		if e.GetLine() == line {
			return true
		}
	}
	return false
}

// termReader collects output from a Console or Shell stream.
type termReader struct {
	t         *testing.T
	st        rpc.Stream
	shell     bool
	out       bytes.Buffer
	exit      *int32
	info      *agentv1.ConsoleInfo
	shellInfo *agentv1.ShellInfo
}

func (r *termReader) next() error {
	if r.shell {
		var m agentv1.ShellResponse
		if err := r.st.Recv(&m); err != nil {
			return err
		}
		r.out.Write(m.GetOutput())
		switch x := m.GetMessage().(type) {
		case *agentv1.ShellResponse_ExitCode:
			r.exit = &x.ExitCode
		case *agentv1.ShellResponse_Info:
			r.shellInfo = x.Info
		}
		return nil
	}
	var m agentv1.ConsoleResponse
	if err := r.st.Recv(&m); err != nil {
		return err
	}
	r.out.Write(m.GetOutput())
	switch x := m.GetMessage().(type) {
	case *agentv1.ConsoleResponse_ExitCode:
		r.exit = &x.ExitCode
	case *agentv1.ConsoleResponse_Info:
		r.info = x.Info
	}
	return nil
}

func (r *termReader) until(want string) {
	r.t.Helper()
	for !strings.Contains(r.out.String(), want) {
		if err := r.next(); err != nil {
			r.t.Fatalf("waiting for %q: %v (have %q)", want, err, r.out.String())
		}
	}
}

func (r *termReader) untilExit() int32 {
	r.t.Helper()
	for r.exit == nil {
		if err := r.next(); err != nil {
			r.t.Fatalf("waiting for exit: %v (have %q)", err, r.out.String())
		}
	}
	return *r.exit
}

func TestITConsoleEcho(t *testing.T) {
	e := newITEnv(t)
	ctx := context.Background()
	e.run(1, dockerapi.CreateOptions{OpenStdin: true, Cmd: []string{"sh", "-c", `echo ready; while read l; do [ "$l" = quit ] && exit 3; echo "got:$l"; done`}})
	time.Sleep(500 * time.Millisecond)
	st, err := e.panel.Open(ctx, "Console", &agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Open{Open: &agentv1.ConsoleOpen{ServiceId: e.svc}}})
	if err != nil {
		t.Fatal(err)
	}
	r := &termReader{t: t, st: st}
	if err := r.next(); err != nil || r.info == nil {
		t.Fatalf("first message: %v %v", r.info, err)
	}
	if !r.info.GetStdinOpen() || r.info.GetGeneration() != 1 || r.info.GetTty() || r.info.GetUser() != "root" || r.info.GetWorkingDir() != "/" {
		t.Fatalf("info = %v", r.info)
	}
	r.until("ready") // replayed history
	if err := st.Send(&agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Stdin{Stdin: []byte("hello\n")}}); err != nil {
		t.Fatal(err)
	}
	r.until("got:hello")
	_ = st.Send(&agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Stdin{Stdin: []byte("quit\n")}})
	if code := r.untilExit(); code != 3 {
		t.Fatalf("exit code = %d", code)
	}
	if err := st.Finish(nil); err != nil {
		t.Fatalf("finish: %v", err)
	}

	// No running container: a clear FAILED_PRECONDITION.
	st, _ = e.panel.Open(ctx, "Console", &agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Open{Open: &agentv1.ConsoleOpen{ServiceId: e.svc}}})
	if err := st.Finish(nil); rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION {
		t.Fatalf("console on a stopped service = %v", err)
	}
}

func (e *itEnv) exec(cmd ...string) *agentv1.ExecResponse {
	e.t.Helper()
	var resp agentv1.ExecResponse
	if err := e.panel.Call(context.Background(), "Exec", &agentv1.ExecRequest{ServiceId: e.svc, Command: cmd}, &resp); err != nil {
		e.t.Fatal(err)
	}
	return &resp
}

func TestITShellPTY(t *testing.T) {
	e := newITEnv(t)
	ctx := context.Background()
	e.run(1, dockerapi.CreateOptions{Cmd: []string{"sleep", "600"}})
	open := &agentv1.ShellOpen{ServiceId: e.svc, Size: &agentv1.TerminalSize{Columns: 100, Rows: 30}}
	st, err := e.panel.Open(ctx, "Shell", &agentv1.ShellRequest{Message: &agentv1.ShellRequest_Open{Open: open}})
	if err != nil {
		t.Fatal(err)
	}
	r := &termReader{t: t, st: st, shell: true}
	if err := r.next(); err != nil || r.shellInfo == nil || r.shellInfo.GetUser() != "root" || r.shellInfo.GetWorkingDir() != "/" ||
		r.shellInfo.GetGeneration() != 1 || len(r.shellInfo.GetCommand()) == 0 {
		t.Fatalf("first shell message: %v %v", r.shellInfo, err)
	}
	input := func(s string) {
		if err := st.Send(&agentv1.ShellRequest{Message: &agentv1.ShellRequest_Input{Input: []byte(s)}}); err != nil {
			t.Fatal(err)
		}
	}
	input("echo $((40+2))\n")
	r.until("42\r\n") // the PTY turns \n into \r\n
	_ = st.Send(&agentv1.ShellRequest{Message: &agentv1.ShellRequest_Resize{Resize: &agentv1.TerminalSize{Columns: 120, Rows: 40}}})
	time.Sleep(200 * time.Millisecond)
	input("stty size\n")
	r.until("40 120")
	// Leave a background job and hang up: the sweep must remove it.
	input("sleep 1234 &\n")
	time.Sleep(300 * time.Millisecond)
	if ps := e.exec("ps", "-o", "args"); !strings.Contains(string(ps.GetStdout()), "sleep 1234") {
		t.Fatalf("background job not running: %s", ps.GetStdout())
	}
	_ = st.CloseSend()
	_ = st.Finish(nil)
	eventually(t, "the hung-up shell's job to be killed", 10*time.Second, func() bool {
		return !strings.Contains(string(e.exec("ps", "-o", "args").GetStdout()), "sleep 1234")
	})

	st, _ = e.panel.Open(ctx, "Shell", &agentv1.ShellRequest{Message: &agentv1.ShellRequest_Open{Open: open}})
	r = &termReader{t: t, st: st, shell: true}
	_ = st.Send(&agentv1.ShellRequest{Message: &agentv1.ShellRequest_Input{Input: []byte("exit 5\n")}})
	if code := r.untilExit(); code != 5 {
		t.Fatalf("shell exit code = %d", code)
	}
	if err := st.Finish(nil); err != nil {
		t.Fatal(err)
	}
}

func TestITExec(t *testing.T) {
	e := newITEnv(t)
	ctx := context.Background()
	e.run(1, dockerapi.CreateOptions{Cmd: []string{"sleep", "600"}})
	var resp agentv1.ExecResponse
	err := e.panel.Call(ctx, "Exec", &agentv1.ExecRequest{ServiceId: e.svc, Command: []string{"sh", "-c", "cat; echo oops >&2; exit 7"}, Stdin: []byte("from stdin")}, &resp)
	if err != nil {
		t.Fatal(err)
	}
	if string(resp.GetStdout()) != "from stdin" || string(resp.GetStderr()) != "oops\n" || resp.GetExitCode() != 7 || resp.GetTruncated() {
		t.Fatalf("exec = %q %q %d", resp.GetStdout(), resp.GetStderr(), resp.GetExitCode())
	}
	err = e.panel.Call(ctx, "Exec", &agentv1.ExecRequest{ServiceId: e.svc, Command: []string{"sh", "-c", "head -c 3000000 /dev/zero"}}, &resp)
	if err != nil || len(resp.GetStdout()) != 1<<20 || !resp.GetTruncated() {
		t.Fatalf("big output = %d bytes truncated %v err %v", len(resp.GetStdout()), resp.GetTruncated(), err)
	}
	start := time.Now()
	err = e.panel.Call(ctx, "Exec", &agentv1.ExecRequest{ServiceId: e.svc, Command: []string{"sleep", "30"}, Timeout: durationpb.New(time.Second)}, &resp)
	if rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED || time.Since(start) > 10*time.Second {
		t.Fatalf("timeout = %v after %s", err, time.Since(start))
	}
	eventually(t, "the timed out command to be killed", 5*time.Second, func() bool {
		return !strings.Contains(string(e.exec("ps", "-o", "args").GetStdout()), "sleep 30")
	})
}

func TestITStatsSample(t *testing.T) {
	e := newITEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.run(1, dockerapi.CreateOptions{Cmd: []string{"sh", "-c", "while :; do :; done"}})
	st, err := e.panel.Open(ctx, "WatchMetrics", &agentv1.WatchMetricsRequest{ServiceIds: []string{e.svc}, Interval: durationpb.New(time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	var last *agentv1.ServiceUsage
	for range 2 {
		var m agentv1.WatchMetricsResponse
		if err := st.Recv(&m); err != nil {
			t.Fatal(err)
		}
		if m.GetSample().GetNode().GetMemoryTotalBytes() == 0 || m.GetSample().GetNode().GetCpuCount() == 0 {
			t.Fatalf("node = %v", m.GetSample().GetNode())
		}
		if len(m.GetSample().GetServices()) != 1 {
			t.Fatalf("services = %v", m.GetSample().GetServices())
		}
		last = m.GetSample().GetServices()[0]
	}
	if last.GetCpuPercent() < 50 || last.GetMemoryUsedBytes() == 0 || last.GetInstances() != 1 || last.GetServiceId() != e.svc {
		t.Fatalf("busy loop usage = %v", last)
	}
	cancel()

	// The periodic collector publishes events and keeps the latest one.
	c := metrics.NewDockerCollector(e.dk, e.d.Layout.Root(), time.Second)
	rctx, rcancel := context.WithTimeout(context.Background(), 3500*time.Millisecond)
	defer rcancel()
	published := 0
	_ = c.Run(rctx, func(*agentv1.MetricsReport) { published++ })
	hist := c.History(time.Time{}, []string{e.svc})
	if published < 2 || len(hist) != 1 || len(hist[0].GetServices()) != 1 {
		t.Fatalf("published %d, history %d", published, len(hist))
	}
	node := hist[len(hist)-1].GetNode()
	if len(node.GetDisks()) == 0 || node.GetDiskTotalBytes() == 0 || node.GetNetworkRxBytes() == 0 {
		t.Fatalf("node usage = %v", node)
	}
	t.Logf("service %v; node cpu %.1f%% mem %d/%d disks %d", last, node.GetCpuPercent(), node.GetMemoryUsedBytes(), node.GetMemoryTotalBytes(), len(node.GetDisks()))
}

func TestITFilesVolume(t *testing.T) {
	e := newITEnv(t, "data")
	ctx := context.Background()
	vol, err := e.d.Layout.ServiceVolume(e.svc, "data")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(vol, 0o777); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(vol, 0o777)
	// The container (uid 1000) makes a folder and plants hostile links.
	e.run(1, dockerapi.CreateOptions{
		User:  "1000:1000",
		Binds: []string{vol + ":/data"},
		Cmd:   []string{"sh", "-c", "mkdir /data/sub; ln -s / /data/hostroot; ln -s /etc/shadow /data/shadow; ln -s ../../../../etc /data/up; sleep 600"},
	})
	root := &agentv1.FsRoot{ServiceId: e.svc, Volume: "data"}
	eventually(t, "the container's files", 5*time.Second, func() bool {
		var l agentv1.FsListResponse
		return e.panel.Call(ctx, "FsList", &agentv1.FsListRequest{Root: root}, &l) == nil && len(l.GetEntries()) == 4
	})
	for _, p := range []string{"hostroot/etc/shadow", "shadow", "up/passwd", "hostroot"} {
		down, err := e.panel.Open(ctx, "FsRead", &agentv1.FsReadRequest{Root: root, Path: p})
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(down)
		if err := down.Finish(&agentv1.FsReadResponse{}); err == nil || len(b) > 0 {
			t.Fatalf("read %s through a hostile link: %d bytes, err %v", p, len(b), err)
		}
	}
	err = e.panel.Call(ctx, "FsMkdir", &agentv1.FsMkdirRequest{Root: root, Path: "hostroot/tmp/seylo-it-pwned"}, &agentv1.FsMkdirResponse{})
	if rpc.StatusOf(err).GetCode() != agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED {
		t.Fatalf("mkdir through link = %v", err)
	}
	if _, err := os.Stat("/tmp/seylo-it-pwned"); err == nil {
		t.Fatal("escaped to the host")
	}

	// 5 MB upload into the container's folder, then download and compare.
	content := make([]byte, 5<<20)
	_, _ = rand.Read(content)
	up, err := e.panel.Open(ctx, "FsWrite", &agentv1.FsWriteRequest{Root: root, Path: "sub/up.bin", SizeBytes: uint64(len(content))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := up.Write(content); err != nil {
		t.Fatal(err)
	}
	_ = up.CloseSend()
	var w agentv1.FsWriteResponse
	if err := up.Finish(&w); err != nil {
		t.Fatal(err)
	}
	if w.GetInfo().GetUid() != 1000 || w.GetInfo().GetGid() != 1000 {
		t.Fatalf("uploaded file owner %d:%d, want the folder's 1000:1000", w.GetInfo().GetUid(), w.GetInfo().GetGid())
	}
	down, _ := e.panel.Open(ctx, "FsRead", &agentv1.FsReadRequest{Root: root, Path: "sub/up.bin"})
	got, _ := io.ReadAll(down)
	if err := down.Finish(&agentv1.FsReadResponse{}); err != nil || !bytes.Equal(got, content) {
		t.Fatalf("download: %d bytes, err %v", len(got), err)
	}
	sum := md5.Sum(content)
	if out := string(e.exec("md5sum", "/data/sub/up.bin").GetStdout()); !strings.HasPrefix(out, hex.EncodeToString(sum[:])) {
		t.Fatalf("container sees %q", out)
	}
	if out := string(e.exec("sh", "-c", "echo more >> /data/sub/up.bin && echo ok").GetStdout()); out != "ok\n" {
		t.Fatalf("container cannot write the uploaded file: %q", out)
	}
	if fi, err := os.Stat(filepath.Join(vol, "sub", "up.bin")); err != nil || fi.Size() != int64(len(content))+5 {
		t.Fatalf("after container append: %v %v", fi, err)
	}
}

// TTY containers write one raw stream (no stdout/stderr frames, \r\n line
// ends): capture and the console must handle both.
func TestITTTYContainer(t *testing.T) {
	e := newITEnv(t)
	stop := e.component("logs-capture")
	defer stop()
	ctx := context.Background()
	e.run(3, dockerapi.CreateOptions{Tty: true, OpenStdin: true, Cmd: []string{"sh", "-c", `echo tty-hello; while read l; do echo "tty-got:$l"; done`}})
	eventually(t, "tty line captured", 10*time.Second, func() bool { return len(e.search("tty-hello")) == 1 })
	if got := e.search("tty-hello")[0]; got.GetLine() != "tty-hello" || got.GetGeneration() != 3 {
		t.Fatalf("tty line = %q", got.GetLine())
	}
	st, err := e.panel.Open(ctx, "Console", &agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Open{Open: &agentv1.ConsoleOpen{ServiceId: e.svc}}})
	if err != nil {
		t.Fatal(err)
	}
	r := &termReader{t: t, st: st}
	if err := r.next(); err != nil || !r.info.GetTty() {
		t.Fatalf("info = %v %v", r.info, err)
	}
	r.until("tty-hello")
	_ = st.Send(&agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Resize{Resize: &agentv1.TerminalSize{Columns: 90, Rows: 20}}})
	_ = st.Send(&agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Stdin{Stdin: []byte("ping\r")}})
	r.until("tty-got:ping")
	eventually(t, "tty echo captured", 10*time.Second, func() bool { return len(e.search("tty-got:ping")) == 1 })
	_ = st.CloseSend()
}

// The Shell tab's database client: redis-cli already signed in.
func TestITDatabaseShell(t *testing.T) {
	e := newITEnv(t)
	const image = "redis:7.4.1-alpine"
	pctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := e.dk.PullImage(pctx, image); err != nil {
		t.Skipf("cannot pull %s: %v", image, err)
	}
	e.d.Feed.Publish(&agentv1.DesiredState{Revision: 2, Services: []*agentv1.ServiceSpec{{
		Id:   e.svc,
		Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
			Engine:      agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: "default", AdminPassword: "s3cret-pw"},
		}},
	}}})
	e.run(1, dockerapi.CreateOptions{Image: image, Cmd: []string{"redis-server", "--requirepass", "s3cret-pw"}})
	time.Sleep(500 * time.Millisecond)
	st, err := e.panel.Open(context.Background(), "Shell", &agentv1.ShellRequest{Message: &agentv1.ShellRequest_Open{Open: &agentv1.ShellOpen{ServiceId: e.svc, DatabaseClient: true}}})
	if err != nil {
		t.Fatal(err)
	}
	r := &termReader{t: t, st: st, shell: true}
	// Type only once redis-cli shows its prompt (and its raw-mode editor
	// is on), like a person would.
	r.until("6379>")
	_ = st.Send(&agentv1.ShellRequest{Message: &agentv1.ShellRequest_Input{Input: []byte("SET itkey works\r")}})
	r.until("OK")
	_ = st.Send(&agentv1.ShellRequest{Message: &agentv1.ShellRequest_Input{Input: []byte("GET itkey\r")}})
	r.until("\"works\"")
	if strings.Contains(r.out.String(), "NOAUTH") {
		t.Fatalf("client was not signed in: %q", r.out.String())
	}
	_ = st.CloseSend()
	_ = st.Finish(nil)
	for _, line := range strings.Split(string(e.exec("ps", "-o", "args").GetStdout()), "\n") {
		if strings.Contains(line, "redis-cli") && strings.Contains(line, "s3cret-pw") {
			t.Fatalf("password visible in a process listing: %q", line)
		}
	}
}
