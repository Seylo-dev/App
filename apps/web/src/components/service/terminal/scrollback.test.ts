import { expect, test } from "bun:test";
import { TERMINAL_SCROLLBACK, xtermBufferBytes } from "./scrollback";

test("a full terminal scrollback stays small at a wide window", () => {
  // The read-only Console kept 100,000 lines: 180 MB at 150 columns in every tab with a console open.
  expect(xtermBufferBytes(100_000, 150)).toBe(180_000_000);
  expect(xtermBufferBytes(TERMINAL_SCROLLBACK, 200)).toBeLessThanOrEqual(25_000_000);
});

test("the Console and Shell tabs keep that scrollback (no larger one of their own)", async () => {
  const panel = await Bun.file(new URL("./terminal-panel.tsx", import.meta.url)).text();
  expect(panel).not.toContain("scrollback=");
});
