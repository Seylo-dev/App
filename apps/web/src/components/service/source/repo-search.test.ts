import { expect, test } from "bun:test";
import { scrollToShow } from "./repo-search";

// A 256px list (max-h-64) of 36px rows.
const list = { scrollTop: 0, height: 256 };

test("a selected row already in view leaves the list where it is", () => {
  expect(scrollToShow({ top: 0, height: 36 }, list)).toBeNull();
  expect(scrollToShow({ top: 220, height: 36 }, list)).toBeNull();
  expect(scrollToShow({ top: 400, height: 36 }, { scrollTop: 300, height: 256 })).toBeNull();
});

test("a row below or above the view is scrolled to the middle of the list", () => {
  // Row 11 (top 396): centered, (256 - 36) / 2 = 110 above it.
  expect(scrollToShow({ top: 396, height: 36 }, list)).toBe(286);
  // Cut off at the bottom by a few pixels counts as out of view.
  expect(scrollToShow({ top: 230, height: 36 }, list)).toBe(120);
  // Above the view: never past the top.
  expect(scrollToShow({ top: 40, height: 36 }, { scrollTop: 300, height: 256 })).toBe(0);
});
