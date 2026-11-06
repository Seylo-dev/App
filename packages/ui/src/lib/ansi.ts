// ANSI escape parsing for log lines. Handles SGR (colors, bold, dim,
// italic, underline; 16, 256 and true color); every other escape sequence
// (cursor moves, OSC titles, ...) is dropped so it never shows as garbage.
// The 16 basic colors are CSS variables (--ansi-0 .. --ansi-15 in
// theme.css), so themes can restyle them; 256 and true colors are data and
// come out as rgb().

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface AnsiSegment extends AnsiStyle {
  text: string;
}

// CSI (ESC [ ... final byte), OSC (ESC ] ... BEL or ESC \), and two-byte escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point.
const ESCAPE = /\x1b\[([0-9;:?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function basic(n: number): string {
  return `var(--ansi-${n})`;
}

function xterm256(n: number): string {
  if (n < 16) return basic(n);
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

function applySgr(params: string, style: AnsiStyle): AnsiStyle {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  const next: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i] as number;
    if (c === 0) {
      for (const k of Object.keys(next)) delete next[k as keyof AnsiStyle];
    } else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 3) next.italic = true;
    else if (c === 4) next.underline = true;
    else if (c === 22) {
      next.bold = undefined;
      next.dim = undefined;
    } else if (c === 23) next.italic = undefined;
    else if (c === 24) next.underline = undefined;
    else if (c >= 30 && c <= 37) next.fg = basic(c - 30);
    else if (c >= 90 && c <= 97) next.fg = basic(c - 90 + 8);
    else if (c === 39) next.fg = undefined;
    else if (c >= 40 && c <= 47) next.bg = basic(c - 40);
    else if (c >= 100 && c <= 107) next.bg = basic(c - 100 + 8);
    else if (c === 49) next.bg = undefined;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        next[key] = xterm256(codes[i + 2] as number);
        i += 2;
      } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
        next[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
  for (const k of Object.keys(next) as (keyof AnsiStyle)[]) if (next[k] === undefined) delete next[k];
  return next;
}

/** Splits a line into styled segments. Plain lines come back as one segment. */
export function parseAnsi(line: string): AnsiSegment[] {
  if (!line.includes("\x1b")) return [{ text: line }];
  const out: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  ESCAPE.lastIndex = 0;
  for (let m = ESCAPE.exec(line); m !== null; m = ESCAPE.exec(line)) {
    if (m.index > last) out.push({ ...style, text: line.slice(last, m.index) });
    if (m[2] === "m") style = applySgr(m[1] ?? "", style);
    last = ESCAPE.lastIndex;
  }
  if (last < line.length) out.push({ ...style, text: line.slice(last) });
  return out.length ? out : [{ text: "" }];
}

/** The line without any escape sequences (for search and copy). */
export function stripAnsi(line: string): string {
  return line.includes("\x1b") ? line.replace(ESCAPE, "") : line;
}

export interface HighlightedSegment extends AnsiSegment {
  match?: boolean;
}

/**
 * Splits segments again where `query` matches (case-insensitive), marking
 * the matching pieces. Matches may span segment boundaries.
 */
export function highlight(segments: readonly AnsiSegment[], query: string): HighlightedSegment[] {
  if (!query) return segments as HighlightedSegment[];
  const plain = segments.map((s) => s.text).join("");
  const hay = plain.toLowerCase();
  const needle = query.toLowerCase();
  const ranges: [number, number][] = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length]);
  if (!ranges.length) return segments as HighlightedSegment[];

  const out: HighlightedSegment[] = [];
  let pos = 0;
  let r = 0;
  for (const seg of segments) {
    const end = pos + seg.text.length;
    let cur = pos;
    while (cur < end) {
      while (r < ranges.length && (ranges[r] as [number, number])[1] <= cur) r++;
      const range = ranges[r];
      if (!range || range[0] >= end) {
        out.push({ ...seg, text: plain.slice(cur, end) });
        cur = end;
      } else if (range[0] > cur) {
        out.push({ ...seg, text: plain.slice(cur, range[0]) });
        cur = range[0];
      } else {
        const stop = Math.min(range[1], end);
        out.push({ ...seg, text: plain.slice(cur, stop), match: true });
        cur = stop;
      }
    }
    pos = end;
  }
  return out;
}
