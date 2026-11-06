package rpc_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// pair connects an agent session (dialer, serving agentMux) and a panel
// session (acceptor, serving panelMux) over an in-memory pipe.
type pair struct {
	agent, panel *rpc.Session
	panelEvents  chan *agentv1.Event
	agentErr     chan error
}

func newPair(t *testing.T, agentMux, panelMux *rpc.Mux, window uint32) *pair {
	t.Helper()
	if agentMux == nil {
		agentMux = rpc.NewAgentMux()
	}
	if panelMux == nil {
		panelMux = rpc.NewPanelMux()
	}
	for _, m := range []*rpc.Mux{agentMux, panelMux} {
		if err := m.Err(); err != nil {
			t.Fatal(err)
		}
	}
	a, b := conn.Pipe()
	p := &pair{panelEvents: make(chan *agentv1.Event, 16), agentErr: make(chan error, 1)}
	p.agent = rpc.NewSession(rpc.SessionConfig{
		Transport: a, Role: conn.RoleDialer, Handlers: agentMux,
		PeerCapabilities: registeredCaps(panelMux), InitialWindow: window,
	})
	p.panel = rpc.NewSession(rpc.SessionConfig{
		Transport: b, Role: conn.RoleAcceptor, Handlers: panelMux,
		PeerCapabilities: registeredCaps(agentMux), InitialWindow: window,
		OnEvent: func(e *agentv1.Event) { p.panelEvents <- e },
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { p.agentErr <- p.agent.Serve(ctx) }()
	go func() { _ = p.panel.Serve(ctx) }()
	t.Cleanup(func() {
		cancel()
		<-p.agent.Done()
		<-p.panel.Done()
	})
	return p
}

// registeredCaps advertises the capability of every registered method, so
// tests need not register whole capabilities.
func registeredCaps(m *rpc.Mux) []string {
	var caps []string
	for _, name := range m.Registered() {
		h, _ := m.Lookup(name)
		caps = append(caps, h.Capability)
	}
	return caps
}

func ctxT(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func code(err error) agentv1.StatusCode { return rpc.StatusOf(err).GetCode() }

func TestUnaryBothWays(t *testing.T) {
	agentMux := rpc.NewAgentMux()
	var gotInfo atomic.Pointer[rpc.CallInfo]
	rpc.HandleUnary(agentMux, "GetNodeFacts", func(ctx context.Context, _ *agentv1.GetNodeFactsRequest) (*agentv1.GetNodeFactsResponse, error) {
		info, _ := rpc.CallInfoFrom(ctx)
		gotInfo.Store(info)
		return &agentv1.GetNodeFactsResponse{Facts: &agentv1.NodeFacts{Hostname: "n1"}}, nil
	})
	panelMux := rpc.NewPanelMux()
	var reported atomic.Uint64
	rpc.HandleUnary(panelMux, "ReportEvent", func(ctx context.Context, req *agentv1.ReportEventRequest) (*agentv1.ReportEventResponse, error) {
		reported.Store(req.GetOutboxId())
		return &agentv1.ReportEventResponse{}, nil
	})
	rpc.HandleUnary(panelMux, "ReportCrash", func(ctx context.Context, req *agentv1.ReportCrashRequest) (*agentv1.ReportCrashResponse, error) {
		return nil, nil // nil response means an empty one
	})
	p := newPair(t, agentMux, panelMux, 0)
	ctx := ctxT(t)

	var facts agentv1.GetNodeFactsResponse
	callCtx, cancel := context.WithTimeout(rpc.WithMetadata(ctx, map[string]string{"user_id": "u1"}), 5*time.Second)
	defer cancel()
	if err := p.panel.Call(callCtx, "GetNodeFacts", &agentv1.GetNodeFactsRequest{}, &facts); err != nil {
		t.Fatal(err)
	}
	if facts.GetFacts().GetHostname() != "n1" {
		t.Fatalf("facts = %v", facts.GetFacts())
	}
	info := gotInfo.Load()
	if info.Metadata["user_id"] != "u1" || info.Deadline.IsZero() || info.Method != "/seylo.agent.v1.AgentService/GetNodeFacts" {
		t.Fatalf("call info = %+v", info)
	}

	if err := p.agent.Call(ctx, rpc.MethodReportEvent, &agentv1.ReportEventRequest{OutboxId: 7}, &agentv1.ReportEventResponse{}); err != nil {
		t.Fatal(err)
	}
	if reported.Load() != 7 {
		t.Fatalf("outbox id = %d", reported.Load())
	}
	if err := p.agent.Call(ctx, "ReportCrash", &agentv1.ReportCrashRequest{}, &agentv1.ReportCrashResponse{}); err != nil {
		t.Fatal(err)
	}
	if s := p.panel.Stats(); s.IncomingTotal != 2 || s.OutgoingTotal != 1 || s.IncomingCalls != 0 {
		t.Fatalf("panel stats = %+v", s)
	}
}

func TestUnaryErrors(t *testing.T) {
	agentMux := rpc.NewAgentMux()
	rpc.HandleUnary(agentMux, "RestartService", func(ctx context.Context, req *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
		switch req.GetServiceId() {
		case "missing":
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "no such service")
		case "boom":
			panic("handler bug")
		default:
			return nil, errors.New("open /var/lib/secret: permission denied")
		}
	})
	p := newPair(t, agentMux, nil, 0)
	ctx := ctxT(t)
	call := func(id string) error {
		return p.panel.Call(ctx, "RestartService", &agentv1.RestartServiceRequest{ServiceId: id}, &agentv1.RestartServiceResponse{})
	}

	var rpcErr *rpc.Error
	if err := call("missing"); !errors.As(err, &rpcErr) || rpcErr.Code != agentv1.StatusCode_STATUS_CODE_NOT_FOUND || rpcErr.Message != "no such service" {
		t.Fatalf("not found = %v", err)
	}
	if err := call("other"); code(err) != agentv1.StatusCode_STATUS_CODE_INTERNAL || errors.As(err, &rpcErr) && rpcErr.Message != "internal error" {
		t.Fatalf("internal = %v", err)
	}
	if err := call("boom"); code(err) != agentv1.StatusCode_STATUS_CODE_INTERNAL {
		t.Fatalf("panic = %v", err)
	}
	if p.agent.Stats().HandlerPanics != 1 {
		t.Fatalf("panics = %d", p.agent.Stats().HandlerPanics)
	}
	// The session survives a panicking handler.
	if err := call("missing"); code(err) != agentv1.StatusCode_STATUS_CODE_NOT_FOUND {
		t.Fatalf("after panic = %v", err)
	}
	// Advertised capability, unregistered method: UNIMPLEMENTED from the agent.
	err := p.panel.Call(ctx, "GetNodeFacts", &agentv1.GetNodeFactsRequest{}, &agentv1.GetNodeFactsResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED {
		t.Fatalf("missing capability = %v", err)
	}
	// The panel advertised nothing: refused locally, no round trip.
	err = p.agent.Call(ctx, "ReportEvent", &agentv1.ReportEventRequest{}, &agentv1.ReportEventResponse{})
	if code(err) != agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED || p.agent.Stats().OutgoingTotal != 0 {
		t.Fatalf("no capability = %v, stats %+v", err, p.agent.Stats())
	}
	if err := p.panel.Call(ctx, "NoSuchMethod", &agentv1.GetNodeFactsRequest{}, nil); err == nil {
		t.Fatal("unknown method accepted")
	}
}

func TestUnaryCancelAndDeadline(t *testing.T) {
	agentMux := rpc.NewAgentMux()
	started := make(chan struct{}, 1)
	cancelled := make(chan error, 1)
	rpc.HandleUnary(agentMux, "RestartService", func(ctx context.Context, req *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
		started <- struct{}{}
		<-ctx.Done()
		cancelled <- ctx.Err()
		return nil, ctx.Err()
	})
	p := newPair(t, agentMux, nil, 0)
	ctx := ctxT(t)

	callCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- p.panel.Call(callCtx, "RestartService", &agentv1.RestartServiceRequest{}, &agentv1.RestartServiceResponse{})
	}()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("caller got %v", err)
	}
	if err := <-cancelled; !errors.Is(err, context.Canceled) {
		t.Fatalf("handler saw %v", err)
	}

	// A deadline travels with the call and ends the handler's ctx.
	short, cancel2 := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel2()
	err := p.panel.Call(short, "RestartService", &agentv1.RestartServiceRequest{}, &agentv1.RestartServiceResponse{})
	<-started
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("caller got %v", err)
	}
	if err := <-cancelled; err == nil {
		t.Fatal("handler ctx not ended")
	}
}

func TestServerStreamBackpressure(t *testing.T) {
	const window = 4 << 10
	agentMux := rpc.NewAgentMux()
	var sent atomic.Int64
	handlerErr := make(chan error, 1)
	rpc.HandleStream(agentMux, "LogsFollow", func(ctx context.Context, first *agentv1.LogsFollowRequest, s *rpc.TypedStream[*agentv1.LogsFollowRequest, *agentv1.LogsFollowResponse]) error {
		line := string(bytes.Repeat([]byte("x"), 1000))
		for i := range first.GetTail() {
			if err := s.Send(&agentv1.LogsFollowResponse{Entries: []*agentv1.LogEntry{{Line: line, Generation: uint64(i)}}}); err != nil {
				handlerErr <- err
				return err
			}
			sent.Add(1)
		}
		handlerErr <- nil
		return nil
	})
	rpc.HandleUnary(agentMux, "LogsSearch", func(ctx context.Context, _ *agentv1.LogsSearchRequest) (*agentv1.LogsSearchResponse, error) {
		return &agentv1.LogsSearchResponse{}, nil
	})
	p := newPair(t, agentMux, nil, window)
	ctx := ctxT(t)

	s, err := p.panel.Open(ctx, "LogsFollow", &agentv1.LogsFollowRequest{Tail: 50})
	if err != nil {
		t.Fatal(err)
	}
	// Without reading, the handler can only get about one window out.
	time.Sleep(200 * time.Millisecond)
	if n := sent.Load(); n < 2 || n > 6 {
		t.Fatalf("handler sent %d messages of 1 KB into a 4 KB window", n)
	}
	// Flow control is per stream: a unary call still goes through.
	if err := p.panel.Call(ctx, "LogsSearch", &agentv1.LogsSearchRequest{}, &agentv1.LogsSearchResponse{}); err != nil {
		t.Fatal(err)
	}
	for i := range 50 {
		var msg agentv1.LogsFollowResponse
		if err := s.Recv(&msg); err != nil {
			t.Fatalf("recv %d: %v", i, err)
		}
		if msg.GetEntries()[0].GetGeneration() != uint64(i) {
			t.Fatalf("message %d out of order", i)
		}
	}
	if err := s.Recv(&agentv1.LogsFollowResponse{}); err != io.EOF {
		t.Fatalf("end = %v", err)
	}
	if err := s.Finish(nil); err != nil {
		t.Fatal(err)
	}
	if err := <-handlerErr; err != nil {
		t.Fatal(err)
	}
}

func TestBidiStreamAndCancel(t *testing.T) {
	agentMux := rpc.NewAgentMux()
	handlerDone := make(chan error, 1)
	rpc.HandleStream(agentMux, "Shell", func(ctx context.Context, first *agentv1.ShellRequest, s *rpc.TypedStream[*agentv1.ShellRequest, *agentv1.ShellResponse]) error {
		for {
			req, err := s.Recv()
			if err == io.EOF {
				handlerDone <- nil
				return s.Send(&agentv1.ShellResponse{Message: &agentv1.ShellResponse_ExitCode{ExitCode: 0}})
			}
			if err != nil {
				handlerDone <- err
				return err
			}
			if err := s.Send(&agentv1.ShellResponse{Message: &agentv1.ShellResponse_Output{Output: req.GetInput()}}); err != nil {
				handlerDone <- err
				return err
			}
		}
	})
	p := newPair(t, agentMux, nil, 0)
	ctx := ctxT(t)

	s, err := p.panel.Open(ctx, "Shell", &agentv1.ShellRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range []string{"ls\n", "pwd\n"} {
		if err := s.Send(&agentv1.ShellRequest{Message: &agentv1.ShellRequest_Input{Input: []byte(in)}}); err != nil {
			t.Fatal(err)
		}
		var out agentv1.ShellResponse
		if err := s.Recv(&out); err != nil || string(out.GetOutput()) != in {
			t.Fatalf("echo = %q, %v", out.GetOutput(), err)
		}
	}
	if err := s.CloseSend(); err != nil {
		t.Fatal(err)
	}
	var exit agentv1.ShellResponse
	if err := s.Recv(&exit); err != nil || exit.GetMessage() == nil {
		t.Fatalf("exit = %v, %v", &exit, err)
	}
	if err := s.Finish(nil); err != nil {
		t.Fatal(err)
	}
	if err := <-handlerDone; err != nil {
		t.Fatal(err)
	}

	// Cancelling the opener's ctx ends the handler.
	openCtx, cancel := context.WithCancel(ctx)
	s, err = p.panel.Open(openCtx, "Shell", &agentv1.ShellRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Send(&agentv1.ShellRequest{Message: &agentv1.ShellRequest_Input{Input: []byte("x")}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Recv(&agentv1.ShellResponse{}); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := <-handlerDone; code(err) != agentv1.StatusCode_STATUS_CODE_CANCELLED {
		t.Fatalf("handler after cancel: %v", err)
	}
	if err := s.Finish(nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("finish after cancel = %v", err)
	}
}

func TestRawDownloadUploadAndBidi(t *testing.T) {
	payload := make([]byte, 3<<20+123)
	_, _ = rand.Read(payload)

	agentMux := rpc.NewAgentMux()
	rpc.HandleRaw(agentMux, "FsRead", func(ctx context.Context, req *agentv1.FsReadRequest, s rpc.RawStream) (*agentv1.FsReadResponse, error) {
		if req.GetPath() == "missing" {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "no such file")
		}
		if _, err := io.Copy(s, bytes.NewReader(payload)); err != nil {
			return nil, err
		}
		return &agentv1.FsReadResponse{Info: &agentv1.FileInfo{Size: uint64(len(payload))}}, nil
	})
	rpc.HandleRaw(agentMux, "FsWrite", func(ctx context.Context, req *agentv1.FsWriteRequest, s rpc.RawStream) (*agentv1.FsWriteResponse, error) {
		got, err := io.ReadAll(s)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(got, payload) {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_ABORTED, "corrupt upload")
		}
		return &agentv1.FsWriteResponse{Info: &agentv1.FileInfo{Size: uint64(len(got))}}, nil
	})
	panelMux := rpc.NewPanelMux()
	rpc.HandleRaw(panelMux, "RegistryTunnel", func(ctx context.Context, req *agentv1.RegistryTunnelRequest, s rpc.RawStream) (*agentv1.RegistryTunnelResponse, error) {
		_, err := io.Copy(s, s) // echo until the agent half-closes
		return &agentv1.RegistryTunnelResponse{}, err
	})
	p := newPair(t, agentMux, panelMux, 64<<10)
	ctx := ctxT(t)

	// Download.
	s, err := p.panel.Open(ctx, "FsRead", &agentv1.FsReadRequest{Path: "a"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(s)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("download: %d bytes, %v", len(got), err)
	}
	var readResp agentv1.FsReadResponse
	if err := s.Finish(&readResp); err != nil || readResp.GetInfo().GetSize() != uint64(len(payload)) {
		t.Fatalf("download response %v, %v", &readResp, err)
	}
	s, _ = p.panel.Open(ctx, "FsRead", &agentv1.FsReadRequest{Path: "missing"})
	if _, err := io.ReadAll(s); code(err) != agentv1.StatusCode_STATUS_CODE_NOT_FOUND {
		t.Fatalf("missing download = %v", err)
	}

	// Upload.
	s, err = p.panel.Open(ctx, "FsWrite", &agentv1.FsWriteRequest{Path: "b"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := s.CloseSend(); err != nil {
		t.Fatal(err)
	}
	var writeResp agentv1.FsWriteResponse
	if err := s.Finish(&writeResp); err != nil || writeResp.GetInfo().GetSize() != uint64(len(payload)) {
		t.Fatalf("upload response %v, %v", &writeResp, err)
	}

	// Bidi, opened by the agent (registry relay).
	s, err = p.agent.Open(ctx, "RegistryTunnel", &agentv1.RegistryTunnelRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var echoed bytes.Buffer
	var wg sync.WaitGroup
	wg.Go(func() { _, _ = io.Copy(&echoed, s) })
	if _, err := s.Write(payload[:1<<20]); err != nil {
		t.Fatal(err)
	}
	if err := s.CloseSend(); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if !bytes.Equal(echoed.Bytes(), payload[:1<<20]) {
		t.Fatalf("echoed %d bytes", echoed.Len())
	}
	if err := s.Finish(&agentv1.RegistryTunnelResponse{}); err != nil {
		t.Fatal(err)
	}
}

func TestStreamBlockedOnCreditDoesNotBlockCalls(t *testing.T) {
	agentMux := rpc.NewAgentMux()
	uploadStarted := make(chan struct{})
	rpc.HandleRaw(agentMux, "FsWrite", func(ctx context.Context, req *agentv1.FsWriteRequest, s rpc.RawStream) (*agentv1.FsWriteResponse, error) {
		close(uploadStarted)
		<-ctx.Done() // never reads: the uploader runs out of credit
		return nil, ctx.Err()
	})
	rpc.HandleUnary(agentMux, "GetNodeFacts", func(ctx context.Context, _ *agentv1.GetNodeFactsRequest) (*agentv1.GetNodeFactsResponse, error) {
		return &agentv1.GetNodeFactsResponse{}, nil
	})
	p := newPair(t, agentMux, nil, 32<<10)
	ctx := ctxT(t)

	upCtx, cancel := context.WithCancel(ctx)
	s, err := p.panel.Open(upCtx, "FsWrite", &agentv1.FsWriteRequest{})
	if err != nil {
		t.Fatal(err)
	}
	writeDone := make(chan error, 1)
	go func() {
		_, err := s.Write(make([]byte, 1<<20))
		writeDone <- err
	}()
	<-uploadStarted
	select {
	case err := <-writeDone:
		t.Fatalf("1 MiB upload finished into a 32 KiB window: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	start := time.Now()
	if err := p.panel.Call(ctx, "GetNodeFacts", &agentv1.GetNodeFactsRequest{}, &agentv1.GetNodeFactsResponse{}); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("call took %s behind a blocked upload", d)
	}
	cancel()
	if err := <-writeDone; err == nil {
		t.Fatal("blocked write did not fail on cancel")
	}
}

func TestEventsAndClose(t *testing.T) {
	agentMux := rpc.NewAgentMux()
	blocked := make(chan struct{})
	rpc.HandleUnary(agentMux, "RestartService", func(ctx context.Context, _ *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
		close(blocked)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	p := newPair(t, agentMux, nil, 0)
	ctx := ctxT(t)

	p.agent.Emit(&agentv1.Event{Payload: &agentv1.Event_NodeFacts{NodeFacts: &agentv1.NodeFacts{Hostname: "n1"}}})
	select {
	case ev := <-p.panelEvents:
		if ev.GetNodeFacts().GetHostname() != "n1" || ev.GetTime() == nil {
			t.Fatalf("event = %v", ev)
		}
	case <-ctx.Done():
		t.Fatal("no event")
	}

	callErr := make(chan error, 1)
	go func() {
		callErr <- p.panel.Call(ctx, "RestartService", &agentv1.RestartServiceRequest{}, &agentv1.RestartServiceResponse{})
	}()
	<-blocked
	p.agent.Close(errors.New("going away"))
	if err := <-callErr; code(err) != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
		t.Fatalf("call during close = %v", err)
	}
	<-p.panel.Done()
	if err := <-p.agentErr; err == nil || err.Error() != "going away" {
		t.Fatalf("serve returned %v", err)
	}
	if err := p.agent.Call(ctx, "ReportEvent", &agentv1.ReportEventRequest{}, nil); code(err) == agentv1.StatusCode_STATUS_CODE_OK {
		t.Fatal("call on a closed session succeeded")
	}
}

func TestProtocolViolationClosesSession(t *testing.T) {
	a, b := conn.Pipe()
	s := rpc.NewSession(rpc.SessionConfig{Transport: a, Role: conn.RoleDialer, Handlers: rpc.NewAgentMux()})
	done := make(chan error, 1)
	go func() { done <- s.Serve(context.Background()) }()
	ctx := ctxT(t)
	// The panel may only open even streams.
	if err := b.WriteFrame(ctx, conn.Frame{Kind: conn.KindCall, Stream: 3}.Encode()); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("session accepted a call on an odd stream from the panel")
	}
}
