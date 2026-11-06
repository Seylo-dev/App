package conn

import (
	"context"
	"errors"
	"sync"
)

// FrameSink is where the Writer puts encoded frames, one at a time. The
// WebSocket Transport implements it.
type FrameSink interface {
	WriteFrame(ctx context.Context, frame []byte) error
}

// ErrWriterClosed is returned for writes after Close with a nil reason.
var ErrWriterClosed = errors.New("conn: writer closed")

// Writer is the single writer of a connection. Callers block until their
// frame has been written (or failed), which gives natural backpressure and
// bounds memory to one queued frame per writing goroutine.
//
// Scheduling: any queued control frame is written before any DATA frame;
// DATA is served round-robin, one chunk per stream per turn.
type Writer struct {
	sink FrameSink

	mu      sync.Mutex
	control []*pendingWrite
	data    map[StreamID][]*pendingWrite
	// order lists streams with queued DATA in round-robin order. A stream
	// appears at most once.
	order []StreamID
	err   error

	// signal has capacity 1 and wakes the loop when work is queued.
	signal chan struct{}
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

type pendingWrite struct {
	frame  []byte
	stream StreamID
	// result receives the write outcome once; buffered so the loop never
	// blocks on a caller that gave up.
	result chan error
	// taken is set (under Writer.mu) when the loop dequeues the write. A
	// cancelled caller removes a write only while it is not taken, so an
	// error from Write always means "not written".
	taken bool
}

// NewWriter starts a writer goroutine over sink. Call Close to stop it.
func NewWriter(sink FrameSink) *Writer {
	ctx, cancel := context.WithCancel(context.Background())
	w := &Writer{
		sink:   sink,
		data:   make(map[StreamID][]*pendingWrite),
		signal: make(chan struct{}, 1),
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go w.loop()
	return w
}

// WriteControl writes a control frame ahead of all queued DATA.
func (w *Writer) WriteControl(ctx context.Context, f Frame) error {
	if !f.Kind.IsControl() {
		return errors.New("conn: WriteControl called with a DATA frame")
	}
	return w.enqueue(ctx, &pendingWrite{frame: f.Encode(), stream: f.Stream, result: make(chan error, 1)}, true)
}

// WriteData writes p as DATA frames of at most MaxDataChunk bytes. It does
// not check flow control; use SendData for that. On error some leading
// chunks may already have been written.
func (w *Writer) WriteData(ctx context.Context, stream StreamID, p []byte) error {
	for len(p) > 0 {
		n := min(len(p), MaxDataChunk)
		f := Frame{Kind: KindData, Stream: stream, Payload: p[:n]}
		if err := w.enqueue(ctx, &pendingWrite{frame: f.Encode(), stream: stream, result: make(chan error, 1)}, false); err != nil {
			return err
		}
		p = p[n:]
	}
	return nil
}

// SendData writes p on stream while respecting the stream's send window:
// it acquires credit before each chunk and blocks while the peer has not
// granted more. It returns the number of bytes written.
func (w *Writer) SendData(ctx context.Context, stream StreamID, window *SendWindow, p []byte) (int, error) {
	written := 0
	for written < len(p) {
		n, err := window.Acquire(ctx, min(len(p)-written, MaxDataChunk))
		if err != nil {
			return written, err
		}
		if err := w.WriteData(ctx, stream, p[written:written+n]); err != nil {
			return written, err
		}
		written += n
	}
	return written, nil
}

// Close stops the writer. Queued and future writes fail with reason
// (ErrWriterClosed when nil). Close waits for the loop to exit; a write in
// progress is cancelled through the sink's context.
func (w *Writer) Close(reason error) {
	if reason == nil {
		reason = ErrWriterClosed
	}
	w.fail(reason)
	w.cancel()
	<-w.done
}

// Err returns the error that stopped the writer, or nil while it runs.
func (w *Writer) Err() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err
}

func (w *Writer) enqueue(ctx context.Context, pw *pendingWrite, control bool) error {
	w.mu.Lock()
	if w.err != nil {
		err := w.err
		w.mu.Unlock()
		return err
	}
	if control {
		w.control = append(w.control, pw)
	} else {
		if len(w.data[pw.stream]) == 0 {
			w.order = append(w.order, pw.stream)
		}
		w.data[pw.stream] = append(w.data[pw.stream], pw)
	}
	w.mu.Unlock()

	select {
	case w.signal <- struct{}{}:
	default: // the loop is already signalled
	}

	select {
	case err := <-pw.result:
		return err
	case <-ctx.Done():
		if w.remove(pw, control) {
			return ctx.Err()
		}
		// The loop already took it: the outcome is moments away and must
		// be reported truthfully.
		return <-pw.result
	}
}

// remove drops a queued write that has not been taken yet.
func (w *Writer) remove(pw *pendingWrite, control bool) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if pw.taken || w.err != nil {
		return false
	}
	if control {
		w.control = deleteWrite(w.control, pw)
		return true
	}
	queue := deleteWrite(w.data[pw.stream], pw)
	if len(queue) == 0 {
		delete(w.data, pw.stream)
		w.order = deleteStream(w.order, pw.stream)
	} else {
		w.data[pw.stream] = queue
	}
	return true
}

func (w *Writer) loop() {
	defer close(w.done)
	for {
		pw, ok := w.next()
		if !ok {
			select {
			case <-w.signal:
				continue
			case <-w.ctx.Done():
				return
			}
		}
		err := w.sink.WriteFrame(w.ctx, pw.frame)
		pw.result <- err
		if err != nil {
			w.fail(err)
			return
		}
	}
}

// next dequeues the next write by the scheduling rules, marking it taken.
func (w *Writer) next() (*pendingWrite, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return nil, false
	}
	if len(w.control) > 0 {
		pw := w.control[0]
		w.control[0] = nil
		w.control = w.control[1:]
		pw.taken = true
		return pw, true
	}
	if len(w.order) == 0 {
		return nil, false
	}
	stream := w.order[0]
	w.order = w.order[1:]
	queue := w.data[stream]
	pw := queue[0]
	queue[0] = nil
	if queue = queue[1:]; len(queue) > 0 {
		w.data[stream] = queue
		w.order = append(w.order, stream) // back of the line
	} else {
		delete(w.data, stream)
	}
	pw.taken = true
	return pw, true
}

// fail records the first error and fails every queued write with it.
func (w *Writer) fail(err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return
	}
	w.err = err
	for _, pw := range w.control {
		pw.result <- err
	}
	for _, queue := range w.data {
		for _, pw := range queue {
			pw.result <- err
		}
	}
	w.control, w.data, w.order = nil, nil, nil
}

func deleteWrite(queue []*pendingWrite, target *pendingWrite) []*pendingWrite {
	for i, pw := range queue {
		if pw == target {
			return append(queue[:i], queue[i+1:]...)
		}
	}
	return queue
}

func deleteStream(order []StreamID, target StreamID) []StreamID {
	for i, id := range order {
		if id == target {
			return append(order[:i], order[i+1:]...)
		}
	}
	return order
}
