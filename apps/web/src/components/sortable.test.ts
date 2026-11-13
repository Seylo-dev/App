import { expect, test } from "bun:test";
import { cancelPendingDrag, droppedOrder, isDragging, isDropClick, noteDragStart, pointerReleased } from "./sortable";

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

const a = { id: "a" };
const b = { id: "b" };
const c = { id: "c" };

test("a drop's order shows while the list is still the one it was made on", () => {
  expect(droppedOrder([a, b, c], { on: "a\nb\nc", ids: ["b", "a", "c"] })).toEqual([b, a, c]);
});

test("once the list has another order, that order shows", () => {
  // Patched to the dropped order, or changed some other way meanwhile.
  expect(droppedOrder([b, a, c], { on: "a\nb\nc", ids: ["b", "a", "c"] })).toEqual([b, a, c]);
  expect(droppedOrder([a, c, b], { on: "a\nb\nc", ids: ["b", "a", "c"] })).toEqual([a, c, b]);
  expect(droppedOrder([a, b, c], null)).toEqual([a, b, c]);
});

test("a drag is on from its start until the pointer lets go, even when dnd-kit never says it ended", () => {
  expect(isDragging()).toBe(false);
  noteDragStart();
  expect(isDragging()).toBe(true);
  // A touch swipe the browser took over for a scroll: pointercancel, and no onDragCancel from dnd-kit.
  pointerReleased(5000);
  expect(isDragging()).toBe(false);
  // Letting go again changes nothing.
  pointerReleased(9000);
  expect(isDragging()).toBe(false);
});

test("cancelPendingDrag sends the pointercancel dnd-kit's waiting sensor listens for", () => {
  const target = new EventTarget();
  const seen: string[] = [];
  target.addEventListener("pointercancel", (event) => seen.push(event.type));
  cancelPendingDrag(target);
  expect(seen).toEqual(["pointercancel"]);
});
