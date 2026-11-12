import { describe, expect, test } from "bun:test";
import { nextSeq, toLogInput } from "./deploy-log";
import {
  formatBytes,
  formatClock,
  formatCount,
  formatDuration,
  formatMode,
  formatOctal,
  formatPercent,
  formatRate,
  shortDigest,
  shortSha,
} from "./format";

describe("formatCount", () => {
  test("k, M and B, one decimal under 10", () => {
    expect(formatCount(812)).toBe("812");
    expect(formatCount(1_240)).toBe("1.2k");
    expect(formatCount(14_200)).toBe("14k");
    expect(formatCount(3_400_000)).toBe("3.4M");
    expect(formatCount(2_000_000_000)).toBe("2B");
    expect(formatCount(-1)).toBe("-");
  });
});

describe("formatBytes", () => {
  test("decimal units with one decimal under 100", () => {
    expect(formatBytes(241_000_000)).toBe("241 MB");
    expect(formatBytes(18_400_000)).toBe("18.4 MB");
    expect(formatBytes(1_200_000_000)).toBe("1.2 GB");
    expect(formatBytes(2_000_000)).toBe("2 MB");
    expect(formatBytes(512)).toBe("512 B");
  });
  test("missing values", () => {
    expect(formatBytes(null)).toBe("-");
    expect(formatRate(undefined)).toBe("-");
  });
  test("rates", () => expect(formatRate(1_200_000)).toBe("1.2 MB/s"));
});

describe("durations", () => {
  test("seconds, minutes, hours", () => {
    expect(formatDuration(41_000)).toBe("41s");
    expect(formatDuration(62_000)).toBe("1m 02s");
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 05m");
  });
  test("running clock", () => {
    expect(formatClock(34_000)).toBe("0:34");
    expect(formatClock(3_730_000)).toBe("1:02:10");
  });
});

describe("small formatters", () => {
  test("percent", () => {
    expect(formatPercent(7.4)).toBe("7%");
    expect(formatPercent(0.42)).toBe("0.4%");
    expect(formatPercent(null)).toBe("-");
  });
  test("sha and digest", () => {
    expect(shortSha("9c41e07aa12")).toBe("9c41e07");
    expect(shortDigest("sha256:4be1a9aaaaaaaaaa07c3")).toBe("4be1a9…07c3");
    expect(shortDigest(null)).toBe("");
  });
  test("file modes", () => {
    expect(formatMode(0o644)).toBe("rw-r--r--");
    expect(formatMode(0o755)).toBe("rwxr-xr-x");
    expect(formatOctal(0o644)).toBe("0644");
  });
});

describe("deploy log paging", () => {
  test("nextSeq keeps the highest seq and survives empty pages", () => {
    expect(nextSeq(-1, [{ seq: 0 }, { seq: 4 }, { seq: 2 }])).toBe(4);
    expect(nextSeq(4, [])).toBe(4);
  });
  test("log lines map step to source and errors to the error level", () => {
    const line = toLogInput({ seq: 3, ts: "2026-11-05T10:00:00.000Z", step: "health", text: "giving up", error: true });
    expect(line).toEqual({ text: "giving up", ts: Date.parse("2026-11-05T10:00:00.000Z"), source: "health", level: "error" });
  });
});
