// The single writer of one agent connection. Control frames (everything
// but DATA) go out at once; DATA waits in per-stream queues that are
// drained round-robin while the socket has room, so a large upload never
// delays a deploy call or another stream's terminal output. Mirrors
// go/internal/conn/writer.go.
//
// Bun drops a message once a socket buffers more than its backpressure
// limit (send returns 0) and keeps the socket open. A dropped CALL, WINDOW,
// CLOSE or RESULT would leave that node's session silently wrong, so the
// first drop closes the writer and tells the session, which closes the
// connection: the agent reconnects and both sides resync.

import { encodeFrame, type Frame, FrameKind } from "@seylo/proto";

export interface WriterSocket {
  /** Bun's send status: bytes sent, -1 queued under backpressure, 0 dropped. */
  send(bytes: Uint8Array): number;
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

  constructor(
    private readonly socket: WriterSocket,
    /** The socket dropped a frame; called once, after which nothing more is written. */
    private readonly onDropped: () => void = () => {},
  ) {}

  control(frame: Frame): void {
    if (this.closed) return;
    this.write(encodeFrame(frame));
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
      if ("data" in item) this.write(encodeFrame({ kind: FrameKind.DATA, stream, payload: item.data }));
      else this.write(encodeFrame(item.frame));
      if (this.closed) return;
    }
  }

  private write(bytes: Uint8Array): void {
    if (this.socket.send(bytes) !== 0) return;
    this.close();
    this.onDropped();
  }
}
