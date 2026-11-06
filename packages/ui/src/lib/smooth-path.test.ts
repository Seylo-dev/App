import { describe, expect, test } from "bun:test";
import { niceDomain, smoothAreaPath, smoothPath, toSegments } from "./smooth-path";

describe("smoothPath", () => {
  test("matches design/smoothpath.py for the same points", () => {
    // python3 -I design/smoothpath.py "0,60 40,52 80,58 120,30"
    expect(
      smoothPath([
        [0, 60],
        [40, 52],
        [80, 58],
        [120, 30],
      ]),
    ).toBe("M0,60 C6.7,58.7 26.7,52.3 40,52 C53.3,51.7 66.7,61.7 80,58 C93.3,54.3 113.3,34.7 120,30");
  });

  test("handles 0 and 1 points", () => {
    expect(smoothPath([])).toBe("");
    expect(smoothPath([[5, 5]])).toBe("M5,5");
  });

  test("area closes to the baseline", () => {
    expect(
      smoothAreaPath(
        [
          [0, 10],
          [100, 20],
        ],
        100,
      ),
    ).toEndWith("L100,100 L0,100 Z");
  });
});

describe("toSegments", () => {
  test("maps values into the box and splits at gaps", () => {
    const runs = toSegments([0, 50, null, 100, 100], { width: 400, height: 100, min: 0, max: 100 });
    expect(runs).toEqual([
      [
        [0, 100],
        [100, 50],
      ],
      [
        [300, 0],
        [400, 0],
      ],
    ]);
  });

  test("clamps values outside the domain", () => {
    expect(toSegments([-5, 200], { width: 10, height: 10, min: 0, max: 100 })).toEqual([
      [
        [0, 10],
        [10, 0],
      ],
    ]);
  });
});

describe("niceDomain", () => {
  test("starts at 0 for non-negative data with headroom on top", () => {
    const d = niceDomain([10, 50, null]);
    expect(d.min).toBe(0);
    expect(d.max).toBeCloseTo(56);
  });

  test("respects fixed bounds and empty data", () => {
    expect(niceDomain([1, 2], { min: 0, max: 100 })).toEqual({ min: 0, max: 100 });
    expect(niceDomain([])).toEqual({ min: 0, max: 1 });
  });
});
