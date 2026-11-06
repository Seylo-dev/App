package rpctest_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/stub"
)

type (
	logsStream    = rpc.TypedStream[*agentv1.LogsFollowRequest, *agentv1.LogsFollowResponse]
	consoleStream = rpc.TypedStream[*agentv1.ConsoleRequest, *agentv1.ConsoleResponse]
)

func TestUnary(t *testing.T) {
	reg := rpc.NewAgentMux()
	rpc.HandleUnary(reg, "RestartService", func(ctx context.Context, req *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
		info, ok := rpc.CallInfoFrom(ctx)
		if !ok || info.Method != "/seylo.agent.v1.AgentService/RestartService" || info.Metadata["user_id"] != "u1" {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, "bad call info")
		}
		switch req.GetServiceId() {
		case "web":
			return &agentv1.RestartServiceResponse{}, nil
		case "missing":
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "service missing not found")
		case "stub":
			return nil, stub.NotImplemented("reconcile.Engine.Restart")
		default:
			return nil, errors.New("open /var/lib/seylo/x: denied")
		}
	})
	panel := rpctest.NewPeer(t, reg)
	ctx := rpc.WithMetadata(context.Background(), map[string]string{"user_id": "u1"})

	tests := []struct {
		id   string
		code agentv1.StatusCode
		msg  string
	}{
		{"web", agentv1.StatusCode_STATUS_CODE_OK, ""},
		{"missing", agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "service missing not found"},
		{"stub", agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED, "reconcile.Engine.Restart: not implemented yet"},
		// Internals never reach the panel.
		{"other", agentv1.StatusCode_STATUS_CODE_INTERNAL, "internal error"},
	}
	for _, tt := range tests {
		err := panel.Call(ctx, "RestartService", &agentv1.RestartServiceRequest{ServiceId: tt.id}, &agentv1.RestartServiceResponse{})
		if s := rpc.StatusOf(err); s.GetCode() != tt.code || s.GetMessage() != tt.msg {
			t.Errorf("%s: status %v %q, want %v %q", tt.id, s.GetCode(), s.GetMessage(), tt.code, tt.msg)
		}
	}

	err := panel.Call(ctx, "ApplyService", &agentv1.ApplyServiceRequest{}, &agentv1.ApplyServiceResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED {
		t.Fatalf("unregistered method: %v", s)
	}
}

func TestServerStreamingFlowControl(t *testing.T) {
	const total = 64
	line := strings.Repeat("x", 1000)
	sent := make(chan int, total)
	reg := rpc.NewAgentMux()
	rpc.HandleStream(reg, "LogsFollow", func(ctx context.Context, req *agentv1.LogsFollowRequest, s *logsStream) error {
		if req.GetServiceId() != "web" {
			return rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "service_id")
		}
		for i := range total {
			if err := s.Send(&agentv1.LogsFollowResponse{Entries: []*agentv1.LogEntry{{Line: line}}}); err != nil {
				return err
			}
			sent <- i
		}
		return nil
	})
	// An 8 KiB window holds about 8 messages: the handler must stall until
	// the caller reads.
	panel := rpctest.NewPeer(t, reg, rpctest.WithWindow(8<<10))
	ctx := context.Background()
	st, err := panel.Open(ctx, "LogsFollow", &agentv1.LogsFollowRequest{Target: &agentv1.LogsFollowRequest_ServiceId{ServiceId: "web"}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(sent); n == 0 || n > 9 {
		t.Fatalf("handler sent %d messages without credit for them", n)
	}
	got := 0
	for {
		var msg agentv1.LogsFollowResponse
		err := st.Recv(&msg)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if msg.GetEntries()[0].GetLine() != line {
			t.Fatal("corrupted message")
		}
		got++
	}
	if got != total {
		t.Fatalf("received %d, want %d", got, total)
	}
	if err := st.Finish(nil); err != nil {
		t.Fatalf("Finish = %v", err)
	}

	// A handler error arrives after the data, as the stream's status.
	st, _ = panel.Open(ctx, "LogsFollow", &agentv1.LogsFollowRequest{})
	err = st.Recv(&agentv1.LogsFollowResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT {
		t.Fatalf("Recv = %v", err)
	}
}

func TestBidiStreamingAndCancel(t *testing.T) {
	reg := rpc.NewAgentMux()
	handlerDone := make(chan error, 1)
	rpc.HandleStream(reg, "Console", func(ctx context.Context, first *agentv1.ConsoleRequest, s *consoleStream) error {
		if first.GetOpen().GetServiceId() != "web" {
			return rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "open first")
		}
		for {
			req, err := s.Recv()
			if err == io.EOF {
				return s.Send(&agentv1.ConsoleResponse{Message: &agentv1.ConsoleResponse_ExitCode{ExitCode: 0}})
			}
			if err != nil {
				handlerDone <- err
				return err
			}
			if err := s.Send(&agentv1.ConsoleResponse{Message: &agentv1.ConsoleResponse_Output{Output: bytes.ToUpper(req.GetStdin())}}); err != nil {
				return err
			}
		}
	})
	panel := rpctest.NewPeer(t, reg)
	open := &agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Open{Open: &agentv1.ConsoleOpen{ServiceId: "web"}}}

	st, err := panel.Open(context.Background(), "Console", open)
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range []string{"ls", "pwd"} {
		if err := st.Send(&agentv1.ConsoleRequest{Message: &agentv1.ConsoleRequest_Stdin{Stdin: []byte(in)}}); err != nil {
			t.Fatal(err)
		}
		var out agentv1.ConsoleResponse
		if err := st.Recv(&out); err != nil || string(out.GetOutput()) != strings.ToUpper(in) {
			t.Fatalf("echo %q = %q, %v", in, out.GetOutput(), err)
		}
	}
	if err := st.CloseSend(); err != nil {
		t.Fatal(err)
	}
	var exit agentv1.ConsoleResponse
	if err := st.Recv(&exit); err != nil || exit.GetMessage() == nil {
		t.Fatalf("exit = %v, %v", &exit, err)
	}
	if err := st.Finish(nil); err != nil {
		t.Fatal(err)
	}

	// Cancelling the caller's ctx cancels the handler's.
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := panel.Open(ctx, "Console", open); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-handlerDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("handler saw %v", err)
		}
	case <-time.After(rpctest.WaitTimeout):
		t.Fatal("handler not cancelled")
	}
}

func TestRawDownloadUploadBidi(t *testing.T) {
	content := bytes.Repeat([]byte("seylo"), 50_000) // 250 KB, several windows
	reg := rpc.NewAgentMux()
	rpc.HandleRaw(reg, "FsRead", func(ctx context.Context, req *agentv1.FsReadRequest, s rpc.RawStream) (*agentv1.FsReadResponse, error) {
		if _, err := s.Read(make([]byte, 1)); err != io.EOF {
			return nil, errors.New("download must not see uploaded bytes")
		}
		if _, err := s.Write(content); err != nil {
			return nil, err
		}
		return &agentv1.FsReadResponse{Info: &agentv1.FileInfo{Path: req.GetPath(), Size: uint64(len(content))}}, nil
	})
	rpc.HandleRaw(reg, "FsWrite", func(ctx context.Context, req *agentv1.FsWriteRequest, s rpc.RawStream) (*agentv1.FsWriteResponse, error) {
		b, err := io.ReadAll(s)
		if err != nil {
			return nil, err
		}
		if _, err := s.Write([]byte("x")); err == nil {
			return nil, errors.New("upload must not send bytes back")
		}
		return &agentv1.FsWriteResponse{Info: &agentv1.FileInfo{Size: uint64(len(b))}}, nil
	})
	rpc.HandleRaw(reg, "Tunnel", func(ctx context.Context, req *agentv1.TunnelRequest, s rpc.RawStream) (*agentv1.TunnelResponse, error) {
		_, err := io.Copy(s, s) // echo
		return &agentv1.TunnelResponse{}, err
	})
	panel := rpctest.NewPeer(t, reg, rpctest.WithWindow(16<<10))
	ctx := context.Background()

	st, err := panel.Open(ctx, "FsRead", &agentv1.FsReadRequest{Path: "a.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Write([]byte("x")); err == nil {
		t.Fatal("caller wrote to a download")
	}
	got, err := io.ReadAll(st)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("download: %d bytes, %v", len(got), err)
	}
	var readResp agentv1.FsReadResponse
	if err := st.Finish(&readResp); err != nil || readResp.GetInfo().GetPath() != "a.txt" {
		t.Fatalf("Finish = %v, %v", &readResp, err)
	}

	st, _ = panel.Open(ctx, "FsWrite", &agentv1.FsWriteRequest{Path: "b.txt"})
	if _, err := st.Write(content); err != nil {
		t.Fatal(err)
	}
	_ = st.CloseSend()
	var writeResp agentv1.FsWriteResponse
	if err := st.Finish(&writeResp); err != nil || writeResp.GetInfo().GetSize() != uint64(len(content)) {
		t.Fatalf("upload Finish = %v, %v", &writeResp, err)
	}

	st, _ = panel.Open(ctx, "Tunnel", &agentv1.TunnelRequest{})
	go func() {
		_, _ = st.Write(content)
		_ = st.CloseSend()
	}()
	echoed, err := io.ReadAll(st)
	if err != nil || !bytes.Equal(echoed, content) {
		t.Fatalf("tunnel echoed %d bytes, %v", len(echoed), err)
	}
	if err := st.Finish(&agentv1.TunnelResponse{}); err != nil {
		t.Fatal(err)
	}
}

func TestPanicBecomesInternal(t *testing.T) {
	reg := rpc.NewAgentMux()
	rpc.HandleUnary(reg, "RestartService", func(context.Context, *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
		panic("boom")
	})
	ft := &fakeTB{TB: t}
	panel := rpctest.NewPeer(ft, reg)
	err := panel.Call(context.Background(), "RestartService", &agentv1.RestartServiceRequest{}, &agentv1.RestartServiceResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_INTERNAL {
		t.Fatalf("status = %v", s)
	}
	if !ft.failed {
		t.Fatal("a handler panic must fail the test")
	}
}

// fakeTB records Errorf instead of failing the real test.
type fakeTB struct {
	testing.TB
	failed bool
}

func (f *fakeTB) Errorf(string, ...any) { f.failed = true }

func TestRecorder(t *testing.T) {
	r := rpctest.NewRecorder()
	go func() {
		r.Emit(&agentv1.Event{Payload: &agentv1.Event_DeployProgress{DeployProgress: &agentv1.DeployProgress{ServiceId: "web"}}})
		_ = r.Event(context.Background(), &agentv1.Event{Payload: &agentv1.Event_CronRun{CronRun: &agentv1.CronRun{RunId: "r1"}}})
		_ = r.Crash(context.Background(), &agentv1.CrashReport{ServiceId: "web", Streak: 2})
	}()
	ev := r.WaitEmitted(t, func(e *agentv1.Event) bool { return e.GetDeployProgress().GetServiceId() == "web" })
	if ev.GetTime() == nil {
		t.Fatal("emitted event has no time")
	}
	r.WaitDurable(t, func(e *agentv1.Event) bool { return e.GetCronRun().GetRunId() == "r1" })
	c := r.WaitCrash(t, func(c *agentv1.CrashReport) bool { return c.GetServiceId() == "web" })
	if c.GetStreak() != 2 || len(r.Crashes()) != 1 || len(r.Durable()) != 1 || len(r.Emitted()) != 1 {
		t.Fatal("recorder lost or duplicated entries")
	}
	if !proto.Equal(r.Crashes()[0], c) {
		t.Fatal("Crashes and WaitCrash disagree")
	}
}
