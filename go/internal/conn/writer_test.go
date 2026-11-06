package conn

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// recordingSink records frames. While gate is non-nil every write waits for
// a value on it, which lets tests queue work behind a blocked write.
type recordingSink struct {
	gate    chan struct{}
	started chan struct{}
	fail    error

	mu     sync.Mutex
	frames []Frame
}

func newGatedSink() *recordingSink {
	return &recordingSink{gate: make(chan struct{}), started: make(chan struct{}, 100)}
}

func (s *recordingSink) WriteFrame(ctx context.Context, b []byte) error {
	if s.started != nil {
		s.started <- struct{}{}
	}
	if s.gate != nil {
		select {
		case <-s.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if s.fail != nil {
		return s.fail
	}
	f, err := ParseFrame(bytes.Clone(b))
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.frames = append(s.frames, f)
	s.mu.Unlock()
	return nil
}

func (s *recordingSink) written() []Frame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Frame(nil), s.frames...)
}

// releaseAll lets every gated write through from now on.
func (s *recordingSink) releaseAll() {
	close(s.gate)
}

func waitQueued(t *testing.T, w *Writer, control, dataStreams int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		w.mu.Lock()
		c, d := len(w.control), len(w.order)
		w.mu.Unlock()
		if c == control && d == dataStreams {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("queue never reached %d control / %d data streams", control, dataStreams)
}

func TestWriterSendsControlBeforeQueuedData(t *testing.T) {
	sink := newGatedSink()
	w := NewWriter(sink)
	defer w.Close(nil)
	ctx := context.Background()

	var wg sync.WaitGroup
	// The first data write occupies the sink.
	wg.Go(func() { _ = w.WriteData(ctx, 1, []byte("first")) })
	<-sink.started
	wg.Go(func() { _ = w.WriteData(ctx, 3, []byte("bulk")) })
	waitQueued(t, w, 0, 1)
	wg.Go(func() { _ = w.WriteControl(ctx, Frame{Kind: KindCall, Stream: 5, Payload: []byte("deploy")}) })
	waitQueued(t, w, 1, 1)

	sink.releaseAll()
	wg.Wait()

	got := sink.written()
	kinds := []Kind{got[0].Kind, got[1].Kind, got[2].Kind}
	if kinds[0] != KindData || kinds[1] != KindCall || kinds[2] != KindData {
		t.Fatalf("write order = %v, want DATA (in flight), CALL, DATA", kinds)
	}
}

func TestWriterInterleavesStreamsRoundRobin(t *testing.T) {
	sink := newGatedSink()
	w := NewWriter(sink)
	defer w.Close(nil)
	ctx := context.Background()

	var wg sync.WaitGroup
	wg.Go(func() { _ = w.WriteControl(ctx, Frame{Kind: KindEvent}) })
	<-sink.started
	// Stream 1 queues a big upload (3 chunks), stream 3 a small one. Each
	// WriteData only queues its next chunk after the previous is written,
	// so queue a few separate writes per stream to model several writers.
	for range 3 {
		wg.Go(func() { _ = w.WriteData(ctx, 1, bytes.Repeat([]byte{1}, MaxDataChunk)) })
	}
	wg.Go(func() { _ = w.WriteData(ctx, 3, []byte{3}) })
	waitQueued(t, w, 0, 2)
	for {
		w.mu.Lock()
		n := len(w.data[1])
		w.mu.Unlock()
		if n == 3 {
			break
		}
		time.Sleep(time.Millisecond)
	}

	sink.releaseAll()
	wg.Wait()

	var streams []StreamID
	for _, f := range sink.written()[1:] {
		streams = append(streams, f.Stream)
	}
	// Stream 3 must not wait behind all of stream 1.
	pos := -1
	for i, s := range streams {
		if s == 3 {
			pos = i
		}
	}
	if pos < 0 || pos > 1 {
		t.Fatalf("stream order = %v, stream 3 should be served within the first two DATA frames", streams)
	}
}

func TestWriterChunksData(t *testing.T) {
	sink := &recordingSink{}
	w := NewWriter(sink)
	defer w.Close(nil)

	payload := bytes.Repeat([]byte("x"), 2*MaxDataChunk+10)
	if err := w.WriteData(context.Background(), 7, payload); err != nil {
		t.Fatal(err)
	}
	got := sink.written()
	if len(got) != 3 {
		t.Fatalf("frames = %d, want 3", len(got))
	}
	var joined []byte
	for _, f := range got {
		if len(f.Payload) > MaxDataChunk {
			t.Fatalf("chunk of %d bytes exceeds MaxDataChunk", len(f.Payload))
		}
		joined = append(joined, f.Payload...)
	}
	if !bytes.Equal(joined, payload) {
		t.Fatal("chunks do not reassemble to the payload")
	}
}

func TestWriterRejectsDataAsControl(t *testing.T) {
	w := NewWriter(&recordingSink{})
	defer w.Close(nil)
	if err := w.WriteControl(context.Background(), Frame{Kind: KindData}); err == nil {
		t.Fatal("WriteControl accepted a DATA frame")
	}
}

func TestWriterCancelledWriteIsNotSent(t *testing.T) {
	sink := newGatedSink()
	w := NewWriter(sink)
	defer w.Close(nil)

	var wg sync.WaitGroup
	wg.Go(func() { _ = w.WriteControl(context.Background(), Frame{Kind: KindEvent}) })
	<-sink.started

	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { errc <- w.WriteControl(ctx, Frame{Kind: KindCall, Stream: 9}) }()
	waitQueued(t, w, 1, 0)
	cancel()
	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}

	sink.releaseAll()
	wg.Wait()
	if err := w.WriteControl(context.Background(), Frame{Kind: KindClose, Stream: 11}); err != nil {
		t.Fatal(err)
	}
	for _, f := range sink.written() {
		if f.Stream == 9 {
			t.Fatal("a cancelled write reached the sink")
		}
	}
}

func TestWriterFailsEverythingAfterSinkError(t *testing.T) {
	boom := errors.New("socket gone")
	sink := newGatedSink()
	sink.fail = boom
	w := NewWriter(sink)
	defer w.Close(nil)
	ctx := context.Background()

	errs := make(chan error, 2)
	go func() { errs <- w.WriteControl(ctx, Frame{Kind: KindEvent}) }()
	<-sink.started
	go func() { errs <- w.WriteData(ctx, 1, []byte("queued")) }()
	waitQueued(t, w, 0, 1)
	sink.gate <- struct{}{}

	for range 2 {
		if err := <-errs; !errors.Is(err, boom) {
			t.Fatalf("err = %v, want %v", err, boom)
		}
	}
	if err := w.WriteControl(ctx, Frame{Kind: KindEvent}); !errors.Is(err, boom) {
		t.Fatalf("write after failure = %v", err)
	}
	if !errors.Is(w.Err(), boom) {
		t.Fatalf("Err() = %v", w.Err())
	}
}

func TestWriterCloseFailsBlockedAndFutureWrites(t *testing.T) {
	sink := newGatedSink()
	w := NewWriter(sink)

	errs := make(chan error, 2)
	go func() { errs <- w.WriteControl(context.Background(), Frame{Kind: KindEvent}) }()
	<-sink.started
	go func() { errs <- w.WriteControl(context.Background(), Frame{Kind: KindCall, Stream: 1}) }()
	waitQueued(t, w, 1, 0)

	w.Close(nil)
	for range 2 {
		if err := <-errs; err == nil {
			t.Fatal("write survived Close")
		}
	}
	if err := w.WriteControl(context.Background(), Frame{Kind: KindEvent}); !errors.Is(err, ErrWriterClosed) {
		t.Fatalf("err = %v, want ErrWriterClosed", err)
	}
}

func TestSendDataWaitsForCredit(t *testing.T) {
	sink := &recordingSink{}
	w := NewWriter(sink)
	defer w.Close(nil)
	window := NewSendWindow(4)

	done := make(chan error, 1)
	go func() {
		n, err := w.SendData(context.Background(), 1, window, []byte("0123456789"))
		if err == nil && n != 10 {
			err = errors.New("short write")
		}
		done <- err
	}()

	time.Sleep(20 * time.Millisecond)
	if got := sink.written(); len(got) != 1 || string(got[0].Payload) != "0123" {
		t.Fatalf("before more credit, frames = %+v", got)
	}
	if err := window.Grant(6); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var joined []byte
	for _, f := range sink.written() {
		joined = append(joined, f.Payload...)
	}
	if string(joined) != "0123456789" {
		t.Fatalf("payload = %q", joined)
	}
}
