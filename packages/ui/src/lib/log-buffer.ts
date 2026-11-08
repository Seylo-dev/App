// A fixed-size ring of log lines that lives outside React. Producers push
// as fast as lines arrive (a WebSocket handler, a replay); subscribers hear
// about it at most once per animation frame, so a burst of 10,000 lines is
// one render, not 10,000.

import { type AnsiSegment, parseAnsi, stripAnsi } from "./ansi";

export type LogLevel = "info" | "warn" | "error" | "system";

export interface LogLineInput {
  text: string;
  /** Epoch milliseconds. */
  ts?: number;
  /** A short source tag shown before the text: "stdout", "build", a replica id. */
  source?: string;
  level?: LogLevel;
}

export interface LogLine extends LogLineInput {
  /** Position since the buffer was created; stays the same while the line is kept. */
  seq: number;
  /** The text without escape sequences, for search and copy. */
  plain: string;
}

type Schedule = (fn: () => void) => void;

const defaultSchedule: Schedule =
  typeof requestAnimationFrame === "function" ? (fn) => requestAnimationFrame(() => fn()) : (fn) => setTimeout(fn, 16);

export class LogBuffer {
  readonly capacity: number;
  private readonly ring: (LogLine | undefined)[];
  private head = 0; // index of the oldest line
  private count = 0;
  private nextSeq = 0;
  private parsed = new Map<number, AnsiSegment[]>();
  private listeners = new Set<() => void>();
  /**
   * The last search: the seqs of its matches (from `start` on; earlier ones
   * fell off the ring) and the seq it read up to. The viewer searches again
   * on every frame while lines stream in, so a repeated query only reads the
   * lines added since instead of the whole ring.
   */
  private found: { query: string; seqs: number[]; start: number; scanned: number } | null = null;
  private scheduled = false;
  private readonly schedule: Schedule;
  /** Bumps on every change; cheap to compare in a render. */
  version = 0;

  constructor(capacity = 10_000, schedule: Schedule = defaultSchedule) {
    if (capacity < 1) throw new Error("LogBuffer capacity must be at least 1");
    this.capacity = capacity;
    this.ring = new Array(capacity);
    this.schedule = schedule;
  }

  get length(): number {
    return this.count;
  }

  /** seq of the oldest kept line (lines before it were dropped). */
  get firstSeq(): number {
    return this.nextSeq - this.count;
  }

  /** Adds one line (a string, or a line with metadata). Text with newlines becomes several lines. */
  push(line: string | LogLineInput): void {
    const input = typeof line === "string" ? { text: line } : line;
    const parts = input.text.includes("\n") ? input.text.replace(/\r?\n$/, "").split(/\r?\n/) : [input.text];
    for (const text of parts) this.append({ ...input, text: text.replace(/\r$/, "") });
    this.notify();
  }

  pushMany(lines: Iterable<string | LogLineInput>): void {
    for (const l of lines) {
      const input = typeof l === "string" ? { text: l } : l;
      const parts = input.text.includes("\n") ? input.text.replace(/\r?\n$/, "").split(/\r?\n/) : [input.text];
      for (const text of parts) this.append({ ...input, text: text.replace(/\r$/, "") });
    }
    this.notify();
  }

  clear(): void {
    this.ring.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.parsed.clear();
    this.found = null;
    this.notify();
  }

  /** The i-th kept line, 0 = oldest. */
  at(i: number): LogLine | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return this.ring[(this.head + i) % this.capacity];
  }

  /** Styled segments of a kept line, parsed once and cached. */
  segments(line: LogLine): AnsiSegment[] {
    let s = this.parsed.get(line.seq);
    if (!s) {
      s = parseAnsi(line.text);
      this.parsed.set(line.seq, s);
    }
    return s;
  }

  /** All kept lines, oldest first. */
  toArray(): LogLine[] {
    const out: LogLine[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.at(i) as LogLine);
    return out;
  }

  /**
   * Indexes (0 = oldest) of the lines whose plain text contains query,
   * case-insensitive. Incremental: the same query again reads only the lines
   * added since the last call, and a longer one (typing on) only re-checks
   * the previous matches; any other query reads every kept line once.
   */
  search(query: string): number[] {
    if (!query) return [];
    const q = query.toLowerCase();
    const first = this.firstSeq;
    const prev = this.found;
    let seqs: number[];
    let start = 0;
    let from = first;
    if (prev && prev.query === q) {
      seqs = prev.seqs;
      start = prev.start;
      from = Math.max(prev.scanned, first);
    } else if (prev && q.includes(prev.query)) {
      // Every line that contains q contains the previous query too.
      seqs = [];
      for (let k = prev.start; k < prev.seqs.length; k++) {
        const seq = prev.seqs[k] as number;
        if (seq >= first && this.matches(seq, q)) seqs.push(seq);
      }
      from = Math.max(prev.scanned, first);
    } else {
      seqs = [];
    }
    while (start < seqs.length && (seqs[start] as number) < first) start++;
    for (let seq = from; seq < this.nextSeq; seq++) if (this.matches(seq, q)) seqs.push(seq);
    // Drop the matches that fell off the ring once they are most of the array.
    if (start > 1024 && start * 2 > seqs.length) {
      seqs = seqs.slice(start);
      start = 0;
    }
    this.found = { query: q, seqs, start, scanned: this.nextSeq };
    const out = new Array<number>(seqs.length - start);
    for (let k = start; k < seqs.length; k++) out[k - start] = (seqs[k] as number) - first;
    return out;
  }

  private matches(seq: number, q: string): boolean {
    const line = this.at(seq - this.firstSeq);
    return !!line?.plain.toLowerCase().includes(q);
  }

  /** Calls fn at most once per frame after changes. Returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private append(input: LogLineInput): void {
    const line: LogLine = { ...input, seq: this.nextSeq++, plain: stripAnsi(input.text) };
    if (this.count < this.capacity) {
      this.ring[(this.head + this.count) % this.capacity] = line;
      this.count++;
    } else {
      const dropped = this.ring[this.head];
      if (dropped) this.parsed.delete(dropped.seq);
      this.ring[this.head] = line;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  private notify(): void {
    this.version++;
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      for (const fn of this.listeners) fn();
    });
  }
}

/** The rows to render for a scroll position: [start, end) with overscan. */
export function visibleRange(opts: {
  scrollTop: number;
  viewport: number;
  rowHeight: number;
  count: number;
  overscan?: number;
}): [number, number] {
  const overscan = opts.overscan ?? 10;
  const start = Math.max(0, Math.floor(opts.scrollTop / opts.rowHeight) - overscan);
  const end = Math.min(opts.count, Math.ceil((opts.scrollTop + opts.viewport) / opts.rowHeight) + overscan);
  return [start, Math.max(start, end)];
}
