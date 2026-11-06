package rpc

import (
	"context"
	"io"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Peer is the other end of an agent connection.
type Peer interface {
	// Call performs a unary call and fills resp.
	Call(ctx context.Context, method string, req, resp proto.Message) error
	// Open starts a streaming or raw call with its first request.
	Open(ctx context.Context, method string, req proto.Message) (Stream, error)
	// Notify sends a best-effort EVENT frame. Durable events go through the
	// outbox and PanelService.ReportEvent instead.
	Notify(ctx context.Context, event *agentv1.Event) error
}

// Stream is one open streaming or raw call. Message methods are for normal
// streaming methods, Read and Write for raw ones; using the wrong pair
// returns an error.
type Stream interface {
	// Send writes one message as a size-delimited DATA payload.
	Send(msg proto.Message) error
	// Recv reads the next message; io.EOF after the peer closed cleanly.
	Recv(msg proto.Message) error

	// Read and Write move raw bytes, flow controlled.
	io.Reader
	io.Writer

	// CloseSend half-closes: this side sends nothing more.
	CloseSend() error
	// Finish waits for the responder's CLOSE and returns its status as an
	// error. For raw methods resp receives the response; pass nil
	// otherwise.
	Finish(resp proto.Message) error
}
