import { describe, expect, test } from "bun:test";
import {
  formatAgo,
  formatBytes,
  formatDuration,
  formatExpiresIn,
  formatNames,
  formatPercent,
  formatRate,
  formatUsage,
  formatUsedOfTotal,
} from "./format";

const gb = 1024 ** 3;
const mb = 1024 ** 2;

describe("format", () => {
  test("sizes use one decimal under 10 and none above", () => {
    expect(formatBytes(182 * mb)).toBe("182 MB");
    expect(formatBytes(6.2 * gb)).toBe("6.2 GB");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatRate(4.1 * mb)).toBe("4.1 MB/s");
  });

  test("used of total share the total's unit", () => {
    expect(formatUsedOfTotal(6.2 * gb, 16 * gb)).toBe("6.2 / 16 GB");
    expect(formatUsedOfTotal(512 * mb, 8 * gb)).toBe("0.5 / 8 GB");
  });

  test("percent keeps a decimal for idle values", () => {
    expect(formatPercent(23.4)).toBe("23%");
    expect(formatPercent(0.4)).toBe("0.4%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatUsage(4, 182 * mb)).toBe("4% · 182 MB");
    expect(formatUsage(null, 1)).toBeNull();
  });

  test("relative times", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(formatAgo("2026-11-05T11:59:30Z", now)).toBe("now");
    expect(formatAgo("2026-11-05T11:57:00Z", now)).toBe("3 min ago");
    expect(formatAgo("2026-11-05T10:00:00Z", now)).toBe("2 h ago");
    expect(formatAgo("2026-11-04T11:00:00Z", now)).toBe("1 day ago");
    expect(formatAgo("2026-11-01T11:00:00Z", now)).toBe("4 days ago");
    expect(formatExpiresIn("2026-11-05T12:58:00Z", now)).toBe("in 58 minutes");
    expect(formatExpiresIn("2026-11-05T12:00:40Z", now)).toBe("in 40 seconds");
    expect(formatExpiresIn("2026-11-05T11:00:00Z", now)).toBe("expired");
    expect(formatExpiresIn("2026-11-12T12:00:00Z", now)).toBe("in 7 days");
    expect(formatExpiresIn("2026-11-05T17:00:00Z", now)).toBe("in 5 hours");
    expect(formatDuration(41_000)).toBe("41s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  test("names, as the panel's messages list them", () => {
    expect(formatNames([])).toBe("");
    expect(formatNames(["b1"])).toBe("b1");
    expect(formatNames(["b1", "b2"])).toBe("b1 and b2");
    expect(formatNames(["b1", "b2", "b3"])).toBe("b1, b2 and b3");
  });
});
