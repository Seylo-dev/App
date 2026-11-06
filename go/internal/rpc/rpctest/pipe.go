package rpctest

import (
	"context"
	"errors"
	"io"
	"sync"

	"github.com/seylo-dev/app/go/internal/conn"
)

// chunk mirrors the 32 KiB DATA chunking of the real writer.
const chunk = 32 << 10

var errPipeClosed = errors.New("rpctest: stream already finished")

// pipe is one direction of an in-memory stream with the same credit rules
// as the wire: the writer takes credit from a conn.SendWindow before
// buffering bytes, and the reader returns credit as it consumes them. A
// writer that runs ahead of its reader blocks, exactly like on a real
// connection.
type pipe struct {
	window *conn.SendWindow

	mu     sync.Mutex
	buf    []byte
	eof    bool  // writer half-closed: reads drain, then io.EOF
	err    error // aborted: reads and writes fail with err
	wakeCh chan struct{}
}

func newPipe(window uint32) *pipe {
	return &pipe{window: conn.NewSendWindow(window), wakeCh: make(chan struct{})}
}

func (p *pipe) wake() {
	close(p.wakeCh)
	p.wakeCh = make(chan struct{})
}

func (p *pipe) write(ctx context.Context, b []byte) (int, error) {
	written := 0
	for len(b) > 0 {
		n, err := p.window.Acquire(ctx, min(len(b), chunk))
		if err != nil {
			return written, err
		}
		p.mu.Lock()
		switch {
		case p.err != nil:
			err = p.err
		case p.eof:
			err = errPipeClosed
		default:
			p.buf = append(p.buf, b[:n]...)
			p.wake()
		}
		p.mu.Unlock()
		if err != nil {
			return written, err
		}
		b = b[n:]
		written += n
	}
	return written, nil
}

func (p *pipe) read(ctx context.Context, b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	for {
		p.mu.Lock()
		if len(p.buf) > 0 {
			n := copy(b, p.buf)
			p.buf = p.buf[n:]
			p.mu.Unlock()
			// Credit goes back as bytes are consumed. Grant only fails for a
			// broken peer, which an in-memory pipe cannot be.
			_ = p.window.Grant(uint32(n))
			return n, nil
		}
		if p.err != nil {
			err := p.err
			p.mu.Unlock()
			return 0, err
		}
		if p.eof {
			p.mu.Unlock()
			return 0, io.EOF
		}
		wake := p.wakeCh
		p.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
}

// closeWrite half-closes: the reader drains what is buffered, then gets
// io.EOF.
func (p *pipe) closeWrite() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.eof {
		p.eof = true
		p.wake()
	}
}

// abort fails both ends with err, dropping buffered bytes.
func (p *pipe) abort(err error) {
	p.window.Close(err)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err == nil {
		p.err = err
		p.buf = nil
		p.wake()
	}
}

// reader adapts one end of a pipe to io.Reader and io.ByteReader (what
// protodelim needs) under a context.
type reader struct {
	ctx context.Context
	p   *pipe
}

func (r reader) Read(b []byte) (int, error) { return r.p.read(r.ctx, b) }

func (r reader) ReadByte() (byte, error) {
	var b [1]byte
	if _, err := r.p.read(r.ctx, b[:]); err != nil {
		return 0, err
	}
	return b[0], nil
}
