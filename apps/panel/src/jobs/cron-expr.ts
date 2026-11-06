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

/** L, W and # (last day, nearest weekday, nth weekday). */
const extensions = /(^|[\s,/-])L($|[\s,/-])|\d+[LW]\b|#/i;
const weekdayNames: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Null when the node's cron parser (robfig/cron: five fields, day of week
 * 0-6) reads the expression as croner does; otherwise a message safe to
 * show. croner also reads L, W and # and takes 7 for Sunday, also as the
 * end of a range (1-7, MON-SUN), which the agent refuses: such a schedule
 * would pass here and never fire on the node. For the cleanup schedule and
 * service cron jobs, which only the agent fires.
 */
export function agentCronProblem(expression: string): string | null {
  const expr = expression.trim();
  if (expr.startsWith("@")) return null;
  if (extensions.test(expr)) return "L, W and # are not supported";
  const weekday = expr.split(/\s+/)[4];
  if (weekday === undefined) return null; // cronProblem names the shape
  for (const part of weekday.split(",")) {
    const range = part.split("/")[0] ?? "";
    if (range === "*" || range === "?") continue;
    const ends = range.split("-").map((v) => weekdayNames[v.toLowerCase()] ?? Number(v));
    const [from = 0, to = from] = ends;
    if (ends.includes(7) || to < from) return "Sunday is 0 on the node, not 7 (write 1-6,0 instead of 1-7 or MON-SUN)";
  }
  return null;
}

/** cronProblem, then agentCronProblem: null when both croner and the node's agent read the expression. */
export function nodeCronProblem(expression: string, timeZone = "UTC"): string | null {
  return cronProblem(expression, timeZone) ?? agentCronProblem(expression);
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
