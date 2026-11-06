// Package conn is the byte-level layer of the agent <-> panel connection:
// framing, stream ids, credit-based flow control, the control-first writer
// and the WebSocket transport. It knows nothing about protobuf messages or
// methods; package rpc builds calls and streams on top of it.
//
// # Frames
//
// Every binary WebSocket message is one frame:
//
//	[kind: 1 byte][stream: uint32 big endian][payload]
//
// Kind values are the FrameKind enum of proto/seylo/agent/v1/envelope.proto
// (a test keeps them equal). Stream 0 is the connection itself; the dialer
// (agent) allocates odd stream ids and the acceptor (panel) even ones, so
// both sides can open streams without coordinating.
//
// # Flow control
//
// DATA payload bytes are flow controlled per stream. The receiver grants
// credit (the initial window from Open, then WINDOW frames) and the sender
// never sends more DATA than it holds credit for. SendWindow and RecvWindow
// implement both halves. Control frames are never flow controlled.
//
// # Control first
//
// Writer serializes all writes to the transport. Control frames always go
// before queued DATA, and DATA is interleaved round-robin across streams in
// chunks of at most MaxDataChunk bytes, so a 2 GB upload never delays a
// deploy call or another stream's terminal output.
//
// # Interfaces used by other packages
//
//   - Transport: what rpc reads frames from and writes them to.
//   - Writer: the single writer every stream shares.
//   - SendWindow, RecvWindow: per-stream credit accounting.
//   - StreamIDs: stream id allocation for one side of a connection.
package conn
