import { expect, test } from "bun:test";
import { revealDelta, scrollFadeEdges } from "./scroll-fade";

test("a row that fits fades nothing", () => {
  expect(scrollFadeEdges({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 })).toEqual({ start: false, end: false });
  // Subpixel widths round a pixel either way.
  expect(scrollFadeEdges({ scrollLeft: 0, clientWidth: 400, scrollWidth: 401 })).toEqual({ start: false, end: false });
});

test("a row with hidden items fades the edges that hide them", () => {
  const row = { clientWidth: 358, scrollWidth: 874 };
  expect(scrollFadeEdges({ ...row, scrollLeft: 0 })).toEqual({ start: false, end: true });
  expect(scrollFadeEdges({ ...row, scrollLeft: 200 })).toEqual({ start: true, end: true });
  expect(scrollFadeEdges({ ...row, scrollLeft: 516 })).toEqual({ start: true, end: false });
  // Right to left: scrollLeft runs from 0 down.
  expect(scrollFadeEdges({ ...row, scrollLeft: -516 })).toEqual({ start: true, end: false });
});

test("the current item is scrolled clear of the faded edges", () => {
  const row = { left: 16, right: 374 };
  // Inside, with room on both sides: nothing moves.
  expect(revealDelta(row, { left: 120, right: 200 })).toBe(0);
  // Past the end: scroll forward until its right edge is 32px inside.
  expect(revealDelta(row, { left: 400, right: 470 })).toBe(470 - 374 + 32);
  // Before the start: scroll back.
  expect(revealDelta(row, { left: -60, right: 10 })).toBe(-60 - 16 - 32);
  // Under the end fade counts as hidden.
  expect(revealDelta(row, { left: 300, right: 360 })).toBe(360 - 374 + 32);
});
