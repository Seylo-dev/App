import { describe, expect, test } from "bun:test";
import { describeCron } from "./cron-text";

describe("describeCron", () => {
  test("common schedules read as sentences", () => {
    expect(describeCron("0 3 * * *")).toBe("Daily at 03:00");
    expect(describeCron("0 * * * *")).toBe("Every hour at :00");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours");
    expect(describeCron("30 2 * * 0")).toBe("Weekly on Sunday at 02:30");
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(describeCron("0 3 1 * *")).toBe("Monthly on day 1 at 03:00");
    expect(describeCron("@hourly")).toBe("Every hour");
  });
  test("anything else stays an expression", () => {
    expect(describeCron("0 3 1-7 * 1")).toBe("0 3 1-7 * 1");
    expect(describeCron("nonsense")).toBe("nonsense");
  });
});
