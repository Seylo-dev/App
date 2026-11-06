// The single writer of one agent connection. Control frames (everything
// but DATA) go out at once; DATA waits in per-stream queues that are
// drained round-robin while the socket has room, so a large upload never
// delays a deploy call or another stream's terminal output. Mirrors
// go/internal/conn/writer.go.

import { encodeFrame, type Frame, FrameKind } from "@seylo/proto";

export interface WriterSocket {
  send(bytes: Uint8Array): void;
  /** Bytes the socket has queued but not sent. Without it DATA is written at once. */
  bufferedAmount?(): number;
}

/** Stop handing DATA to the socket above this many queued bytes; resume on drain. */
const highWater = 1 << 20;

/** A DATA payload, or a frame that must follow the stream's queued DATA (its CLOSE). */
type Item = { data: Uint8Array } | { frame: Frame };

export class FrameWriter {
  private readonly queues = new Map<number, Item[]>();
  private order: number[] = [];
  private closed = false;

  constructor(private readonly socket: WriterSocket) {}

  control(frame: Frame): void {
    if (this.closed) return;
    this.socket.send(encodeFrame(frame));
  }

  data(stream: number, payload: Uint8Array): void {
    // Copy: callers may reuse their buffer after write resolves.
    this.enqueue(stream, { data: payload.slice() });
  }

  /**
   * Sends a control frame of `stream` after the DATA already queued for it,
   * so a half-close or final CLOSE never overtakes the stream's last bytes.
   */
  afterData(stream: number, frame: Frame): void {
    if (!this.queues.has(stream)) this.control(frame);
    else this.enqueue(stream, { frame });
  }

  /** Drops queued DATA of a stream that ended. */
  forget(stream: number): void {
    if (this.queues.delete(stream)) this.order = this.order.filter((s) => s !== stream);
  }

  /** The socket drained; write more. */
  drained(): void {
    this.pump();
  }

  close(): void {
    this.closed = true;
    this.queues.clear();
    this.order = [];
  }

  private enqueue(stream: number, item: Item): void {
    if (this.closed) return;
    let queue = this.queues.get(stream);
    if (!queue) {
      queue = [];
      this.queues.set(stream, queue);
      this.order.push(stream);
    }
    queue.push(item);
    this.pump();
  }

  private pump(): void {
    while (this.order.length > 0) {
      if ((this.socket.bufferedAmount?.() ?? 0) > highWater) return;
      const stream = this.order.shift() as number;
      const queue = this.queues.get(stream);
      const item = queue?.shift();
      if (!queue || !item) {
        this.queues.delete(stream);
        continue;
      }
      if (queue.length > 0) this.order.push(stream);
      else this.queues.delete(stream);
      if ("data" in item) this.socket.send(encodeFrame({ kind: FrameKind.DATA, stream, payload: item.data }));
      else this.socket.send(encodeFrame(item.frame));
    }
  }
}
