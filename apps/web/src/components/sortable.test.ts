import { expect, test } from "bun:test";
import { isDropClick } from "./sortable";

test("the click right after a drop is swallowed, later ones are not", () => {
  expect(isDropClick(1, 1100, 1000)).toBe(true);
  expect(isDropClick(1, 1300, 1000)).toBe(false);
});

test("Enter in a form still submits right after a drop (its click has detail 0)", () => {
  expect(isDropClick(0, 1050, 1000)).toBe(false);
});

test("nothing is swallowed in a page's first 250 ms when no drag ever ended", () => {
  // performance.now() starts at 0 on page load: with the last drag end at 0, Enter in the e2e console sent nothing.
  expect(isDropClick(1, 120, Number.NEGATIVE_INFINITY)).toBe(false);
});
