import { describe, expect, test } from "bun:test";
import { freshLines, nextSeq } from "./deploy-log";

describe("freshLines", () => {
  test("drops lines a page already delivered", () => {
    const { fresh, gap } = freshLines(4, [{ seq: 3 }, { seq: 4 }, { seq: 5 }, { seq: 6 }]);
    expect(fresh.map((l) => l.seq)).toEqual([5, 6]);
    expect(gap).toBe(false);
  });

  test("a jump past the next seq is a gap", () => {
    expect(freshLines(4, [{ seq: 7 }]).gap).toBe(true);
    expect(freshLines(-1, [{ seq: 0 }]).gap).toBe(false);
  });

  test("sorts out-of-order lines and ignores an all-old event", () => {
    expect(freshLines(0, [{ seq: 2 }, { seq: 1 }]).fresh.map((l) => l.seq)).toEqual([1, 2]);
    expect(freshLines(9, [{ seq: 3 }])).toEqual({ fresh: [], gap: false });
  });
});

test("nextSeq keeps the old seq on an empty page", () => {
  expect(nextSeq(5, [])).toBe(5);
  expect(nextSeq(5, [{ seq: 9 }, { seq: 7 }])).toBe(9);
});
