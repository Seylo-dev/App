package rpc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
)

// errSendClosed is returned when writing after CloseSend or after this
// side ended the stream.
var errSendClosed = errors.New("rpc: stream closed for sending")

// stream is one streaming or raw call, in either direction. The read loop
// feeds it (receive, peerClosed); the handler or caller reads and writes.
type stream struct {
	s      *Session
	id     conn.StreamID
	name   string
	shape  Shape
	mode   agentv1.StreamMode
	opener bool // this side sent the OPEN

	// ctx is the handler's ctx (incoming) or a child of the Open ctx
	// (outgoing); reads and writes give up when it ends.
	ctx    context.Context
	cancel context.CancelFunc

	send *conn.SendWindow
	recv *conn.RecvWindow

	mu        sync.Mutex
	buf       []byte
	recvEOF   bool  // the peer sends nothing more; drain buf, then io.EOF
	recvErr   error // the stream failed; reads return it
	wake      chan struct{}
	sentClose bool

	// Outgoing streams only: closed when the responder's CLOSE arrived or
	// the stream failed, with the final status and raw response.
	finished   chan struct{}
	finishOnce sync.Once
	status     error
	resp       []byte
	stopAfter  func() bool
}

func (s *Session) newStream(id conn.StreamID, name string, shape Shape, mode agentv1.StreamMode, opener bool, window uint32, ctx context.Context, cancel context.CancelFunc) *stream {
	return &stream{
		s: s, id: id, name: name, shape: shape, mode: mode, opener: opener,
		ctx: ctx, cancel: cancel,
		send:     conn.NewSendWindow(window),
		recv:     conn.NewRecvWindow(window),
		wake:     make(chan struct{}),
		finished: make(chan struct{}),
	}
}

// receive buffers a DATA payload (read loop).
func (st *stream) receive(payload []byte) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.recvEOF {
		return fmt.Errorf("%w: DATA on stream %d after the peer closed it", errProtocol, st.id)
	}
	if !st.mayReceive() {
		return fmt.Errorf("%w: DATA on stream %d of %s, which carries none in this direction", errProtocol, st.id, st.name)
	}
	if err := st.recv.Receive(len(payload)); err != nil {
		return fmt.Errorf("%w: stream %d: %v", errProtocol, st.id, err)
	}
	if st.recvErr != nil {
		return nil // failed locally; drop
	}
	st.buf = append(st.buf, payload...)
	st.signal()
	return nil
}

// mayReceive reports whether the peer may send DATA on this stream.
func (st *stream) mayReceive() bool {
	switch st.mode {
	case agentv1.StreamMode_STREAM_MODE_RAW_DOWNLOAD:
		return st.opener
	case agentv1.StreamMode_STREAM_MODE_RAW_UPLOAD:
		return !st.opener
	default:
		return true
	}
}

func (st *stream) signal() {
	close(st.wake)
	st.wake = make(chan struct{})
}

// peerClosed handles the peer's CLOSE (read loop).
func (st *stream) peerClosed(cl *agentv1.Close) {
	if st.opener {
		// The responder ended the stream. Buffered data stays readable.
		st.s.dropStream(st.id)
		st.finish(ErrorOf(cl.GetStatus()), cl.GetResponse())
		return
	}
	code := cl.GetStatus().GetCode()
	if code == agentv1.StatusCode_STATUS_CODE_OK || code == agentv1.StatusCode_STATUS_CODE_UNSPECIFIED {
		// The opener half-closed: the handler reads io.EOF after the buffer.
		st.mu.Lock()
		st.recvEOF = true
		st.signal()
		st.mu.Unlock()
		return
	}
	// The opener cancelled the call.
	st.fail(ErrorOf(cl.GetStatus()))
	st.cancel()
}

// finish records the final outcome of an outgoing stream (once).
func (st *stream) finish(status error, resp []byte) {
	st.finishOnce.Do(func() {
		st.mu.Lock()
		st.status, st.resp = status, resp
		st.recvEOF = true
		st.sentClose = true
		st.signal()
		stop := st.stopAfter
		st.mu.Unlock()
		st.send.Close(errSendClosed)
		close(st.finished)
		if stop != nil {
			stop()
		}
	})
}

// fail ends reads and writes with err.
func (st *stream) fail(err error) {
	st.mu.Lock()
	if st.recvErr == nil {
		st.recvErr = err
		st.buf = nil
		st.signal()
	}
	st.mu.Unlock()
	st.send.Close(err)
}

// abort is called when the session closes.
func (st *stream) abort(err error) {
	st.fail(err)
	if st.opener {
		st.finish(err, nil)
	}
	st.cancel()
}

func (st *stream) ctxErr() error {
	if err := st.ctx.Err(); err != nil {
		if st.opener {
			return err
		}
		// A handler's ctx ends because the opener cancelled or the
		// connection dropped; recvErr says which when it is set.
		st.mu.Lock()
		defer st.mu.Unlock()
		if st.recvErr != nil {
			return st.recvErr
		}
		return err
	}
	return nil
}

// read copies buffered bytes into p and returns credit as they are consumed.
func (st *stream) read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for {
		st.mu.Lock()
		if len(st.buf) > 0 {
			n := copy(p, st.buf)
			st.buf = st.buf[n:]
			if len(st.buf) == 0 {
				st.buf = nil
			}
			eof := st.recvEOF
			st.mu.Unlock()
			if inc := st.recv.Consume(n); inc > 0 && !eof {
				_ = st.s.writeControl(st.s.ctx, conn.WindowFrame(st.id, inc))
			}
			return n, nil
		}
		if err := st.recvErr; err != nil {
			st.mu.Unlock()
			return 0, err
		}
		if st.recvEOF {
			st.mu.Unlock()
			return 0, io.EOF
		}
		wake := st.wake
		st.mu.Unlock()
		select {
		case <-wake:
		case <-st.ctx.Done():
			return 0, st.ctxErr()
		}
	}
}

// write sends p as DATA, blocking while the peer has granted no credit.
func (st *stream) write(p []byte) (int, error) {
	st.mu.Lock()
	closed := st.sentClose
	st.mu.Unlock()
	if closed {
		return 0, errSendClosed
	}
	n, err := st.s.w.SendData(st.ctx, st.id, st.send, p)
	if err != nil {
		if errors.Is(err, conn.ErrWindowClosed) || errors.Is(err, errSendClosed) {
			return n, errSendClosed
		}
		var rpcErr *Error
		if errors.As(err, &rpcErr) {
			return n, err
		}
		if st.ctx.Err() != nil {
			return n, st.ctxErr()
		}
		return n, st.s.writeFailed(st.ctx, err)
	}
	return n, nil
}

func (st *stream) sendMsg(msg proto.Message) error {
	var buf bytes.Buffer
	if _, err := protodelim.MarshalTo(&buf, msg); err != nil {
		return fmt.Errorf("encoding stream message: %w", err)
	}
	_, err := st.write(buf.Bytes())
	return err
}

func (st *stream) recvMsg(msg proto.Message) error {
	return protodelim.UnmarshalFrom(byteReader{st}, msg)
}

// byteReader adapts a stream to protodelim's io.Reader + io.ByteReader.
type byteReader struct{ st *stream }

func (r byteReader) Read(p []byte) (int, error) { return r.st.read(p) }

func (r byteReader) ReadByte() (byte, error) {
	var b [1]byte
	if _, err := r.st.read(b[:]); err != nil {
		return 0, err
	}
	return b[0], nil
}

// startStream runs an incoming OPEN on its own goroutine; the handler's
// return becomes the final CLOSE.
func (s *Session) startStream(id conn.StreamID, open *agentv1.Open) {
	h, refused := s.handlerFor(open.GetMethod(), false)
	if refused != nil {
		go s.sendClose(id, refused, nil)
		return
	}
	window := open.GetInitialWindow()
	if window == 0 {
		window = conn.DefaultWindow
	}
	ctx, cancel := s.callContext(h, open.GetDeadline(), open.GetTimeout(), open.GetMetadata())
	st := s.newStream(id, h.FullName(), h.Shape, h.Mode, false, window, ctx, cancel)
	if !s.track(func() { s.streams[id] = st }) {
		cancel()
		return
	}
	s.stats.inStreams.Add(1)
	s.stats.inTotal.Add(1)
	go func() {
		resp, err := s.runStream(ctx, h, st, open.GetRequest())
		s.stats.inStreams.Add(-1)
		s.dropStream(id)
		st.mu.Lock()
		st.sentClose = true
		st.mu.Unlock()
		st.send.Close(errSendClosed)
		cancel()

		status := StatusOf(err)
		var payload []byte
		if err == nil && resp != nil {
			if payload, err = proto.Marshal(resp); err != nil {
				s.cfg.Logger.Error("encoding handler response", "method", h.FullName(), "err", err)
				status = StatusOf(err)
			}
		}
		s.sendClose(id, status, payload)
	}()
}

func (s *Session) runStream(ctx context.Context, h *Handler, st *stream, raw []byte) (resp proto.Message, err error) {
	first := h.NewRequest()
	if err := proto.Unmarshal(raw, first); err != nil {
		return nil, NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "undecodable request for "+string(h.Method.Name()))
	}
	defer s.recoverHandler(h, &err)
	if h.Shape == ShapeStreaming {
		err = h.Stream(ctx, first, serverStream{st})
		s.logHandlerError(h, err)
		return nil, err
	}
	resp, err = h.Raw(ctx, first, serverRaw{st})
	s.logHandlerError(h, err)
	if err == nil && resp == nil {
		resp = h.NewResponse()
	}
	return resp, err
}

// serverStream is a handler's end of a streaming call.
type serverStream struct{ st *stream }

func (t serverStream) Send(msg proto.Message) error { return t.st.sendMsg(msg) }
func (t serverStream) Recv(msg proto.Message) error { return t.st.recvMsg(msg) }

// serverRaw is a handler's end of a raw call.
type serverRaw struct{ st *stream }

func (t serverRaw) Read(p []byte) (int, error) {
	if t.st.mode == agentv1.StreamMode_STREAM_MODE_RAW_DOWNLOAD {
		return 0, io.EOF
	}
	return t.st.read(p)
}

func (t serverRaw) Write(p []byte) (int, error) {
	if t.st.mode == agentv1.StreamMode_STREAM_MODE_RAW_UPLOAD {
		return 0, fmt.Errorf("rpc: %s does not send bytes back", t.st.name)
	}
	return t.st.write(p)
}

// Open starts a streaming or raw call to the peer with its first request.
// Cancelling ctx cancels the call on the peer.
func (s *Session) Open(ctx context.Context, method string, req proto.Message) (Stream, error) {
	md, err := s.outgoingMethod(method, false)
	if err != nil {
		return nil, err
	}
	payload, err := proto.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("encoding %s request: %w", md.Name(), err)
	}
	open := &agentv1.Open{Method: MethodName(md), Request: payload, InitialWindow: s.cfg.InitialWindow, Metadata: OutgoingMetadata(ctx)}
	open.Deadline, open.Timeout = outgoingDeadline(ctx)
	frame, err := proto.Marshal(open)
	if err != nil {
		return nil, fmt.Errorf("encoding open: %w", err)
	}
	s.openMu.Lock()
	id, err := s.ids.Next()
	if err != nil {
		s.openMu.Unlock()
		s.Close(err)
		return nil, unavailable()
	}
	sctx, cancel := context.WithCancel(ctx)
	st := s.newStream(id, MethodName(md), MethodShape(md), MethodStreamMode(md), true, s.cfg.InitialWindow, sctx, cancel)
	if !s.track(func() { s.streams[id] = st }) {
		s.openMu.Unlock()
		cancel()
		return nil, unavailable()
	}
	err = s.writeControl(ctx, conn.Frame{Kind: conn.KindOpen, Stream: id, Payload: frame})
	s.openMu.Unlock()
	if err != nil {
		s.dropStream(id)
		cancel()
		return nil, err
	}
	s.stats.outStreams.Add(1)
	s.stats.outTotal.Add(1)
	stop := context.AfterFunc(ctx, func() { st.cancelByOpener(ctx.Err()) })
	st.mu.Lock()
	st.stopAfter = stop
	st.mu.Unlock()
	go func() {
		<-st.finished
		s.stats.outStreams.Add(-1)
	}()
	return &clientStream{st: st}, nil
}

// cancelByOpener tells the responder to stop and fails the stream locally.
func (st *stream) cancelByOpener(err error) {
	select {
	case <-st.finished:
		return
	default:
	}
	st.s.dropStream(st.id)
	go st.s.sendClose(st.id, &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_CANCELLED, Message: "cancelled by the caller"}, nil)
	st.fail(err)
	st.finish(err, nil)
}

// clientStream is the caller's end of an outgoing stream.
type clientStream struct{ st *stream }

var _ Stream = (*clientStream)(nil)

func (c *clientStream) raw() bool { return c.st.shape == ShapeRaw }

func (c *clientStream) Send(msg proto.Message) error {
	if c.raw() {
		return fmt.Errorf("rpc: %s is raw: use Write", c.st.name)
	}
	return c.st.sendMsg(msg)
}

func (c *clientStream) Recv(msg proto.Message) error {
	if c.raw() {
		return fmt.Errorf("rpc: %s is raw: use Read", c.st.name)
	}
	err := c.st.recvMsg(msg)
	if err == io.EOF {
		return c.endErr()
	}
	return err
}

// endErr is what a reader sees after the last byte: the final status, or
// io.EOF when the responder finished with OK.
func (c *clientStream) endErr() error {
	select {
	case <-c.st.finished:
		if c.st.status != nil {
			return c.st.status
		}
	case <-c.st.ctx.Done():
		return c.st.ctx.Err()
	}
	return io.EOF
}

func (c *clientStream) Read(p []byte) (int, error) {
	if !c.raw() {
		return 0, fmt.Errorf("rpc: %s is not raw: use Recv", c.st.name)
	}
	if c.st.mode == agentv1.StreamMode_STREAM_MODE_RAW_UPLOAD {
		return 0, io.EOF
	}
	n, err := c.st.read(p)
	if err == io.EOF {
		return n, c.endErr()
	}
	return n, err
}

func (c *clientStream) Write(p []byte) (int, error) {
	if !c.raw() {
		return 0, fmt.Errorf("rpc: %s is not raw: use Send", c.st.name)
	}
	if c.st.mode == agentv1.StreamMode_STREAM_MODE_RAW_DOWNLOAD {
		return 0, fmt.Errorf("rpc: %s does not take uploaded bytes", c.st.name)
	}
	return c.st.write(p)
}

func (c *clientStream) CloseSend() error {
	st := c.st
	st.mu.Lock()
	already := st.sentClose
	st.sentClose = true
	st.mu.Unlock()
	if already {
		return nil
	}
	payload, err := proto.Marshal(&agentv1.Close{Status: &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_OK}})
	if err != nil {
		return err
	}
	return st.s.writeControl(st.ctx, conn.Frame{Kind: conn.KindClose, Stream: st.id, Payload: payload})
}

func (c *clientStream) Finish(resp proto.Message) error {
	st := c.st
	select {
	case <-st.finished:
	case <-st.ctx.Done():
		st.cancelByOpener(st.ctx.Err())
	}
	defer st.cancel()
	if st.status != nil {
		return st.status
	}
	if resp != nil {
		proto.Reset(resp)
		if err := proto.Unmarshal(st.resp, resp); err != nil {
			return fmt.Errorf("decoding %s response: %w", st.name, err)
		}
	}
	return nil
}
