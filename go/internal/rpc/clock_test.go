package rpc_test

import (
	"context"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/rpc"
)

type offsetSeen struct {
	offset     time.Duration
	lowerBound bool
}

// rawPanel runs an agent session against the raw end of a pipe, so a test
// can send CALL frames stamped by a panel whose clock differs from ours.
func rawPanel(t *testing.T, mux *rpc.Mux, caps []string) (conn.Transport, *rpc.Session, chan offsetSeen) {
	t.Helper()
	a, b := conn.Pipe()
	seen := make(chan offsetSeen, 4)
	s := rpc.NewSession(rpc.SessionConfig{
		Transport: a, Role: conn.RoleDialer, Handlers: mux, PeerCapabilities: caps,
		OnClockOffset: func(offset time.Duration, lowerBound bool) { seen <- offsetSeen{offset, lowerBound} },
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = s.Serve(ctx) }()
	t.Cleanup(func() {
		cancel()
		<-s.Done()
	})
	return b, s, seen
}

func sendCall(t *testing.T, panel conn.Transport, stream conn.StreamID, call *agentv1.Call) *agentv1.Result {
	t.Helper()
	payload, err := proto.Marshal(call)
	if err != nil {
		t.Fatal(err)
	}
	ctx := ctxT(t)
	if err := panel.WriteFrame(ctx, conn.Frame{Kind: conn.KindCall, Stream: stream, Payload: payload}.Encode()); err != nil {
		t.Fatal(err)
	}
	for {
		f, err := panel.ReadFrame(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if f.Kind == conn.KindResult && f.Stream == stream {
			res := &agentv1.Result{}
			if err := proto.Unmarshal(f.Payload, res); err != nil {
				t.Fatal(err)
			}
			return res
		}
	}
}

// A node whose clock runs two minutes ahead of the panel's sees the
// panel's absolute deadline as already passed. Calls must still run.
func TestCallFromPanelWithSlowClock(t *testing.T) {
	mux := rpc.NewAgentMux()
	deadlines := make(chan time.Time, 4)
	rpc.HandleUnary(mux, "RestartService", func(ctx context.Context, _ *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		dl, _ := ctx.Deadline()
		deadlines <- dl
		return &agentv1.RestartServiceResponse{}, nil
	})
	panel, _, seen := rawPanel(t, mux, nil)
	method := "/seylo.agent.v1.AgentService/RestartService"
	panelNow := time.Now().Add(-2 * time.Minute)

	// An older panel: deadline only, already passed on our clock.
	res := sendCall(t, panel, 2, &agentv1.Call{Method: method, Deadline: timestamppb.New(panelNow.Add(30 * time.Second))})
	if res.GetStatus().GetCode() != agentv1.StatusCode_STATUS_CODE_OK {
		t.Fatalf("status = %v", res.GetStatus())
	}
	if dl := <-deadlines; !dl.IsZero() {
		t.Fatalf("handler deadline = %v, want none (the caller's timer cancels)", dl)
	}
	got := <-seen
	if !got.lowerBound || got.offset > -90*time.Second {
		t.Fatalf("offset = %+v", got)
	}

	// A panel that sends the relative timeout: the deadline counts from
	// our receive time.
	before := time.Now()
	res = sendCall(t, panel, 4, &agentv1.Call{
		Method:   method,
		Deadline: timestamppb.New(panelNow.Add(30 * time.Second)),
		Timeout:  durationpb.New(30 * time.Second),
	})
	if res.GetStatus().GetCode() != agentv1.StatusCode_STATUS_CODE_OK {
		t.Fatalf("status = %v", res.GetStatus())
	}
	dl := <-deadlines
	if left := dl.Sub(before); left < 29*time.Second || left > 31*time.Second {
		t.Fatalf("handler deadline %s after receive, want about 30s", left)
	}
	// That call also measures the offset exactly.
	if got := <-seen; got.lowerBound || got.offset > -119*time.Second || got.offset < -121*time.Second {
		t.Fatalf("offset = %+v, want about -2m", got)
	}

	// Each kind of measurement is reported once per session.
	sendCall(t, panel, 6, &agentv1.Call{Method: method, Deadline: timestamppb.New(panelNow)})
	sendCall(t, panel, 8, &agentv1.Call{Method: method, Deadline: timestamppb.New(panelNow), Timeout: durationpb.New(time.Second)})
	<-deadlines
	<-deadlines
	select {
	case extra := <-seen:
		t.Fatalf("offset reported again in the same session: %+v", extra)
	default:
	}
}

func TestClockOffsetMeasuredFromTimeout(t *testing.T) {
	mux := rpc.NewAgentMux()
	rpc.HandleUnary(mux, "RestartService", func(context.Context, *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
		return &agentv1.RestartServiceResponse{}, nil
	})
	panel, _, seen := rawPanel(t, mux, nil)
	panelNow := time.Now().Add(3 * time.Minute) // the panel runs ahead
	sendCall(t, panel, 2, &agentv1.Call{
		Method:   "/seylo.agent.v1.AgentService/RestartService",
		Deadline: timestamppb.New(panelNow.Add(10 * time.Second)),
		Timeout:  durationpb.New(10 * time.Second),
	})
	got := <-seen
	if got.lowerBound || got.offset < 179*time.Second || got.offset > 181*time.Second {
		t.Fatalf("offset = %+v, want about +3m", got)
	}
}

// Outgoing calls carry the relative timeout next to the deadline.
func TestOutgoingCallCarriesTimeout(t *testing.T) {
	panel, s, _ := rawPanel(t, rpc.NewAgentMux(), []string{"panel.report.v1"})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { _ = s.Call(ctx, "ReportEvent", &agentv1.ReportEventRequest{}, &agentv1.ReportEventResponse{}) }()
	f, err := panel.ReadFrame(ctxT(t))
	if err != nil {
		t.Fatal(err)
	}
	call := &agentv1.Call{}
	if err := proto.Unmarshal(f.Payload, call); err != nil {
		t.Fatal(err)
	}
	if call.GetDeadline() == nil || call.GetTimeout() == nil {
		t.Fatalf("call = %v", call)
	}
	if d := call.GetTimeout().AsDuration(); d <= 19*time.Second || d > 20*time.Second {
		t.Fatalf("timeout = %s", d)
	}
}
