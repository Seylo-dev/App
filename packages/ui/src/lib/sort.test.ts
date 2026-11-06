import { describe, expect, test } from "bun:test";
import { compareValues, nextSort, sortRows } from "./sort";

describe("sortRows", () => {
  const rows = [
    { n: "web-10", v: 3, d: new Date(2026, 0, 2) },
    { n: "web-2", v: null, d: new Date(2026, 0, 1) },
    { n: "api", v: 1, d: new Date(2026, 0, 3) },
    { n: "Db", v: 3, d: null },
  ];

  test("strings sort naturally and case-insensitively", () => {
    expect(sortRows(rows, (r) => r.n, false).map((r) => r.n)).toEqual(["api", "Db", "web-2", "web-10"]);
  });

  test("numbers descending keep empties last and ties stable", () => {
    expect(sortRows(rows, (r) => r.v, true).map((r) => r.n)).toEqual(["web-10", "Db", "api", "web-2"]);
  });

  test("dates", () => {
    expect(sortRows(rows, (r) => r.d, false).map((r) => r.n)).toEqual(["web-2", "web-10", "api", "Db"]);
  });

  test("compareValues puts empty strings last both ways", () => {
    expect(compareValues("", "a")).toBe(1);
    expect(compareValues("", "a", true)).toBe(1);
  });
});

describe("nextSort", () => {
  test("cycles ascending, descending, off", () => {
    const a = nextSort(null, "name");
    expect(a).toEqual({ id: "name", desc: false });
    const b = nextSort(a, "name");
    expect(b).toEqual({ id: "name", desc: true });
    expect(nextSort(b, "name")).toBeNull();
    expect(nextSort(b, "age")).toEqual({ id: "age", desc: false });
  });
});
