// One stream on the agent connection (OPEN ... CLOSE), from the panel's
// side: credit-based flow control in both directions plus a queue of the
// bytes that arrived. Used for panel-opened streams (open/openRaw) and for
// streams the agent opens (RegistryTunnel). Message framing (size-delimited
// protobuf) sits on top in streams.ts; raw methods use the bytes directly.
//
// Flow control follows go/internal/conn (window.go): both directions start
// with Open.initial_window; the receiver returns credit only as the
// consumer reads, batched to half a window, so a slow consumer slows the
// peer instead of growing the panel's memory.

import { MAX_DATA_CHUNK } from "@seylo/proto";

/** How a stream ended on the agent's side, or why it failed locally. */
export type ChannelEnd = { ok: true; response: Uint8Array } | { ok: false; error: Error };

export interface ChannelIo {
  /** Queues DATA for the writer; resolves once handed over (the writer interleaves streams). */
  data(stream: number, bytes: Uint8Array): void;
  /** Sends a WINDOW frame. */
  window(stream: number, increment: number): void;
}

export class ProtocolViolation extends Error {
  override name = "ProtocolViolation";
}

const empty = new Uint8Array(0);

/** Largest send window a peer may give us, as in go/internal/conn (window.go maxWindow). */
export const maxWindow = 0x7fffffff;

export class Channel {
  /** Credit we hold for sending DATA to the agent. */
  private sendCredit: number;
  private creditWaiters: (() => void)[] = [];
  /** What the agent may still send us. */
  private peerCredit: number;
  private unacked = 0;
  /**
   * Bytes received and not read, at the start of one buffer that doubles as
   * it fills, not one object per DATA frame: the agent picks the frame
   * sizes, and a million 1-byte frames as a million objects hold about
   * 100 MiB. read() hands the buffer over and the next frame starts a new one.
   */
  private inbound: Uint8Array = empty;
  private inboundBytes = 0;
  private readWaiters: (() => void)[] = [];
  private endValue: ChannelEnd | null = null;
  private readonly endWaiters: ((end: ChannelEnd) => void)[] = [];
  /** We sent CLOSE (half-close or cancel); no more DATA from us. */
  sendClosed = false;
  /** The peer half-closed: it sends no more DATA, but we may still write. */
  private eof = false;

  constructor(
    readonly id: number,
    private readonly window: number,
    private readonly io: ChannelIo,
  ) {
    this.sendCredit = window;
    this.peerCredit = window;
  }

  get ended(): ChannelEnd | null {
    return this.endValue;
  }

  // ---- receiving ----

  /** A DATA frame arrived. Throws ProtocolViolation when the agent overran its credit. */
  receive(bytes: Uint8Array): void {
    if (this.endValue) return;
    if (bytes.length > this.peerCredit) throw new ProtocolViolation(`stream ${this.id} exceeded its flow-control window`);
    this.peerCredit -= bytes.length;
    if (bytes.length === 0) return;
    // The frame payload is a view into the socket buffer; this copies it.
    this.inbound = reserve(this.inbound, this.inboundBytes, this.inboundBytes + bytes.length);
    this.inbound.set(bytes, this.inboundBytes);
    this.inboundBytes += bytes.length;
    this.wakeReaders();
  }

  /**
   * Every byte received and not read yet (however many frames brought
   * them), or null once the stream ended and nothing is left. Rejects with
   * the end error after the queue drains.
   */
  async read(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.inboundBytes > 0) {
        const chunk = this.inbound.subarray(0, this.inboundBytes);
        this.inbound = empty;
        this.inboundBytes = 0;
        this.consumed(chunk.length);
        return chunk;
      }
      if (this.endValue) {
        if (this.endValue.ok) return null;
        throw this.endValue.error;
      }
      if (this.eof) return null;
      await new Promise<void>((wake) => this.readWaiters.push(wake));
    }
  }

  /** Bytes buffered and not read yet. */
  get buffered(): number {
    return this.inboundBytes;
  }

  private consumed(n: number): void {
    if (this.endValue) return;
    this.unacked += n;
    if (this.unacked === 0 || this.unacked < this.window / 2) return;
    const increment = this.unacked;
    this.unacked = 0;
    this.peerCredit += increment;
    this.io.window(this.id, increment);
  }

  private wakeReaders(): void {
    const waiters = this.readWaiters;
    this.readWaiters = [];
    for (const wake of waiters) wake();
  }

  // ---- sending ----

  /** The agent granted more credit. Throws ProtocolViolation past maxWindow, like the agent does. */
  grant(increment: number): void {
    if (increment <= 0 || this.sendCredit + increment > maxWindow) {
      throw new ProtocolViolation(`stream ${this.id} was granted a window over ${maxWindow} bytes`);
    }
    this.sendCredit += increment;
    const waiters = this.creditWaiters;
    this.creditWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Sends bytes as DATA, waiting for credit as needed. Rejects once the stream ended. */
  async write(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.endValue) throw this.endValue.ok ? new Error("stream already closed") : this.endValue.error;
      if (this.sendClosed) throw new Error("stream already half-closed");
      if (this.sendCredit <= 0) {
        await new Promise<void>((wake) => this.creditWaiters.push(wake));
        continue;
      }
      const n = Math.min(this.sendCredit, MAX_DATA_CHUNK, bytes.length - offset);
      this.sendCredit -= n;
      this.io.data(this.id, bytes.subarray(offset, offset + n));
      offset += n;
    }
  }

  // ---- end ----

  /** The peer half-closed (CLOSE with OK from the opener of an agent-opened stream). */
  endInbound(): void {
    this.eof = true;
    this.wakeReaders();
  }

  /** Ends the stream (agent CLOSE, cancel, timeout or connection loss). Only the first end counts. */
  finish(end: ChannelEnd): void {
    if (this.endValue) return;
    this.endValue = end;
    this.wakeReaders();
    const credit = this.creditWaiters;
    this.creditWaiters = [];
    for (const wake of credit) wake();
    for (const waiter of this.endWaiters.splice(0)) waiter(end);
  }

  whenEnded(): Promise<ChannelEnd> {
    if (this.endValue) return Promise.resolve(this.endValue);
    return new Promise((resolve) => this.endWaiters.push(resolve));
  }
}

/**
 * `buffer` with room for `size` bytes and its first `used` bytes kept: the
 * same buffer when it is large enough, else a new one at least twice as
 * large (and at least `floor`, at most `limit`). Filling a buffer this way
 * copies each byte about twice in all, and it is never larger than twice
 * what it holds or `floor`, whichever is more.
 */
function reserve(buffer: Uint8Array, used: number, size: number, floor = 0, limit = Number.POSITIVE_INFINITY): Uint8Array {
  if (size <= buffer.length) return buffer;
  const grown = new Uint8Array(Math.min(limit, Math.max(size, buffer.length * 2, floor)));
  grown.set(buffer.subarray(0, used));
  return grown;
}

/** First buffer for a message body split across chunks (messages up to this size get one allocation). */
const bodyFloor = 64 << 10;

/**
 * Incremental decoder for size-delimited protobuf messages (varint length,
 * then the message), which may span DATA frames. The sender picks the
 * frame sizes, so neither time nor memory may depend on them: the prefix is
 * read byte by byte into two numbers, and a body split across chunks is
 * collected in one buffer that doubles up to the announced length. A
 * message costs about twice its size at most while it is pending, in 1-byte
 * frames as in one, and each byte is copied about twice.
 */
export class DelimitedDecoder {
  /** Varint length prefix read so far. */
  private prefixValue = 0;
  private prefixBytes = 0;
  /** Body length of the message being collected once its prefix was read, else -1. */
  private need = -1;
  /** The first `filled` bytes of the body being collected. */
  private body: Uint8Array = empty;
  private filled = 0;

  push(bytes: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < bytes.length) {
      if (this.need < 0) {
        const byte = bytes[at] as number;
        at++;
        this.prefixValue += (byte & 0x7f) * 2 ** (7 * this.prefixBytes);
        this.prefixBytes++;
        if ((byte & 0x80) !== 0) {
          if (this.prefixBytes >= 5) throw new ProtocolViolation("bad message length prefix");
          continue;
        }
        if (this.prefixValue > maxMessageSize) throw new ProtocolViolation("stream message too large");
        this.need = this.prefixValue;
        this.prefixValue = 0;
        this.prefixBytes = 0;
        if (this.need === 0) {
          out.push(new Uint8Array(0));
          this.need = -1;
        }
        continue;
      }
      const count = Math.min(this.need - this.filled, bytes.length - at);
      if (this.filled === 0 && count === this.need) {
        // The whole body is in this chunk: one copy, no buffer.
        out.push(bytes.slice(at, at + count));
        this.need = -1;
      } else {
        this.body = reserve(this.body, this.filled, this.filled + count, bodyFloor, this.need);
        this.body.set(bytes.subarray(at, at + count), this.filled);
        this.filled += count;
        if (this.filled === this.need) {
          out.push(this.body.length === this.need ? this.body : this.body.slice(0, this.need));
          this.body = empty;
          this.filled = 0;
          this.need = -1;
        }
      }
      at += count;
    }
    return out;
  }

  /** True when a partial message is left over. */
  get pending(): boolean {
    return this.prefixBytes > 0 || this.need >= 0;
  }

  /** Bytes this decoder holds for the message it is collecting (its buffer's size). */
  get held(): number {
    return this.body.length;
  }
}

/** Largest message we accept on a stream (matches the frame limit). */
const maxMessageSize = 16 << 20;

export function encodeDelimited(message: Uint8Array): Uint8Array {
  const prefix: number[] = [];
  let n = message.length;
  while (n >= 0x80) {
    prefix.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  prefix.push(n);
  const out = new Uint8Array(prefix.length + message.length);
  out.set(prefix);
  out.set(message, prefix.length);
  return out;
}
