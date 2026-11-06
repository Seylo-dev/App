// Collects terminal output and hands it on once per animation frame, as one
// joined chunk. While paused it keeps collecting (up to a cap, dropping the
// oldest output) and writes everything on resume.

type Chunk = Uint8Array | string;
type Schedule = (fn: () => void) => () => void;

const frame: Schedule =
  typeof requestAnimationFrame === "function"
    ? (fn) => {
        const id = requestAnimationFrame(() => fn());
        return () => cancelAnimationFrame(id);
      }
    : (fn) => {
        const id = setTimeout(fn, 16);
        return () => clearTimeout(id);
      };

const encoder = new TextEncoder();

export class WriteBatcher {
  private queue: Uint8Array[] = [];
  private bytes = 0;
  private cancel: (() => void) | null = null;
  private paused = false;
  /** Output kept while paused; older output is dropped past this. */
  readonly maxHeldBytes: number;
  private readonly schedule: Schedule;

  constructor(
    private readonly sink: (chunk: Uint8Array) => void,
    options: { schedule?: Schedule; maxHeldBytes?: number } = {},
  ) {
    this.schedule = options.schedule ?? frame;
    this.maxHeldBytes = options.maxHeldBytes ?? 8 * 1024 * 1024;
  }

  push(chunk: Chunk): void {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    if (bytes.length === 0) return;
    this.queue.push(bytes);
    this.bytes += bytes.length;
    while (this.paused && this.bytes > this.maxHeldBytes && this.queue.length > 1) {
      this.bytes -= this.queue.shift()?.length ?? 0;
    }
    if (!this.paused) this.arm();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused && this.queue.length) this.arm();
  }

  /** Forget queued output (for Clear). */
  drop(): void {
    this.queue = [];
    this.bytes = 0;
  }

  dispose(): void {
    this.cancel?.();
    this.cancel = null;
    this.drop();
  }

  private arm(): void {
    if (this.cancel) return;
    this.cancel = this.schedule(() => {
      this.cancel = null;
      this.flush();
    });
  }

  private flush(): void {
    if (this.paused || this.queue.length === 0) return;
    const out = new Uint8Array(this.bytes);
    let at = 0;
    for (const part of this.queue) {
      out.set(part, at);
      at += part.length;
    }
    this.queue = [];
    this.bytes = 0;
    this.sink(out);
  }
}
