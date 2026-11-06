package rpc

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/stub"
)

func TestStatusOf(t *testing.T) {
	tests := []struct {
		name string
		err  error
		code agentv1.StatusCode
		msg  string
	}{
		{"nil", nil, agentv1.StatusCode_STATUS_CODE_OK, ""},
		{"rpc error", NewError(agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "service abc not found"), agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "service abc not found"},
		{"wrapped rpc error", fmt.Errorf("apply: %w", NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "bad port")), agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "bad port"},
		{"stub", stub.NotImplemented("build.Builder.Build"), agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED, "build.Builder.Build: not implemented yet"},
		{"cancelled", context.Canceled, agentv1.StatusCode_STATUS_CODE_CANCELLED, "cancelled"},
		{"deadline", fmt.Errorf("x: %w", context.DeadlineExceeded), agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED, "deadline exceeded"},
		{"internal hides details", errors.New("open /var/lib/seylo/secret: permission denied"), agentv1.StatusCode_STATUS_CODE_INTERNAL, "internal error"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := StatusOf(tt.err)
			if s.GetCode() != tt.code || s.GetMessage() != tt.msg {
				t.Fatalf("StatusOf = %v %q, want %v %q", s.GetCode(), s.GetMessage(), tt.code, tt.msg)
			}
		})
	}
}

func TestErrorOfRoundTrip(t *testing.T) {
	if err := ErrorOf(&agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_OK}); err != nil {
		t.Fatalf("OK status gave %v", err)
	}
	err := ErrorOf(&agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_ABORTED, Message: "superseded", Details: map[string]string{"revision": "9"}})
	var rpcErr *Error
	if !errors.As(err, &rpcErr) || rpcErr.Code != agentv1.StatusCode_STATUS_CODE_ABORTED || rpcErr.Details["revision"] != "9" {
		t.Fatalf("ErrorOf = %#v", err)
	}
	if s := StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_ABORTED || s.GetMessage() != "superseded" {
		t.Fatalf("round trip = %v", s)
	}
	var missing *Error
	if !errors.As(ErrorOf(nil), &missing) || missing.Code != agentv1.StatusCode_STATUS_CODE_UNKNOWN {
		t.Fatal("a missing status must be an UNKNOWN error, not success")
	}
}

var capabilityRe = regexp.MustCompile(`^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v[1-9][0-9]*$`)

// TestEveryMethodHasCapability keeps the rollout rule from proto/README.md
// enforceable: a method without a capability could be called on agents
// that do not have it.
func TestEveryMethodHasCapability(t *testing.T) {
	for _, svc := range Services() {
		methods := svc.Methods()
		for i := range methods.Len() {
			m := methods.Get(i)
			if c := MethodCapability(m); !capabilityRe.MatchString(c) {
				t.Errorf("%s capability = %q, want <area>.<feature>.v<n>", MethodName(m), c)
			}
		}
	}
}

func TestMethodShapes(t *testing.T) {
	want := map[string]Shape{
		"/seylo.agent.v1.AgentService/ApplyService":   ShapeUnary,
		"/seylo.agent.v1.AgentService/Build":          ShapeStreaming,
		"/seylo.agent.v1.AgentService/Shell":          ShapeStreaming,
		"/seylo.agent.v1.AgentService/FsRead":         ShapeRaw,
		"/seylo.agent.v1.AgentService/FsWrite":        ShapeRaw,
		"/seylo.agent.v1.AgentService/Tunnel":         ShapeRaw,
		"/seylo.agent.v1.PanelService/ReportCrash":    ShapeUnary,
		"/seylo.agent.v1.PanelService/RegistryTunnel": ShapeRaw,
	}
	seen := map[string]bool{}
	for _, svc := range Services() {
		if svc == nil {
			t.Fatal("a protocol service is missing from the generated descriptors")
		}
		methods := svc.Methods()
		for i := range methods.Len() {
			m := methods.Get(i)
			name := MethodName(m)
			seen[name] = true
			// Raw methods are declared unary; streaming them as well would
			// make the frame mapping ambiguous.
			if MethodStreamMode(m) != agentv1.StreamMode_STREAM_MODE_UNSPECIFIED && (m.IsStreamingClient() || m.IsStreamingServer()) {
				t.Errorf("%s is raw and streaming at once", name)
			}
			if shape, ok := want[name]; ok && MethodShape(m) != shape {
				t.Errorf("%s shape = %d, want %d", name, MethodShape(m), shape)
			}
		}
	}
	for name := range want {
		if !seen[name] {
			t.Errorf("method %s not found", name)
		}
	}
}
