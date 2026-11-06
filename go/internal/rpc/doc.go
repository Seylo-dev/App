// Package rpc runs AgentService and PanelService calls over a conn
// connection: it encodes Call/Result/Open/Close envelopes, dispatches
// incoming calls to handlers, multiplexes streams with flow control and
// maps errors to wire status codes.
//
// The protocol is not gRPC. Method shapes come from the proto service
// definitions (unary, streaming, or raw per the stream_mode option, see
// MethodStreamMode); the frame mapping is documented in envelope.proto.
//
// Interfaces used by other packages:
//
//   - Mux with HandleUnary, HandleStream and HandleRaw: the handler
//     registry (agent.Registry is a Mux for AgentService). Handlers get a
//     ctx with CallInfo, a TypedStream or RawStream for streams, and return
//     an *Error to choose the status code.
//   - Peer: the other end of the connection; Stream: one open call.
//   - Session: one connection's calls in both directions. Link: a Peer and
//     Emitter that follows the current Session across reconnects.
//   - PanelClient: typed calls to PanelService.
//   - Emitter: best-effort events. Durable reports use state.Reporter.
//   - Error and StatusOf: how handlers signal a status code, and how any Go
//     error becomes a wire Status.
//   - AgentHandshake / PanelHandshake, HelloSignedBytes: the stream 0
//     handshake (handshake.proto) for the agent and for fake Go panels.
//   - rpctest: in-process harness that calls handlers without a network.
//
// Session details: incoming calls run each on their own goroutine with a
// ctx carrying the call's deadline and CallInfo, cancelled by the peer's
// CLOSE or the end of the connection; handler panics become INTERNAL and
// are counted (Stats). Outgoing calls check the peer's capabilities
// first. Streams use per-stream credit windows (conn.SendWindow and
// RecvWindow) and the shared control-first conn.Writer.
package rpc
