package rpc

import (
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// MethodName is the wire name of a method:
// "/seylo.agent.v1.AgentService/ApplyService".
func MethodName(m protoreflect.MethodDescriptor) string {
	return "/" + string(m.Parent().FullName()) + "/" + string(m.Name())
}

// MethodCapability reads the capability option of a method: what the
// callee must have advertised before the method may be called.
func MethodCapability(m protoreflect.MethodDescriptor) string {
	opts := m.Options()
	if opts == nil {
		return ""
	}
	return proto.GetExtension(opts, agentv1.E_Capability).(string)
}

// Shape is how a method uses frames.
type Shape int

const (
	// ShapeUnary: one CALL, one RESULT.
	ShapeUnary Shape = iota + 1
	// ShapeStreaming: OPEN, size-delimited messages in DATA, CLOSE.
	ShapeStreaming
	// ShapeRaw: OPEN, raw bytes in DATA, CLOSE carrying the response.
	ShapeRaw
)

// MethodStreamMode reads the stream_mode option of a method.
func MethodStreamMode(m protoreflect.MethodDescriptor) agentv1.StreamMode {
	opts := m.Options()
	if opts == nil {
		return agentv1.StreamMode_STREAM_MODE_UNSPECIFIED
	}
	return proto.GetExtension(opts, agentv1.E_StreamMode).(agentv1.StreamMode)
}

// MethodShape decides how a method maps onto frames.
func MethodShape(m protoreflect.MethodDescriptor) Shape {
	switch {
	case MethodStreamMode(m) != agentv1.StreamMode_STREAM_MODE_UNSPECIFIED:
		return ShapeRaw
	case m.IsStreamingClient() || m.IsStreamingServer():
		return ShapeStreaming
	default:
		return ShapeUnary
	}
}

// Services lists the services of the agent protocol, for building method
// tables and for tests that walk every method.
func Services() []protoreflect.ServiceDescriptor {
	return []protoreflect.ServiceDescriptor{
		agentv1.File_seylo_agent_v1_agent_service_proto.Services().ByName("AgentService"),
		agentv1.File_seylo_agent_v1_panel_service_proto.Services().ByName("PanelService"),
	}
}
