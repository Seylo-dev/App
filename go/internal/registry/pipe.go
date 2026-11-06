package registry

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// bufSize is the copy buffer per direction; DATA frames are 32 KiB.
const bufSize = 32 << 10

// closeWriter is a connection that can half-close (TCP, unix).
type closeWriter interface{ CloseWrite() error }

func closeWrite(c net.Conn) {
	if cw, ok := c.(closeWriter); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = c.Close()
}

// pipeClient relays a local connection over an opened stream (the
// opener's side: it can half-close with CloseSend). It returns when both
// directions are done or one failed, and always closes conn.
func pipeClient(conn net.Conn, s rpc.Stream, finish proto.Message) error {
	defer conn.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, err := io.CopyBuffer(s, conn, make([]byte, bufSize))
		if err != nil && !errors.Is(err, net.ErrClosed) {
			errs <- err
			_ = conn.Close()
			return
		}
		_ = s.CloseSend()
	}()
	_, err := io.CopyBuffer(conn, s, make([]byte, bufSize))
	if err != nil {
		errs <- err
	}
	// The far end is done sending. Tell the local side, then wait until it
	// is done too (it may still be sending a request body).
	closeWrite(conn)
	wg.Wait()
	ferr := s.Finish(finish)
	close(errs)
	if e := <-errs; e != nil {
		return e
	}
	return ferr
}

// pipeServer relays a raw bidi stream (the handler's side) to conn. It
// returns when conn has nothing more to send: the handler then returns and
// the stream closes.
func pipeServer(ctx context.Context, s rpc.RawStream, conn net.Conn) error {
	defer conn.Close()
	go func() {
		// Upstream: stream -> conn until the opener half-closes. This
		// goroutine ends at the latest when the stream is torn down.
		_, err := io.CopyBuffer(conn, s, make([]byte, bufSize))
		if err != nil {
			_ = conn.Close()
			return
		}
		closeWrite(conn)
	}()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	_, err := io.CopyBuffer(s, conn, make([]byte, bufSize))
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil && !errors.Is(err, net.ErrClosed) {
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "the tunnel target closed the connection")
	}
	return nil
}
