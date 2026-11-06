// Cron expressions, one parser for the whole panel (croner): schedules of
// panel jobs (UTC) and the "next run" of service cron jobs (their own time
// zone, which only the agent fires). Five fields, or @hourly, @daily,
// @weekly, @monthly, @yearly. Day-of-month and day-of-week combine with OR,
// like Vixie cron and the agent.

import { Cron } from "croner";

function parse(expression: string, timeZone: string): Cron {
  return new Cron(expression.trim(), { timezone: timeZone, paused: true, mode: "5-part", legacyMode: true });
}

/** Null when the expression is fine; otherwise a message safe to show. */
export function cronProblem(expression: string, timeZone = "UTC"): string | null {
  try {
    parse(expression, timeZone);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^CronPattern:\s*/, "").replace(/^Cron:\s*/, "");
  }
}

/** The first time strictly after `after` that the expression matches, or null when it never does again. */
export function nextCronRun(expression: string, timeZone: string, after: Date): Date | null {
  return parse(expression, timeZone).nextRun(after);
}

/** True when the zone is an IANA name this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
