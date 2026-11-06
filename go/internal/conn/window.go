package conn

import (
	"context"
	"errors"
	"math"
	"sync"
)

const (
	// DefaultWindow is the initial per-stream window when Open does not ask
	// for another. 256 KiB keeps a WebSocket across an ocean busy (a 120 ms
	// RTT at ~17 Mbit/s per stream) without letting one stream buffer much.
	DefaultWindow = 256 << 10

	// maxWindow is the most credit a sender may hold. Larger grants mean the
	// peer is broken or hostile.
	maxWindow = math.MaxInt32
)

// ErrFlowControl means the peer broke flow control: it sent more DATA than
// it had credit for or granted more credit than allowed. The stream (or
// connection) must be reset.
var ErrFlowControl = errors.New("conn: flow control violation")

// ErrWindowClosed is returned by SendWindow.Acquire after Close with a nil
// reason.
var ErrWindowClosed = errors.New("conn: stream closed")

// SendWindow is the credit this side holds for sending DATA on one stream.
// Acquire takes credit before writing; Grant adds credit when a WINDOW frame
// arrives. Safe for concurrent use.
type SendWindow struct {
	mu        sync.Mutex
	available int64
	err       error
	// wake is closed and replaced whenever credit arrives or the window
	// closes, waking every blocked Acquire. A channel instead of sync.Cond
	// so waiters can also select on their context.
	wake chan struct{}
}

// NewSendWindow returns a window holding the peer's initial credit.
func NewSendWindow(initial uint32) *SendWindow {
	return &SendWindow{available: int64(initial), wake: make(chan struct{})}
}

// Acquire blocks until credit is available, then takes up to max bytes of
// it and returns how many it took (at least 1).
func (w *SendWindow) Acquire(ctx context.Context, max int) (int, error) {
	if max <= 0 {
		return 0, nil
	}
	for {
		w.mu.Lock()
		if w.err != nil {
			err := w.err
			w.mu.Unlock()
			return 0, err
		}
		if w.available > 0 {
			n := int(min(int64(max), w.available))
			w.available -= int64(n)
			w.mu.Unlock()
			return n, nil
		}
		wake := w.wake
		w.mu.Unlock()

		select {
		case <-wake:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
}

// Grant adds credit from a WINDOW frame.
func (w *SendWindow) Grant(increment uint32) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return nil // credit for a closed stream is harmless
	}
	if w.available+int64(increment) > maxWindow {
		return ErrFlowControl
	}
	w.available += int64(increment)
	w.broadcast()
	return nil
}

// Available returns the credit currently held.
func (w *SendWindow) Available() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.available
}

// Close fails current and future Acquire calls with err (ErrWindowClosed
// when nil). Closing twice keeps the first error.
func (w *SendWindow) Close(err error) {
	if err == nil {
		err = ErrWindowClosed
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err == nil {
		w.err = err
		w.broadcast()
	}
}

func (w *SendWindow) broadcast() {
	close(w.wake)
	w.wake = make(chan struct{})
}

// RecvWindow is the receive side of one stream's flow control. It checks
// that the peer stays within its credit and decides when to return credit.
// Credit is returned only as the application consumes data, so at most
// `size` bytes are ever buffered for a slow reader.
type RecvWindow struct {
	mu sync.Mutex
	// size is the window granted at open.
	size uint32
	// peerCredit is what the peer may still send.
	peerCredit int64
	// unacked is consumed data not yet returned as credit.
	unacked uint32
}

// NewRecvWindow returns a receive window of the given size, matching the
// initial window advertised to the peer.
func NewRecvWindow(size uint32) *RecvWindow {
	return &RecvWindow{size: size, peerCredit: int64(size)}
}

// Receive accounts for an incoming DATA payload of n bytes.
func (w *RecvWindow) Receive(n int) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if int64(n) > w.peerCredit {
		return ErrFlowControl
	}
	w.peerCredit -= int64(n)
	return nil
}

// Consume records that the application read n bytes. It returns the
// increment to send in a WINDOW frame, or 0 when it is not worth a frame
// yet. Batching to half a window keeps WINDOW traffic to about two frames
// per window of data.
func (w *RecvWindow) Consume(n int) uint32 {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.unacked += uint32(n)
	if w.unacked < w.size/2 || w.unacked == 0 {
		return 0
	}
	increment := w.unacked
	w.unacked = 0
	w.peerCredit += int64(increment)
	return increment
}
