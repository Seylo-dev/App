// Maps string offsets to 1-based lines and columns.

import type { SourceRange } from "./types";

export class LineIndex {
  /** Offset where each line starts; lineStarts[0] is 0. */
  private readonly lineStarts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** 1-based line and column of an offset (clamped to the text). */
  position(offset: number): { line: number; column: number } {
    const at = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= at) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: at - (this.lineStarts[lo] ?? 0) + 1 };
  }

  /** Offset of a 1-based line and column. */
  offset(line: number, column: number): number {
    const start = this.lineStarts[Math.max(0, Math.min(line - 1, this.lineStarts.length - 1))] ?? 0;
    return Math.min(start + column - 1, this.text.length);
  }

  range(start: number, end: number): SourceRange {
    const from = this.position(start);
    const to = this.position(end);
    return { start, end, startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column };
  }
}

/** True when offset falls inside the range (end exclusive, but a zero-width range contains its start). */
export function rangeContains(range: SourceRange, offset: number): boolean {
  return offset >= range.start && (offset < range.end || (range.start === range.end && offset === range.start));
}
