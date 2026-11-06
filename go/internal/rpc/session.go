package rpc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
)

// SessionConfig configures one Session.
type SessionConfig struct {
	// Transport is the open, handshaken connection. The session owns it
	// from now on and closes it when it ends.
	Transport conn.Transport
	// Role decides stream id parity: conn.RoleDialer on the agent.
	Role conn.Role
	// Handlers serves incoming calls (the agent's AgentService registry).
	// Methods missing from it answer UNIMPLEMENTED.
	Handlers *Mux
	// PeerCapabilities are what the other side advertised
	// (ServerHello.capabilities on the agent). Call and Open refuse a
	// method whose capability is missing with UNIMPLEMENTED, without a
	// round trip.
	PeerCapabilities []string
	// InitialWindow is the receive window offered in OPEN frames this side
	// sends; 0 means conn.DefaultWindow.
	InitialWindow uint32
	// OnEvent receives EVENT frames from the peer after the handshake. It
	// runs on the read loop and must not block.
	OnEvent func(*agentv1.Event)
	// OnClockOffset receives the peer's clock offset (peer clock minus
	// ours, transit included), measured from incoming calls: once per
	// session from the first call carrying both deadline and timeout, and
	// once from the first call whose deadline had already passed on
	// arrival (lowerBound: the offset is at least that large). It runs on
	// the read loop and must not block.
	OnClockOffset func(offset time.Duration, lowerBound bool)
	Logger        *slog.Logger
}

// ErrSessionClosed is the reason a session reports when it was closed
// with a nil reason. Calls on a closed session fail with UNAVAILABLE.
var ErrSessionClosed = errors.New("rpc: session closed")

// errProtocol marks a peer that broke the protocol; the session closes.
var errProtocol = errors.New("rpc: protocol violation")

// emitQueue bounds the best-effort events waiting to be written.
const emitQueue = 256

// Session runs calls and streams in both directions over one connection:
// it dispatches incoming CALL and OPEN frames to Handlers (each call on its
// own goroutine, its ctx cancelled by the peer's CLOSE or when the
// connection drops), and implements Peer for outgoing calls.
//
// One Session lives exactly as long as one connection. The agent keeps a
// Link pointing at the current session so components hold one stable Peer
// across reconnects. Call Serve to run it; Close (or the end of Serve)
// releases everything.
type Session struct {
	cfg      SessionConfig
	w        *conn.Writer
	ids      *conn.StreamIDs
	peerRole conn.Role
	peerCaps map[string]bool

	// ctx ends when the session closes; every handler ctx derives from it.
	ctx    context.Context
	cancel context.CancelFunc

	// openMu spans taking a stream id and queueing its OPEN/CALL frame, so
	// ids reach the peer in increasing order (it treats a lower id as reused).
	openMu sync.Mutex

	mu       sync.Mutex
	calls    map[conn.StreamID]*pendingCall
	streams  map[conn.StreamID]*stream
	unary    map[conn.StreamID]context.CancelFunc
	lastPeer conn.StreamID
	closeErr error

	events chan *agentv1.Event
	stats  sessionCounters

	closing   atomic.Bool
	done      chan struct{}
	pumpStart sync.Once
	// clockSeen and clockLate make OnClockOffset and the skew warning fire
	// once per session for exact and lower-bound measurements.
	clockSeen, clockLate atomic.Bool
}

var (
	_ Peer    = (*Session)(nil)
	_ Emitter = (*Session)(nil)
)

// NewSession prepares a session; Serve starts it.
func NewSession(cfg SessionConfig) *Session {
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	if cfg.InitialWindow == 0 {
		cfg.InitialWindow = conn.DefaultWindow
	}
	peerRole := conn.RoleAcceptor
	if cfg.Role == conn.RoleAcceptor {
		peerRole = conn.RoleDialer
	}
	caps := make(map[string]bool, len(cfg.PeerCapabilities))
	for _, c := range cfg.PeerCapabilities {
		caps[c] = true
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{
		cfg:      cfg,
		w:        conn.NewWriter(cfg.Transport),
		ids:      conn.NewStreamIDs(cfg.Role),
		peerRole: peerRole,
		peerCaps: caps,
		ctx:      ctx,
		cancel:   cancel,
		calls:    map[conn.StreamID]*pendingCall{},
		streams:  map[conn.StreamID]*stream{},
		unary:    map[conn.StreamID]context.CancelFunc{},
		events:   make(chan *agentv1.Event, emitQueue),
		done:     make(chan struct{}),
	}
}

// Serve reads frames and dispatches them until the connection ends or ctx
// is cancelled. It returns why the connection ended; every running handler
// has seen its ctx cancelled by then.
func (s *Session) Serve(ctx context.Context) error {
	s.pumpStart.Do(func() { go s.pumpEvents() })
	stop := context.AfterFunc(ctx, func() { s.Close(ctx.Err()) })
	defer stop()
	for {
		f, err := s.cfg.Transport.ReadFrame(s.ctx)
		if err != nil {
			s.Close(fmt.Errorf("reading from the peer: %w", err))
			break
		}
		if err := s.dispatch(f); err != nil {
			s.cfg.Logger.Warn("closing connection: peer broke the protocol", "err", err)
			s.Close(err)
			break
		}
	}
	<-s.done
	return s.Err()
}

// Err returns why the session closed, or nil while it runs.
func (s *Session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closeErr
}

// Done is closed once the session ended.
func (s *Session) Done() <-chan struct{} { return s.done }

// Close ends the session and its connection. Safe to call more than once
// and from any goroutine; only the first reason is kept. Pending calls fail
// with UNAVAILABLE and every handler's ctx is cancelled.
func (s *Session) Close(reason error) error {
	return s.close(reason, false)
}

// Abort is Close without the transport's close handshake (when the
// transport supports that): for a peer that stopped answering, where a
// polite goodbye would only wait for it.
func (s *Session) Abort(reason error) error {
	return s.close(reason, true)
}

func (s *Session) close(reason error, abort bool) error {
	if !s.closing.CompareAndSwap(false, true) {
		return nil
	}
	if reason == nil {
		reason = ErrSessionClosed
	}
	s.mu.Lock()
	s.closeErr = reason
	calls, streams, unary := s.calls, s.streams, s.unary
	s.calls, s.streams, s.unary = map[conn.StreamID]*pendingCall{}, map[conn.StreamID]*stream{}, map[conn.StreamID]context.CancelFunc{}
	s.mu.Unlock()

	// Say goodbye first: cancelling the read ctx would drop the connection
	// without a close frame.
	text := "session closed"
	if !errors.Is(reason, ErrSessionClosed) && !errors.Is(reason, context.Canceled) {
		text = reason.Error()
	}
	if len(text) > 120 {
		text = text[:120]
	}
	if a, ok := s.cfg.Transport.(interface{ Abort() error }); abort && ok {
		_ = a.Abort()
	} else {
		_ = s.cfg.Transport.Close(text)
	}
	s.cancel()
	s.w.Close(ErrSessionClosed)

	gone := unavailable()
	for _, c := range calls {
		c.settle(nil, gone)
	}
	for _, st := range streams {
		st.abort(gone)
	}
	for _, cancel := range unary {
		cancel()
	}
	close(s.done)
	return nil
}

func unavailable() *Error {
	return NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "connection lost")
}

// Notify sends a best-effort EVENT frame on stream 0 and returns once it is
// written (control frames go before any queued DATA).
func (s *Session) Notify(ctx context.Context, event *agentv1.Event) error {
	payload, err := proto.Marshal(event)
	if err != nil {
		return fmt.Errorf("encoding event: %w", err)
	}
	return s.writeControl(ctx, conn.Frame{Kind: conn.KindEvent, Stream: conn.ConnectionStream, Payload: payload})
}

// Emit queues a best-effort event without blocking; it is dropped when the
// send queue is full or the session is closed. See Emitter.
func (s *Session) Emit(event *agentv1.Event) {
	if s.closing.Load() {
		s.stats.eventsDropped.Add(1)
		return
	}
	select {
	case s.events <- stamp(event):
	default:
		s.stats.eventsDropped.Add(1)
	}
}

func (s *Session) pumpEvents() {
	for {
		select {
		case ev := <-s.events:
			if err := s.Notify(s.ctx, ev); err != nil {
				s.stats.eventsDropped.Add(1)
			} else {
				s.stats.eventsSent.Add(1)
			}
		case <-s.ctx.Done():
			return
		}
	}
}

// writeControl writes a control frame. A failed write means the connection
// is broken, so the session closes.
func (s *Session) writeControl(ctx context.Context, f conn.Frame) error {
	if err := s.w.WriteControl(ctx, f); err != nil {
		return s.writeFailed(ctx, err)
	}
	return nil
}

func (s *Session) writeFailed(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if s.closing.Load() {
		return unavailable()
	}
	s.Close(fmt.Errorf("writing to the peer: %w", err))
	return unavailable()
}

// dispatch routes one frame. It runs on the read loop, so it never blocks
// on the network: anything that writes runs on its own goroutine.
func (s *Session) dispatch(f conn.Frame) error {
	switch f.Kind {
	case conn.KindEvent:
		if f.Stream != conn.ConnectionStream {
			return fmt.Errorf("%w: EVENT on stream %d", errProtocol, f.Stream)
		}
		ev := &agentv1.Event{}
		if err := proto.Unmarshal(f.Payload, ev); err != nil {
			return fmt.Errorf("%w: undecodable event: %v", errProtocol, err)
		}
		if s.cfg.OnEvent != nil {
			s.cfg.OnEvent(ev)
		}
		return nil
	case conn.KindCall:
		if err := s.claimPeerStream(f.Stream); err != nil {
			return err
		}
		call := &agentv1.Call{}
		if err := proto.Unmarshal(f.Payload, call); err != nil {
			return fmt.Errorf("%w: undecodable CALL: %v", errProtocol, err)
		}
		s.startUnary(f.Stream, call)
		return nil
	case conn.KindOpen:
		if err := s.claimPeerStream(f.Stream); err != nil {
			return err
		}
		open := &agentv1.Open{}
		if err := proto.Unmarshal(f.Payload, open); err != nil {
			return fmt.Errorf("%w: undecodable OPEN: %v", errProtocol, err)
		}
		s.startStream(f.Stream, open)
		return nil
	case conn.KindResult:
		res := &agentv1.Result{}
		if err := proto.Unmarshal(f.Payload, res); err != nil {
			return fmt.Errorf("%w: undecodable RESULT: %v", errProtocol, err)
		}
		if c := s.takeCall(f.Stream); c != nil {
			c.settle(res.GetResponse(), ErrorOf(res.GetStatus()))
		}
		return nil
	case conn.KindData:
		st := s.lookupStream(f.Stream)
		if st == nil {
			return s.lateFrame(f)
		}
		return st.receive(f.Payload)
	case conn.KindWindow:
		n, err := conn.ParseWindow(f.Payload)
		if err != nil {
			return fmt.Errorf("%w: %v", errProtocol, err)
		}
		if st := s.lookupStream(f.Stream); st != nil {
			if err := st.send.Grant(n); err != nil {
				return fmt.Errorf("%w: stream %d: %v", errProtocol, f.Stream, err)
			}
		}
		return nil
	case conn.KindClose:
		cl := &agentv1.Close{}
		if err := proto.Unmarshal(f.Payload, cl); err != nil {
			return fmt.Errorf("%w: undecodable CLOSE: %v", errProtocol, err)
		}
		s.peerClose(f.Stream, cl)
		return nil
	default:
		return fmt.Errorf("%w: frame kind %s", errProtocol, f.Kind)
	}
}

// claimPeerStream checks that the peer opens a new stream with its own
// parity and a higher id than before (ids are never reused).
func (s *Session) claimPeerStream(id conn.StreamID) error {
	role, ok := conn.OpenedBy(id)
	if !ok || role != s.peerRole {
		return fmt.Errorf("%w: peer opened stream %d with the wrong parity", errProtocol, id)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if id <= s.lastPeer {
		return fmt.Errorf("%w: peer reused stream id %d", errProtocol, id)
	}
	s.lastPeer = id
	return nil
}

// lateFrame accepts frames for streams that already ended (they cross our
// CLOSE in flight) but rejects frames for streams that never existed.
func (s *Session) lateFrame(f conn.Frame) error {
	role, _ := conn.OpenedBy(f.Stream)
	s.mu.Lock()
	defer s.mu.Unlock()
	if role == s.peerRole && f.Stream > s.lastPeer {
		return fmt.Errorf("%w: %s on stream %d, which the peer never opened", errProtocol, f.Kind, f.Stream)
	}
	return nil
}

func (s *Session) lookupStream(id conn.StreamID) *stream {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streams[id]
}

func (s *Session) takeCall(id conn.StreamID) *pendingCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.calls[id]
	delete(s.calls, id)
	return c
}

func (s *Session) dropStream(id conn.StreamID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.streams, id)
}

// peerClose handles a CLOSE: it cancels an incoming unary call, half-closes
// or cancels an incoming stream, finishes an outgoing stream, or ends an
// outgoing call the peer refused without a RESULT.
func (s *Session) peerClose(id conn.StreamID, cl *agentv1.Close) {
	s.mu.Lock()
	cancel := s.unary[id]
	st := s.streams[id]
	s.mu.Unlock()
	switch {
	case cancel != nil:
		cancel()
	case st != nil:
		st.peerClosed(cl)
	default:
		if c := s.takeCall(id); c != nil {
			c.settle(nil, ErrorOf(cl.GetStatus()))
		}
	}
}

// track runs fn under the session lock unless the session is closing, so
// nothing registers after Close took the maps.
func (s *Session) track(fn func()) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing.Load() {
		return false
	}
	fn()
	return true
}
