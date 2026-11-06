package rpc

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
)

// pendingCall is an outgoing unary call waiting for its RESULT.
type pendingCall struct {
	once sync.Once
	done chan struct{}
	resp []byte
	err  error
}

func newPendingCall() *pendingCall { return &pendingCall{done: make(chan struct{})} }

func (c *pendingCall) settle(resp []byte, err error) {
	c.once.Do(func() {
		c.resp, c.err = resp, err
		close(c.done)
	})
}

// Call performs a unary call to the peer and fills resp. method is the full
// wire name (MethodName) or a short name ("ReportEvent"). Remote failures
// come back as *Error; a cancelled or expired ctx returns ctx.Err() and
// tells the peer to stop.
func (s *Session) Call(ctx context.Context, method string, req, resp proto.Message) error {
	md, err := s.outgoingMethod(method, true)
	if err != nil {
		return err
	}
	payload, err := proto.Marshal(req)
	if err != nil {
		return fmt.Errorf("encoding %s request: %w", md.Name(), err)
	}
	call := &agentv1.Call{Method: MethodName(md), Request: payload, Metadata: OutgoingMetadata(ctx)}
	call.Deadline, call.Timeout = outgoingDeadline(ctx)
	frame, err := proto.Marshal(call)
	if err != nil {
		return fmt.Errorf("encoding call: %w", err)
	}
	s.openMu.Lock()
	id, err := s.ids.Next()
	if err != nil {
		s.openMu.Unlock()
		s.Close(err)
		return unavailable()
	}
	c := newPendingCall()
	if !s.track(func() { s.calls[id] = c }) {
		s.openMu.Unlock()
		return unavailable()
	}
	s.stats.outUnary.Add(1)
	s.stats.outTotal.Add(1)
	defer s.stats.outUnary.Add(-1)

	err = s.writeControl(ctx, conn.Frame{Kind: conn.KindCall, Stream: id, Payload: frame})
	s.openMu.Unlock()
	if err != nil {
		s.takeCall(id)
		return err
	}

	select {
	case <-c.done:
	case <-ctx.Done():
		if s.takeCall(id) != nil {
			go s.sendClose(id, &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_CANCELLED, Message: "cancelled by the caller"}, nil)
			return ctx.Err()
		}
		<-c.done // the result won the race
	}
	if c.err != nil {
		// The peer runs the call under the same deadline, so its CANCELLED
		// or DEADLINE_EXCEEDED answer can be ready when the caller's ctx
		// ends too (select picks either, and the ctx timer may not have run
		// yet). The caller's ctx explains it.
		if ctxErr := callerCtxErr(ctx); ctxErr != nil {
			if code := StatusOf(c.err).GetCode(); code == agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED || code == agentv1.StatusCode_STATUS_CODE_CANCELLED {
				return ctxErr
			}
		}
		return c.err
	}
	if resp != nil {
		proto.Reset(resp)
		if err := proto.Unmarshal(c.resp, resp); err != nil {
			return fmt.Errorf("decoding %s response: %w", md.Name(), err)
		}
	}
	return nil
}

// outgoingMethod resolves a method of either protocol service and checks
// that the peer advertised its capability.
func (s *Session) outgoingMethod(name string, unary bool) (protoreflect.MethodDescriptor, error) {
	md, ok := LookupMethod(name)
	if !ok {
		return nil, fmt.Errorf("rpc: unknown method %q", name)
	}
	switch shape := MethodShape(md); {
	case unary && shape != ShapeUnary:
		return nil, fmt.Errorf("rpc: %s is %s: use Open", MethodName(md), shape)
	case !unary && shape == ShapeUnary:
		return nil, fmt.Errorf("rpc: %s is unary: use Call", MethodName(md))
	}
	if capName := MethodCapability(md); capName != "" && !s.peerCaps[capName] {
		return nil, NewError(agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED,
			fmt.Sprintf("the other side does not support %s yet (%s)", md.Name(), capName))
	}
	if s.closing.Load() {
		return nil, unavailable()
	}
	return md, nil
}

// LookupMethod finds a method of AgentService or PanelService by full wire
// name or by short name (the two services share no method names).
func LookupMethod(name string) (protoreflect.MethodDescriptor, bool) {
	for _, svc := range Services() {
		short := name
		if len(name) > 0 && name[0] == '/' {
			prefix := "/" + string(svc.FullName()) + "/"
			if len(name) <= len(prefix) || name[:len(prefix)] != prefix {
				continue
			}
			short = name[len(prefix):]
		}
		if md := svc.Methods().ByName(protoreflect.Name(short)); md != nil {
			return md, true
		}
	}
	return nil, false
}

// handlerFor finds the registered handler for an incoming call, or the
// status to refuse it with.
func (s *Session) handlerFor(method string, unary bool) (*Handler, *agentv1.Status) {
	refuse := func(code agentv1.StatusCode, msg string) (*Handler, *agentv1.Status) {
		return nil, &agentv1.Status{Code: code, Message: msg}
	}
	mux := s.cfg.Handlers
	if mux == nil {
		return refuse(agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED, method+" is not served here")
	}
	md, ok := mux.Method(method)
	if !ok {
		return refuse(agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED, "unknown method "+method)
	}
	h, ok := mux.Lookup(method)
	if !ok {
		return refuse(agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED, string(md.Name())+" is not implemented on this node")
	}
	if unary != (h.Shape == ShapeUnary) {
		frame := "OPEN"
		if h.Shape == ShapeUnary {
			frame = "CALL"
		}
		return refuse(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, string(md.Name())+" must be started with "+frame)
	}
	return h, nil
}

// clockSkewWarning is the clock offset from which a call's absolute
// deadline is worth a warning (transit is milliseconds).
const clockSkewWarning = 5 * time.Second

// outgoingDeadline returns the deadline and relative timeout to send for
// ctx, both nil when ctx has no deadline.
func outgoingDeadline(ctx context.Context) (*timestamppb.Timestamp, *durationpb.Duration) {
	dl, ok := ctx.Deadline()
	if !ok {
		return nil, nil
	}
	return timestamppb.New(dl), durationpb.New(max(time.Until(dl), 0))
}

// callContext builds a handler's ctx: a child of the session with the
// call's deadline and CallInfo. A relative timeout wins, because an
// absolute deadline is read on our clock and a clock ahead of the peer's
// would expire every call on arrival. A deadline alone that already
// passed on arrival means the clocks disagree: the call runs without a
// local deadline (the caller's own timer still cancels it) and the skew
// is reported once.
func (s *Session) callContext(h *Handler, deadline *timestamppb.Timestamp, timeout *durationpb.Duration, md map[string]string) (context.Context, context.CancelFunc) {
	info := &CallInfo{Method: h.FullName(), Metadata: md}
	ctx := WithCallInfo(s.ctx, info)
	now := time.Now()
	hasDeadline := deadline != nil && deadline.IsValid()
	if timeout != nil && timeout.IsValid() && timeout.AsDuration() > 0 {
		info.Deadline = now.Add(timeout.AsDuration())
		if hasDeadline {
			s.clockOffset(h, deadline.AsTime().Sub(info.Deadline), false)
		}
		return context.WithDeadline(ctx, info.Deadline)
	}
	if hasDeadline {
		dl := deadline.AsTime()
		if !dl.After(now) {
			s.clockOffset(h, dl.Sub(now), true)
			return context.WithCancel(ctx)
		}
		info.Deadline = dl
		return context.WithDeadline(ctx, dl)
	}
	return context.WithCancel(ctx)
}

// clockOffset reports the peer's clock offset once per session for each
// kind of measurement (exact, lower bound) and warns when it is large.
func (s *Session) clockOffset(h *Handler, offset time.Duration, lowerBound bool) {
	seen := &s.clockSeen
	if lowerBound {
		seen = &s.clockLate
	}
	if !seen.CompareAndSwap(false, true) {
		return
	}
	if offset.Abs() >= clockSkewWarning {
		s.cfg.Logger.Warn("the other side's clock differs from ours; check time sync (timedatectl set-ntp true)",
			"offset", offset.Round(time.Second).String(), "at_least", lowerBound, "method", h.FullName())
	}
	if s.cfg.OnClockOffset != nil {
		s.cfg.OnClockOffset(offset, lowerBound)
	}
}

// startUnary runs an incoming CALL on its own goroutine and answers with
// RESULT.
func (s *Session) startUnary(id conn.StreamID, call *agentv1.Call) {
	h, refused := s.handlerFor(call.GetMethod(), true)
	if refused != nil {
		go s.sendResult(id, refused, nil)
		return
	}
	ctx, cancel := s.callContext(h, call.GetDeadline(), call.GetTimeout(), call.GetMetadata())
	if !s.track(func() { s.unary[id] = cancel }) {
		cancel()
		return
	}
	s.stats.inUnary.Add(1)
	s.stats.inTotal.Add(1)
	go func() {
		resp, err := s.runUnary(ctx, h, call.GetRequest())
		s.stats.inUnary.Add(-1)
		s.mu.Lock()
		delete(s.unary, id)
		s.mu.Unlock()
		cancel()

		status := StatusOf(err)
		var payload []byte
		if err == nil && resp != nil {
			if payload, err = proto.Marshal(resp); err != nil {
				s.cfg.Logger.Error("encoding handler response", "method", h.FullName(), "err", err)
				status = StatusOf(err)
			}
		}
		s.sendResult(id, status, payload)
	}()
}

func (s *Session) runUnary(ctx context.Context, h *Handler, raw []byte) (resp proto.Message, err error) {
	req := h.NewRequest()
	if err := proto.Unmarshal(raw, req); err != nil {
		return nil, NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "undecodable request for "+string(h.Method.Name()))
	}
	defer s.recoverHandler(h, &err)
	resp, err = h.Unary(ctx, req)
	s.logHandlerError(h, err)
	if err == nil && resp == nil {
		resp = h.NewResponse()
	}
	return resp, err
}

// recoverHandler turns a handler panic into INTERNAL and keeps the agent
// alive: one buggy handler must not stop every service on the node.
func (s *Session) recoverHandler(h *Handler, errp *error) {
	if r := recover(); r != nil {
		s.stats.panics.Add(1)
		s.cfg.Logger.Error("handler panicked", "method", h.FullName(), "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
		*errp = NewError(agentv1.StatusCode_STATUS_CODE_INTERNAL, "internal error")
	}
}

// logHandlerError logs errors the peer only sees as "internal error", so
// the cause is in the agent's own log.
func (s *Session) logHandlerError(h *Handler, err error) {
	if err == nil {
		return
	}
	var rpcErr *Error
	if errors.As(err, &rpcErr) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	if StatusOf(err).GetCode() == agentv1.StatusCode_STATUS_CODE_INTERNAL {
		s.cfg.Logger.Warn("handler failed", "method", h.FullName(), "err", err)
	}
}

func (s *Session) sendResult(id conn.StreamID, status *agentv1.Status, response []byte) {
	payload, err := proto.Marshal(&agentv1.Result{Status: status, Response: response})
	if err != nil {
		s.cfg.Logger.Error("encoding result", "err", err)
		return
	}
	_ = s.writeControl(s.ctx, conn.Frame{Kind: conn.KindResult, Stream: id, Payload: payload})
}

func (s *Session) sendClose(id conn.StreamID, status *agentv1.Status, response []byte) {
	payload, err := proto.Marshal(&agentv1.Close{Status: status, Response: response})
	if err != nil {
		s.cfg.Logger.Error("encoding close", "err", err)
		return
	}
	_ = s.writeControl(s.ctx, conn.Frame{Kind: conn.KindClose, Stream: id, Payload: payload})
}

// callerCtxErr is ctx.Err(), or DeadlineExceeded once ctx's deadline has
// passed even if its timer has not fired yet.
func callerCtxErr(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if d, ok := ctx.Deadline(); ok && !time.Now().Before(d) {
		return context.DeadlineExceeded
	}
	return nil
}
