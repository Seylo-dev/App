package conn

import (
	"context"
	"errors"
	"sync"
)

// ErrTransportClosed is returned by a Pipe end after either side closed.
var ErrTransportClosed = errors.New("conn: transport closed")

// Pipe returns two connected in-memory Transports, for tests and for
// running both sides of the protocol in one process. Frames written on one
// end are read, in order, from the other. Close on either end closes both;
// reads drain frames already delivered first.
func Pipe() (Transport, Transport) {
	shared := &pipeShared{closed: make(chan struct{})}
	ab := make(chan []byte, 64)
	ba := make(chan []byte, 64)
	return &pipeEnd{shared: shared, in: ba, out: ab}, &pipeEnd{shared: shared, in: ab, out: ba}
}

type pipeShared struct {
	once   sync.Once
	closed chan struct{}
	reason string
}

type pipeEnd struct {
	shared *pipeShared
	in     <-chan []byte
	out    chan<- []byte
}

func (p *pipeEnd) WriteFrame(ctx context.Context, frame []byte) error {
	select {
	case <-p.shared.closed:
		return ErrTransportClosed
	default:
	}
	b := append([]byte(nil), frame...)
	select {
	case p.out <- b:
		return nil
	case <-p.shared.closed:
		return ErrTransportClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *pipeEnd) ReadFrame(ctx context.Context) (Frame, error) {
	select {
	case b := <-p.in:
		return ParseFrame(b)
	default:
	}
	select {
	case b := <-p.in:
		return ParseFrame(b)
	case <-p.shared.closed:
		return Frame{}, ErrTransportClosed
	case <-ctx.Done():
		return Frame{}, ctx.Err()
	}
}

func (p *pipeEnd) Close(reason string) error {
	p.shared.once.Do(func() {
		p.shared.reason = reason
		close(p.shared.closed)
	})
	return nil
}
