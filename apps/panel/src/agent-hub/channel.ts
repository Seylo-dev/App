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

/** Largest send window a peer may give us, as in go/internal/conn (window.go maxWindow). */
export const maxWindow = 0x7fffffff;

export class Channel {
  /** Credit we hold for sending DATA to the agent. */
  private sendCredit: number;
  private creditWaiters: (() => void)[] = [];
  /** What the agent may still send us. */
  private peerCredit: number;
  private unacked = 0;
  private readonly inbound: Uint8Array[] = [];
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
    // The frame payload is a view into the socket buffer; keep a copy.
    this.inbound.push(bytes.slice());
    this.wakeReaders();
  }

  /**
   * Next chunk of received bytes, or null once the stream ended and the
   * queue is empty. Rejects with the end error after the queue drains.
   */
  async read(): Promise<Uint8Array | null> {
    for (;;) {
      const chunk = this.inbound.shift();
      if (chunk) {
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
    let n = 0;
    for (const chunk of this.inbound) n += chunk.length;
    return n;
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
 * Incremental decoder for size-delimited protobuf messages (varint length,
 * then the message), which may span DATA frames.
 */
export class DelimitedDecoder {
  private buffer = new Uint8Array(0);

  push(bytes: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer);
    merged.set(bytes, this.buffer.length);
    const out: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const header = readVarint(merged, offset);
      if (!header) break;
      const end = header.next + header.value;
      if (end > merged.length) break;
      out.push(merged.slice(header.next, end));
      offset = end;
    }
    this.buffer = merged.slice(offset);
    return out;
  }

  /** True when a partial message is left over. */
  get pending(): boolean {
    return this.buffer.length > 0;
  }
}

/** Largest message we accept on a stream (matches the frame limit). */
const maxMessageSize = 16 << 20;

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = offset; i < bytes.length && i < offset + 5; i++) {
    const byte = bytes[i] as number;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (value > maxMessageSize) throw new ProtocolViolation("stream message too large");
      return { value, next: i + 1 };
    }
    shift += 7;
  }
  if (bytes.length - offset >= 5) throw new ProtocolViolation("bad message length prefix");
  return null;
}

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
