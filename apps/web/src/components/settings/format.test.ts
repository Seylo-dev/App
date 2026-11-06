import { expect, test } from "bun:test";
import { describeUserAgent, formatBytes, formatDuration, formatRelative, formatUsd } from "./format";

test("formatBytes uses 1024 steps and trims decimals", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  expect(formatBytes(150 * 1024 ** 2)).toBe("150 MB");
  expect(formatBytes(-1)).toBe("-");
});

test("formatUsd keeps tiny amounts visible", () => {
  expect(formatUsd(0)).toBe("$0.00");
  expect(formatUsd(0.0042)).toBe("$0.0042");
  expect(formatUsd(1234.5)).toBe("$1,234.50");
});

test("formatDuration picks a readable unit", () => {
  expect(formatDuration(340)).toBe("340 ms");
  expect(formatDuration(4200)).toBe("4.2 s");
  expect(formatDuration(42_000)).toBe("42 s");
  expect(formatDuration(125_000)).toBe("2 min 5 s");
  expect(formatDuration(120_000)).toBe("2 min");
});

test("formatRelative is relative to the given now", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  expect(formatRelative("2026-11-05T11:57:00Z", now)).toBe("3 minutes ago");
  expect(formatRelative("2026-11-07T12:00:00Z", now)).toBe("in 2 days");
  expect(formatRelative(now - 2000, now)).toBe("now");
  expect(formatRelative("not a date", now)).toBe("-");
});

test("describeUserAgent names browser and system", () => {
  expect(
    describeUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ),
  ).toBe("Chrome on macOS");
  expect(describeUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0")).toBe("Firefox on Linux");
  expect(describeUserAgent("curl/8.4.0")).toBe("curl");
  expect(describeUserAgent(null)).toBeNull();
});
