import { describe, expect, test } from "bun:test";
import { niceCeil, niceDomain, smoothAreaPath, smoothPath, stickyNiceMax, toSegments, toTimeSegments } from "./smooth-path";

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

describe("toTimeSegments", () => {
  const box = { width: 300, height: 100, min: 0, max: 100, start: 1000, span: 300 };

  test("places points by their own times, also outside the box", () => {
    expect(toTimeSegments([700, 1000, 1150, 1450], [50, 0, 100, 25], box)).toEqual([
      [
        [-300, 50],
        [0, 100],
        [150, 0],
        [450, 75],
      ],
    ]);
  });

  test("breaks the line at nulls and at gaps longer than maxGap", () => {
    const runs = toTimeSegments([1000, 1010, 1020, 1100, 1110], [1, null, 2, 3, 4], { ...box, maxGap: 50 });
    expect(runs.map((r) => r.map(([x]) => x))).toEqual([[0], [20], [100, 110]]);
    // A missing time is a gap too.
    expect(toTimeSegments([1000], [1, 2], box)).toHaveLength(1);
  });
});

describe("live graph maximum", () => {
  test("niceCeil rounds up to 1, 2, 2.5 or 5 times a power of ten", () => {
    expect([0, 0.3, 1, 1.01, 2.2, 3, 7, 12, 8600, 1e6].map(niceCeil)).toEqual([1, 0.5, 1, 2, 2.5, 5, 10, 20, 10_000, 1e6]);
  });

  test("stickyNiceMax grows at once and shrinks only once the data fits well under half", () => {
    let max = stickyNiceMax(undefined, 4000);
    expect(max).toBe(5000);
    // Samples moving about under it change nothing.
    for (const v of [3000, 4400, 2100, 4200]) max = stickyNiceMax(max, v);
    expect(max).toBe(5000);
    // A burst: room at once.
    max = stickyNiceMax(max, 9500);
    expect(max).toBe(20_000);
    // After it: 7000 still wants 10000, too close to shrink to; 4000 wants 5000, well under, so it shrinks.
    expect(stickyNiceMax(max, 7000)).toBe(20_000);
    expect(stickyNiceMax(max, 4000)).toBe(5000);
  });
});
