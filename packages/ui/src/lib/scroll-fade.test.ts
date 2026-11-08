import { expect, test } from "bun:test";
import { scrollFadeEdges } from "./scroll-fade";

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
