// Package rpctest calls registered handlers in-process, without a
// connection, so handler code can be tested before (and independently of)
// the real rpc.Session.
//
// A Peer plays the caller (the panel, for AgentService handlers). Calls go
// through the same steps as on the wire: the request is marshalled and
// decoded into a fresh message, the handler gets a ctx with rpc.CallInfo,
// errors become a wire Status and back (so an unexpected error arrives as
// INTERNAL "internal error", exactly what the panel would see), and
// streams are flow controlled with real credit windows.
//
//	reg := rpc.NewAgentMux()
//	rpc.HandleUnary(reg, "RestartService", h.restart)
//	panel := rpctest.NewPeer(t, reg)
//	resp := &agentv1.RestartServiceResponse{}
//	err := panel.Call(ctx, "RestartService", &agentv1.RestartServiceRequest{ServiceId: "web"}, resp)
//
// Recorder is a fake rpc.Emitter and state.Reporter for asserting on the
// events and reports a component sends.
package rpctest

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"maps"
	"runtime/debug"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// DefaultWindow is the harness's per-stream window. It is small on purpose
// so tests exercise blocking on credit with modest amounts of data.
const DefaultWindow = 64 << 10

// Option configures a Peer.
type Option func(*Peer)

// WithWindow sets the per-direction stream window in bytes.
func WithWindow(n uint32) Option { return func(p *Peer) { p.window = n } }

// Peer is an in-process rpc.Peer that dispatches to a Mux.
type Peer struct {
	tb     testing.TB
	mux    *rpc.Mux
	window uint32

	mu     sync.Mutex
	events []*agentv1.Event

	// Streams still running when the test ends are cancelled and waited for
	// in Cleanup, so their handlers never log after the test completed.
	running sync.WaitGroup
	cancels map[*clientStream]context.CancelFunc
	ended   bool
}

var _ rpc.Peer = (*Peer)(nil)

// NewPeer returns a caller for the handlers in mux. It fails the test if
// the mux has a registration error.
func NewPeer(tb testing.TB, mux *rpc.Mux, opts ...Option) *Peer {
	tb.Helper()
	if err := mux.Err(); err != nil {
		tb.Fatalf("rpctest: %v", err)
	}
	p := &Peer{tb: tb, mux: mux, window: DefaultWindow, cancels: map[*clientStream]context.CancelFunc{}}
	for _, o := range opts {
		o(p)
	}
	tb.Cleanup(p.stopStreams)
	return p
}

// stopStreams cancels handlers still running at the end of the test and
// waits a few seconds for them to return.
func (p *Peer) stopStreams() {
	p.mu.Lock()
	p.ended = true
	for _, cancel := range p.cancels {
		cancel()
	}
	p.mu.Unlock()
	done := make(chan struct{})
	go func() { p.running.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}

// Events returns the events sent with Notify, in order.
func (p *Peer) Events() []*agentv1.Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]*agentv1.Event(nil), p.events...)
}

// Notify records the event; see Events.
func (p *Peer) Notify(ctx context.Context, event *agentv1.Event) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, proto.Clone(event).(*agentv1.Event))
	return nil
}

func (p *Peer) lookup(method string) (*rpc.Handler, error) {
	md, ok := p.mux.Method(method)
	if !ok {
		return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED, "unknown method "+method)
	}
	h, ok := p.mux.Lookup(method)
	if !ok {
		return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED, rpc.MethodName(md)+" is not implemented on this node")
	}
	return h, nil
}

// callCtx builds the handler's ctx the way the session does.
func callCtx(ctx context.Context, h *rpc.Handler) context.Context {
	info := &rpc.CallInfo{Method: h.FullName(), Metadata: maps.Clone(rpc.OutgoingMetadata(ctx))}
	if dl, ok := ctx.Deadline(); ok {
		info.Deadline = dl
	}
	return rpc.WithCallInfo(ctx, info)
}

// roundTrip marshals msg and decodes it into into, as the wire would.
func roundTrip(msg, into proto.Message) error {
	b, err := proto.Marshal(msg)
	if err != nil {
		return fmt.Errorf("rpctest: marshal %T: %w", msg, err)
	}
	proto.Reset(into)
	if err := proto.Unmarshal(b, into); err != nil {
		return fmt.Errorf("rpctest: unmarshal %T: %w", into, err)
	}
	return nil
}

// wireErr turns a handler error into what the caller would receive, and
// logs the original so failing tests show the real cause.
func (p *Peer) wireErr(method string, err error) error {
	if err == nil {
		return nil
	}
	p.mu.Lock()
	ended := p.ended
	p.mu.Unlock()
	if !ended {
		p.tb.Logf("rpctest: %s returned: %v", method, err)
	}
	return rpc.ErrorOf(rpc.StatusOf(err))
}

// recoverHandler turns a handler panic into a test error and INTERNAL.
func (p *Peer) recoverHandler(method string, errp *error) {
	if r := recover(); r != nil {
		p.tb.Errorf("rpctest: %s panicked: %v\n%s", method, r, debug.Stack())
		*errp = rpc.NewError(agentv1.StatusCode_STATUS_CODE_INTERNAL, "internal error")
	}
}

// Call runs a unary handler. method is a short ("ApplyService") or full
// wire name. Handler errors come back as *rpc.Error after the Status round
// trip.
func (p *Peer) Call(ctx context.Context, method string, req, resp proto.Message) (err error) {
	h, err := p.lookup(method)
	if err != nil {
		return err
	}
	if h.Shape != rpc.ShapeUnary {
		return fmt.Errorf("rpctest: %s is %s: use Open", h.FullName(), h.Shape)
	}
	in := h.NewRequest()
	if err := roundTrip(req, in); err != nil {
		return err
	}
	out, herr := func() (out proto.Message, err error) {
		defer p.recoverHandler(h.FullName(), &err)
		return h.Unary(callCtx(ctx, h), in)
	}()
	if herr != nil {
		return p.wireErr(h.FullName(), herr)
	}
	if out == nil {
		out = h.NewResponse()
	}
	return roundTrip(out, resp)
}

// Open starts a streaming or raw handler on its own goroutine and returns
// the caller's end. Cancelling ctx cancels the handler's ctx.
func (p *Peer) Open(ctx context.Context, method string, req proto.Message) (rpc.Stream, error) {
	h, err := p.lookup(method)
	if err != nil {
		return nil, err
	}
	if h.Shape == rpc.ShapeUnary {
		return nil, fmt.Errorf("rpctest: %s is unary: use Call", h.FullName())
	}
	first := h.NewRequest()
	if err := roundTrip(req, first); err != nil {
		return nil, err
	}
	hctx, cancel := context.WithCancel(callCtx(ctx, h))
	s := &clientStream{
		ctx:  ctx,
		h:    h,
		up:   newPipe(p.window),
		down: newPipe(p.window),
		done: make(chan struct{}),
	}
	p.mu.Lock()
	p.cancels[s] = cancel
	p.running.Add(1)
	p.mu.Unlock()
	go func() {
		defer p.running.Done()
		defer func() {
			p.mu.Lock()
			delete(p.cancels, s)
			p.mu.Unlock()
		}()
		defer cancel()
		var resp proto.Message
		err := func() (err error) {
			defer p.recoverHandler(h.FullName(), &err)
			switch h.Shape {
			case rpc.ShapeStreaming:
				return h.Stream(hctx, first, &serverStream{ctx: hctx, s: s})
			default:
				var herr error
				resp, herr = h.Raw(hctx, first, &serverRaw{ctx: hctx, s: s})
				return herr
			}
		}()
		s.finish(p.wireErr(h.FullName(), err), resp)
	}()
	return s, nil
}

// clientStream is the caller's end of an in-process stream. up carries
// caller -> handler bytes, down handler -> caller.
type clientStream struct {
	ctx      context.Context
	h        *rpc.Handler
	up, down *pipe

	done   chan struct{}
	status error
	resp   []byte
}

var _ rpc.Stream = (*clientStream)(nil)

func (s *clientStream) finish(err error, resp proto.Message) {
	if err == nil && resp != nil {
		b, merr := proto.Marshal(resp)
		if merr != nil {
			err = fmt.Errorf("rpctest: marshal response: %w", merr)
		}
		s.resp = b
	}
	s.status = err
	// Buffered handler output stays readable; anything the caller still
	// sends fails, as after a responder CLOSE.
	s.down.closeWrite()
	s.up.abort(errPipeClosed)
	close(s.done)
}

func (s *clientStream) raw() bool { return s.h.Shape == rpc.ShapeRaw }

func (s *clientStream) Send(msg proto.Message) error {
	if s.raw() {
		return fmt.Errorf("rpctest: %s is raw: use Write", s.h.FullName())
	}
	var buf bytes.Buffer
	if _, err := protodelim.MarshalTo(&buf, msg); err != nil {
		return err
	}
	_, err := s.up.write(s.ctx, buf.Bytes())
	return err
}

func (s *clientStream) Recv(msg proto.Message) error {
	if s.raw() {
		return fmt.Errorf("rpctest: %s is raw: use Read", s.h.FullName())
	}
	err := protodelim.UnmarshalFrom(reader{ctx: s.ctx, p: s.down}, msg)
	if err == io.EOF {
		<-s.done
		if s.status != nil {
			return s.status
		}
	}
	return err
}

func (s *clientStream) Read(b []byte) (int, error) {
	if !s.raw() {
		return 0, fmt.Errorf("rpctest: %s is not raw: use Recv", s.h.FullName())
	}
	return s.down.read(s.ctx, b)
}

func (s *clientStream) Write(b []byte) (int, error) {
	if !s.raw() {
		return 0, fmt.Errorf("rpctest: %s is not raw: use Send", s.h.FullName())
	}
	if s.h.Mode == agentv1.StreamMode_STREAM_MODE_RAW_DOWNLOAD {
		return 0, fmt.Errorf("rpctest: %s does not take uploaded bytes", s.h.FullName())
	}
	return s.up.write(s.ctx, b)
}

func (s *clientStream) CloseSend() error {
	s.up.closeWrite()
	return nil
}

func (s *clientStream) Finish(resp proto.Message) error {
	select {
	case <-s.done:
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
	if s.status != nil {
		return s.status
	}
	if resp != nil {
		proto.Reset(resp)
		return proto.Unmarshal(s.resp, resp)
	}
	return nil
}

// serverStream is the handler's end of a streaming call.
type serverStream struct {
	ctx context.Context
	s   *clientStream
}

func (t *serverStream) Send(msg proto.Message) error {
	var buf bytes.Buffer
	if _, err := protodelim.MarshalTo(&buf, msg); err != nil {
		return err
	}
	_, err := t.s.down.write(t.ctx, buf.Bytes())
	return err
}

func (t *serverStream) Recv(msg proto.Message) error {
	return protodelim.UnmarshalFrom(reader{ctx: t.ctx, p: t.s.up}, msg)
}

// serverRaw is the handler's end of a raw call.
type serverRaw struct {
	ctx context.Context
	s   *clientStream
}

func (t *serverRaw) Read(b []byte) (int, error) {
	if t.s.h.Mode == agentv1.StreamMode_STREAM_MODE_RAW_DOWNLOAD {
		return 0, io.EOF
	}
	return t.s.up.read(t.ctx, b)
}

func (t *serverRaw) Write(b []byte) (int, error) {
	if t.s.h.Mode == agentv1.StreamMode_STREAM_MODE_RAW_UPLOAD {
		return 0, fmt.Errorf("rpctest: %s does not send bytes back", t.s.h.FullName())
	}
	return t.s.down.write(t.ctx, b)
}
