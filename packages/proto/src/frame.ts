// Frame codec for the agent <-> panel WebSocket. Mirrors go/internal/conn;
// both are checked against go/internal/conn/testdata/frames.json.
//
//   [kind: 1 byte][stream: uint32 big endian][payload]
//
// See proto/seylo/agent/v1/envelope.proto for what each kind carries.

import { FrameKind } from "./gen/seylo/agent/v1/envelope_pb";

export const HEADER_SIZE = 5;

/** Largest whole frame either side accepts. */
export const MAX_FRAME_SIZE = 16 << 20;

/** Largest DATA payload a writer sends at once, so streams interleave. */
export const MAX_DATA_CHUNK = 32 << 10;

/** Stream 0 carries the handshake and events. */
export const CONNECTION_STREAM = 0;

export interface Frame {
  kind: FrameKind;
  stream: number;
  payload: Uint8Array;
}

/** Thrown when a peer sends bytes that are not a valid frame. */
export class FrameError extends Error {
  override name = "FrameError";
}

export function isValidKind(kind: number): kind is FrameKind {
  return kind >= FrameKind.CALL && kind <= FrameKind.CLOSE;
}

/** True for every kind except DATA: control frames skip flow control. */
export function isControl(kind: FrameKind): boolean {
  return kind !== FrameKind.DATA;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + frame.payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, frame.kind);
  view.setUint32(1, frame.stream >>> 0, false);
  out.set(frame.payload, HEADER_SIZE);
  return out;
}

/** Decodes one frame. The payload is a view into `bytes`, not a copy. */
export function parseFrame(bytes: Uint8Array): Frame {
  if (bytes.length < HEADER_SIZE) {
    throw new FrameError("frame shorter than its header");
  }
  if (bytes.length > MAX_FRAME_SIZE) {
    throw new FrameError("frame exceeds MAX_FRAME_SIZE");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint8(0);
  if (!isValidKind(kind)) {
    throw new FrameError(`unknown frame kind ${kind}`);
  }
  return {
    kind,
    stream: view.getUint32(1, false),
    payload: bytes.subarray(HEADER_SIZE),
  };
}

/** Builds a WINDOW frame granting `increment` bytes of send credit. */
export function windowFrame(stream: number, increment: number): Frame {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, increment >>> 0, false);
  return { kind: FrameKind.WINDOW, stream, payload };
}

export function parseWindow(payload: Uint8Array): number {
  if (payload.length !== 4) {
    throw new FrameError("WINDOW payload must be 4 bytes");
  }
  const increment = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
  if (increment === 0) {
    throw new FrameError("WINDOW increment must be non-zero");
  }
  return increment;
}
