package rpc

import (
	"context"
	"io"
	"maps"
	"time"

	"google.golang.org/protobuf/proto"
)

// ServerStream is the responder's side of a streaming call. It is used by
// one handler goroutine; Send and Recv may run on two goroutines at once
// (one sending, one receiving), but not two Sends or two Recvs.
//
// Flow control: Send blocks until the opener granted credit for the bytes
// (initial window from OPEN, then WINDOW frames), so a slow panel or
// browser slows the handler down instead of growing memory. Recv returns
// credit as messages are consumed. Both fail once ctx is done.
//
// Close is implicit: the stream ends when the handler returns.
type ServerStream interface {
	// Send writes one response message.
	Send(msg proto.Message) error
	// Recv reads the next request after the first into msg; io.EOF once
	// the opener half-closed.
	Recv(msg proto.Message) error
}

// RawStream moves plain bytes for raw methods, with the same flow control
// as ServerStream. Read returns io.EOF once the opener finished sending
// (immediately for RAW_DOWNLOAD); Write fails for RAW_UPLOAD methods.
type RawStream interface {
	io.Reader
	io.Writer
}

// TypedStream is the typed view of a ServerStream that HandleStream gives
// handlers.
type TypedStream[Req, Resp proto.Message] struct {
	s ServerStream
}

// Send writes one response, blocking until there is credit for it.
func (t *TypedStream[Req, Resp]) Send(msg Resp) error { return t.s.Send(msg) }

// Recv reads the next request; io.EOF once the opener half-closed.
func (t *TypedStream[Req, Resp]) Recv() (Req, error) {
	msg := zero[Req]().ProtoReflect().New().Interface().(Req)
	if err := t.s.Recv(msg); err != nil {
		return zero[Req](), err
	}
	return msg, nil
}

// Raw returns the untyped stream, for code shared between methods.
func (t *TypedStream[Req, Resp]) Raw() ServerStream { return t.s }

// CallInfo describes the incoming call a handler is serving. Handlers read
// it with CallInfoFrom; the session (or the test harness) attaches it.
type CallInfo struct {
	// Method is the full wire name.
	Method string
	// Metadata from Call.metadata / Open.metadata, for example the acting
	// user for audit ("user_id") or a trace id. Never holds secrets.
	Metadata map[string]string
	// Deadline from the call, zero when none (ctx carries it too).
	Deadline time.Time
}

type callInfoKey struct{}

// WithCallInfo attaches info to ctx. Used by Session and rpctest.
func WithCallInfo(ctx context.Context, info *CallInfo) context.Context {
	return context.WithValue(ctx, callInfoKey{}, info)
}

// CallInfoFrom returns the incoming call's info, if ctx belongs to one.
func CallInfoFrom(ctx context.Context) (*CallInfo, bool) {
	info, ok := ctx.Value(callInfoKey{}).(*CallInfo)
	return info, ok
}

type outgoingKey struct{}

// WithMetadata adds metadata to calls made with the returned ctx through
// Peer.Call and Peer.Open. Keys are lower case; values must not be secrets.
func WithMetadata(ctx context.Context, md map[string]string) context.Context {
	merged := maps.Clone(OutgoingMetadata(ctx))
	if merged == nil {
		merged = map[string]string{}
	}
	maps.Copy(merged, md)
	return context.WithValue(ctx, outgoingKey{}, merged)
}

// OutgoingMetadata returns the metadata set with WithMetadata (nil when
// none). Peers read it when they build CALL and OPEN frames.
func OutgoingMetadata(ctx context.Context) map[string]string {
	md, _ := ctx.Value(outgoingKey{}).(map[string]string)
	return md
}
