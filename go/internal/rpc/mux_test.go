package rpc

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func restart(context.Context, *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
	return &agentv1.RestartServiceResponse{}, nil
}

func TestMuxRegistrationErrors(t *testing.T) {
	tests := []struct {
		name     string
		register func(m *Mux)
		want     string
	}{
		{"unknown method", func(m *Mux) { HandleUnary(m, "RestartEverything", restart) }, `no method "RestartEverything"`},
		{"wrong shape", func(m *Mux) {
			HandleUnary(m, "LogsFollow", func(context.Context, *agentv1.LogsFollowRequest) (*agentv1.LogsFollowResponse, error) {
				return nil, nil
			})
		}, "is streaming, registered as unary"},
		{"wrong request type", func(m *Mux) {
			HandleUnary(m, "RemoveService", func(context.Context, *agentv1.RestartServiceRequest) (*agentv1.RemoveServiceResponse, error) {
				return nil, nil
			})
		}, "takes seylo.agent.v1.RemoveServiceRequest"},
		{"wrong response type", func(m *Mux) {
			HandleUnary(m, "RestartService", func(context.Context, *agentv1.RestartServiceRequest) (*agentv1.RemoveServiceResponse, error) {
				return nil, nil
			})
		}, "returns seylo.agent.v1.RestartServiceResponse"},
		{"raw as unary", func(m *Mux) {
			HandleUnary(m, "FsRead", func(context.Context, *agentv1.FsReadRequest) (*agentv1.FsReadResponse, error) { return nil, nil })
		}, "is raw, registered as unary"},
		{"duplicate", func(m *Mux) {
			HandleUnary(m, "RestartService", restart)
			HandleUnary(m, "RestartService", restart)
		}, "registered twice"},
		{"other service's full name", func(m *Mux) { HandleUnary(m, "/seylo.agent.v1.PanelService/RestartService", restart) }, "no method"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := NewAgentMux()
			tt.register(m)
			err := m.Err()
			if !errors.Is(err, ErrRegistration) || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Err() = %v, want ErrRegistration containing %q", err, tt.want)
			}
		})
	}
}

func TestMuxLookup(t *testing.T) {
	m := NewAgentMux()
	HandleUnary(m, "RestartService", restart)
	if err := m.Err(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"RestartService", "/seylo.agent.v1.AgentService/RestartService"} {
		h, ok := m.Lookup(name)
		if !ok || h.Shape != ShapeUnary || h.Capability != "state.sync.v1" || h.Unary == nil {
			t.Fatalf("Lookup(%q) = %+v, %v", name, h, ok)
		}
		if h.FullName() != "/seylo.agent.v1.AgentService/RestartService" {
			t.Fatalf("FullName = %q", h.FullName())
		}
	}
	if _, ok := m.Lookup("ApplyService"); ok {
		t.Fatal("unregistered method found")
	}
	HandleRaw(m, "FsRead", func(context.Context, *agentv1.FsReadRequest, RawStream) (*agentv1.FsReadResponse, error) {
		return nil, nil
	})
	if h, _ := m.Lookup("FsRead"); h.Mode != agentv1.StreamMode_STREAM_MODE_RAW_DOWNLOAD || h.Raw == nil {
		t.Fatalf("FsRead handler = %+v", h)
	}
}

func TestMuxCapabilitiesNeedEveryMethod(t *testing.T) {
	m := NewAgentMux()
	HandleUnary(m, "RunCronNow", func(context.Context, *agentv1.RunCronNowRequest) (*agentv1.RunCronNowResponse, error) {
		return nil, nil
	})
	// metrics.read.v1 has GetMetrics and WatchMetrics: one is not enough.
	HandleUnary(m, "GetMetrics", func(context.Context, *agentv1.GetMetricsRequest) (*agentv1.GetMetricsResponse, error) {
		return nil, nil
	})
	if got := m.Capabilities(); !slices.Equal(got, []string{"cron.run.v1"}) {
		t.Fatalf("Capabilities = %v", got)
	}
	HandleStream(m, "WatchMetrics", func(context.Context, *agentv1.WatchMetricsRequest, *TypedStream[*agentv1.WatchMetricsRequest, *agentv1.WatchMetricsResponse]) error {
		return nil
	})
	if got := m.Capabilities(); !slices.Equal(got, []string{"cron.run.v1", "metrics.read.v1"}) {
		t.Fatalf("Capabilities = %v", got)
	}
	if got := m.Registered(); len(got) != 3 {
		t.Fatalf("Registered = %v", got)
	}
}

func TestOutgoingMetadataMerges(t *testing.T) {
	ctx := WithMetadata(context.Background(), map[string]string{"user_id": "u1"})
	ctx2 := WithMetadata(ctx, map[string]string{"trace_id": "t1"})
	if md := OutgoingMetadata(ctx2); md["user_id"] != "u1" || md["trace_id"] != "t1" {
		t.Fatalf("metadata = %v", md)
	}
	if md := OutgoingMetadata(ctx); len(md) != 1 {
		t.Fatalf("parent metadata changed: %v", md)
	}
}

func TestLinkDisconnected(t *testing.T) {
	l := NewLink()
	err := l.Call(context.Background(), MethodReportEvent, &agentv1.ReportEventRequest{}, &agentv1.ReportEventResponse{})
	if !errors.Is(err, ErrNotConnected) {
		t.Fatalf("Call = %v", err)
	}
	if s := StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
		t.Fatalf("status = %v", s)
	}
	l.Emit(&agentv1.Event{}) // dropped, must not block or panic
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := l.WaitConnected(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("WaitConnected = %v", err)
	}
	if MethodRegistryTunnel != "/seylo.agent.v1.PanelService/RegistryTunnel" {
		t.Fatalf("MethodRegistryTunnel = %q", MethodRegistryTunnel)
	}
}

func TestMuxAdvertise(t *testing.T) {
	m := NewAgentMux()
	m.Advertise("database.engines.v2")
	HandleUnary(m, "RunCronNow", func(context.Context, *agentv1.RunCronNowRequest) (*agentv1.RunCronNowResponse, error) {
		return nil, nil
	})
	if got := m.Capabilities(); !slices.Equal(got, []string{"cron.run.v1", "database.engines.v2"}) {
		t.Fatalf("Capabilities = %v", got)
	}
	if m.Err() != nil {
		t.Fatal(m.Err())
	}
	// A method capability cannot be advertised without its methods.
	m.Advertise("metrics.read.v1")
	if !errors.Is(m.Err(), ErrRegistration) || slices.Contains(m.Capabilities(), "metrics.read.v1") {
		t.Fatalf("Err = %v, Capabilities = %v", m.Err(), m.Capabilities())
	}
	empty := NewAgentMux()
	empty.Advertise("")
	if !errors.Is(empty.Err(), ErrRegistration) {
		t.Fatal("empty capability accepted")
	}
}
