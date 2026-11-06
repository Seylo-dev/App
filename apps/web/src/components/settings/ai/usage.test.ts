import { expect, test } from "bun:test";
import { dailySeries, daysInMonth, recentMonths } from "./usage";

test("recentMonths walks back across the year boundary", () => {
  expect(recentMonths(new Date("2026-02-10T00:00:00Z"), 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
});

test("daysInMonth knows leap years", () => {
  expect(daysInMonth("2028-02")).toBe(29);
  expect(daysInMonth("2026-02")).toBe(28);
  expect(daysInMonth("2026-11")).toBe(30);
});

test("dailySeries fills gaps with zero and stops at today in the current month", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const { daily, total, labels } = dailySeries(
    "2026-11",
    [
      { day: "2026-11-02", costUsd: 1.5 },
      { day: "2026-11-04", costUsd: 0.25 },
    ],
    now,
  );
  expect(labels.length).toBe(30);
  expect(daily.slice(0, 6)).toEqual([0, 1.5, 0, 0.25, 0, null]);
  expect(total.slice(0, 6)).toEqual([0, 1.5, 1.5, 1.75, 1.75, null]);
});

test("past months run to their last day", () => {
  const { daily } = dailySeries("2026-10", [], new Date("2026-11-05T12:00:00Z"));
  expect(daily.length).toBe(31);
  expect(daily.every((v) => v === 0)).toBe(true);
});
