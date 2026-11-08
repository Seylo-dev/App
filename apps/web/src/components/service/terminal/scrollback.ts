// How much history the xterm views (Console, Shell, node and database
// shells) keep. xterm 6 stores every buffer line as a Uint32Array of 3
// entries per column (BufferLine.ts: CELL_SIZE = 3), however short its text,
// so a full scrollback costs lines * columns * 12 bytes in each open tab:
// 100,000 lines at 150 columns would be 180 MB. The Logs tab keeps long
// history as plain strings and searches it; the terminals keep 10,000 lines
// (18 MB at 150 columns).

export const TERMINAL_SCROLLBACK = 10_000;

/** Bytes of xterm cell data for `lines` filled lines `cols` wide. */
export function xtermBufferBytes(lines: number, cols: number): number {
  return lines * cols * 3 * Uint32Array.BYTES_PER_ELEMENT;
}
