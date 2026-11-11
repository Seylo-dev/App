package rpc

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// UnaryFunc handles one unary call. req is already decoded; the returned
// message is the response (ignored when err is not nil).
type UnaryFunc func(ctx context.Context, req proto.Message) (proto.Message, error)

// StreamFunc handles one streaming call. first is the request carried by
// OPEN; later requests (client and bidi streaming) come from s.Recv. The
// call ends when the function returns: nil closes the stream with OK, an
// error closes it with StatusOf(err).
type StreamFunc func(ctx context.Context, first proto.Message, s ServerStream) error

// RawFunc handles one raw call (StreamMode RAW_*): req comes from OPEN,
// bytes move through s, and the returned message travels in the final
// CLOSE.
type RawFunc func(ctx context.Context, req proto.Message, s RawStream) (proto.Message, error)

// Handler is one registered method. Exactly one of Unary, Stream and Raw
// is set, matching Shape.
type Handler struct {
	Method     protoreflect.MethodDescriptor
	Shape      Shape
	Capability string
	// Mode is the raw direction for ShapeRaw, STREAM_MODE_UNSPECIFIED
	// otherwise.
	Mode agentv1.StreamMode

	Unary  UnaryFunc
	Stream StreamFunc
	Raw    RawFunc

	newRequest  func() proto.Message
	newResponse func() proto.Message
}

// NewRequest returns an empty request message of the method's input type.
func (h *Handler) NewRequest() proto.Message { return h.newRequest() }

// NewResponse returns an empty message of the method's output type: the
// unary or raw response, or one streamed message.
func (h *Handler) NewResponse() proto.Message { return h.newResponse() }

// FullName is the wire method name, see MethodName.
func (h *Handler) FullName() string { return MethodName(h.Method) }

// Mux is the handler registry of one service: the methods this side of the
// connection serves. The agent has one for AgentService (agent.Registry);
// tests build one for PanelService to play the panel.
//
// Register with HandleUnary, HandleStream and HandleRaw. Registration
// mistakes (unknown method, wrong shape, wrong message types, duplicates)
// do not panic: the first one is kept and returned by Err, which the agent
// checks once wiring is done, so a typo fails startup with a clear message.
//
// Methods that are not registered answer UNIMPLEMENTED, and a capability
// is advertised only when every method that carries it is registered.
// Capabilities that name a behaviour instead of methods are added with
// Advertise.
type Mux struct {
	service protoreflect.ServiceDescriptor

	mu       sync.RWMutex
	handlers map[string]*Handler // by full method name
	features map[string]bool     // Advertise
	err      error
}

// NewMux returns an empty registry for service.
func NewMux(service protoreflect.ServiceDescriptor) *Mux {
	return &Mux{service: service, handlers: map[string]*Handler{}, features: map[string]bool{}}
}

// Advertise adds a capability that no method carries: one that says this
// side handles something new in messages it already takes (for example
// "database.engines.v2", new DatabaseEngine values in ServiceSpec, or
// "database.exposure.v2", exposed Postgres, MySQL and MariaDB ports that
// refuse clients without TLS and DatabaseSpec.retired_exposed_user). The
// area that implements it calls Advertise while wiring. Naming a method
// capability here is a registration mistake: those come from handlers.
func (m *Mux) Advertise(capability string) {
	if capability == "" {
		m.fail("empty capability")
		return
	}
	methods := m.service.Methods()
	for i := range methods.Len() {
		if MethodCapability(methods.Get(i)) == capability {
			m.fail("%s is a method capability; register its methods instead", capability)
			return
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.features[capability] = true
}

// NewAgentMux returns an empty AgentService registry.
func NewAgentMux() *Mux {
	return NewMux(agentv1.File_seylo_agent_v1_agent_service_proto.Services().ByName("AgentService"))
}

// NewPanelMux returns an empty PanelService registry (fake panels in tests).
func NewPanelMux() *Mux {
	return NewMux(agentv1.File_seylo_agent_v1_panel_service_proto.Services().ByName("PanelService"))
}

// Service is the service this registry serves.
func (m *Mux) Service() protoreflect.ServiceDescriptor { return m.service }

// Err returns the first registration mistake, or nil.
func (m *Mux) Err() error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.err
}

// Method resolves a method of this service by short name ("ApplyService")
// or full wire name ("/seylo.agent.v1.AgentService/ApplyService").
func (m *Mux) Method(name string) (protoreflect.MethodDescriptor, bool) {
	short := name
	if strings.HasPrefix(name, "/") {
		prefix := "/" + string(m.service.FullName()) + "/"
		if !strings.HasPrefix(name, prefix) {
			return nil, false
		}
		short = strings.TrimPrefix(name, prefix)
	}
	md := m.service.Methods().ByName(protoreflect.Name(short))
	return md, md != nil
}

// Lookup returns the handler for a full or short method name.
func (m *Mux) Lookup(name string) (*Handler, bool) {
	md, ok := m.Method(name)
	if !ok {
		return nil, false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	h, ok := m.handlers[MethodName(md)]
	return h, ok
}

// Registered lists the full names of registered methods, sorted.
func (m *Mux) Registered() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	names := make([]string, 0, len(m.handlers))
	for name := range m.handlers {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// Capabilities returns, sorted, every capability whose methods are all
// registered, plus the advertised ones. This is what the agent advertises
// in NodeFacts.
func (m *Mux) Capabilities() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	complete := map[string]bool{}
	methods := m.service.Methods()
	for i := range methods.Len() {
		md := methods.Get(i)
		capName := MethodCapability(md)
		if capName == "" {
			continue
		}
		_, registered := m.handlers[MethodName(md)]
		if seen, ok := complete[capName]; ok {
			complete[capName] = seen && registered
		} else {
			complete[capName] = registered
		}
	}
	out := make([]string, 0, len(complete)+len(m.features))
	for capName, ok := range complete {
		if ok {
			out = append(out, capName)
		}
	}
	for capName := range m.features {
		out = append(out, capName)
	}
	slices.Sort(out)
	return out
}

// ErrRegistration wraps every registration mistake reported by Mux.Err.
var ErrRegistration = errors.New("rpc: bad handler registration")

func (m *Mux) fail(format string, args ...any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err == nil {
		m.err = fmt.Errorf("%w: %s", ErrRegistration, fmt.Sprintf(format, args...))
	}
}

// register checks a handler against the method descriptor and stores it.
func (m *Mux) register(name string, shape Shape, req, resp proto.Message, h *Handler) {
	md, ok := m.Method(name)
	if !ok {
		m.fail("%s has no method %q", m.service.FullName(), name)
		return
	}
	full := MethodName(md)
	if got := MethodShape(md); got != shape {
		m.fail("%s is %s, registered as %s", full, got, shape)
		return
	}
	if in := req.ProtoReflect().Descriptor().FullName(); in != md.Input().FullName() {
		m.fail("%s takes %s, handler takes %s", full, md.Input().FullName(), in)
		return
	}
	if out := resp.ProtoReflect().Descriptor().FullName(); out != md.Output().FullName() {
		m.fail("%s returns %s, handler returns %s", full, md.Output().FullName(), out)
		return
	}
	h.Method = md
	h.Shape = shape
	h.Capability = MethodCapability(md)
	h.Mode = MethodStreamMode(md)
	h.newRequest = func() proto.Message { return req.ProtoReflect().New().Interface() }
	h.newResponse = func() proto.Message { return resp.ProtoReflect().New().Interface() }

	m.mu.Lock()
	defer m.mu.Unlock()
	if _, dup := m.handlers[full]; dup {
		if m.err == nil {
			m.err = fmt.Errorf("%w: %s registered twice", ErrRegistration, full)
		}
		return
	}
	m.handlers[full] = h
}

func (s Shape) String() string {
	switch s {
	case ShapeUnary:
		return "unary"
	case ShapeStreaming:
		return "streaming"
	case ShapeRaw:
		return "raw"
	default:
		return fmt.Sprintf("Shape(%d)", int(s))
	}
}

// zero returns the typed nil of a generated message type. ProtoReflect on
// a nil pointer of a generated message is valid and describes the type.
func zero[M proto.Message]() M {
	var m M
	return m
}

// HandleUnary registers a unary method by short name:
//
//	rpc.HandleUnary(reg, "RestartService", func(ctx context.Context, req *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) { ... })
func HandleUnary[Req, Resp proto.Message](m *Mux, method string, fn func(ctx context.Context, req Req) (Resp, error)) {
	m.register(method, ShapeUnary, zero[Req](), zero[Resp](), &Handler{
		Unary: func(ctx context.Context, req proto.Message) (proto.Message, error) {
			resp, err := fn(ctx, req.(Req))
			if err != nil {
				return nil, err
			}
			return resp, nil
		},
	})
}

// HandleStream registers a streaming method (server, client or bidi
// streaming). fn gets the first request from OPEN and a typed stream:
// Send blocks until the panel granted credit; Recv returns the next request
// and io.EOF once the panel half-closed.
func HandleStream[Req, Resp proto.Message](m *Mux, method string, fn func(ctx context.Context, first Req, s *TypedStream[Req, Resp]) error) {
	m.register(method, ShapeStreaming, zero[Req](), zero[Resp](), &Handler{
		Stream: func(ctx context.Context, first proto.Message, s ServerStream) error {
			return fn(ctx, first.(Req), &TypedStream[Req, Resp]{s: s})
		},
	})
}

// HandleRaw registers a raw method (FsRead, FsWrite, Tunnel, ...). fn reads
// uploaded bytes from s (io.EOF when the panel finished sending) and/or
// writes downloaded bytes to s, then returns the response that travels in
// the final CLOSE.
func HandleRaw[Req, Resp proto.Message](m *Mux, method string, fn func(ctx context.Context, req Req, s RawStream) (Resp, error)) {
	m.register(method, ShapeRaw, zero[Req](), zero[Resp](), &Handler{
		Raw: func(ctx context.Context, req proto.Message, s RawStream) (proto.Message, error) {
			resp, err := fn(ctx, req.(Req), s)
			if err != nil {
				return nil, err
			}
			return resp, nil
		},
	})
}
