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

/**
 * The expression with Sunday written as 0 in the day-of-week field, the
 * way the node's parser reads it: croner (and so 0.1 panels, which saved
 * what croner took) also accepts 7, also as the end of a range (1-7,
 * MON-SUN), and the agent cannot read those. A part with a 7 becomes the
 * same days without it ("7" -> "0", "1-7" -> "1-6,0", "0-7" -> "0-6", "1-7/2" ->
 * "1,3,5,0"); everything else, and an expression without a 7, comes back
 * unchanged. Never "*": a restricted day of week combines with the day of
 * month by OR, "*" does not. Applied when a schedule is saved and when an
 * older row is read.
 */
export function normalizeCronSchedule(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0]?.startsWith("@")) return expression;
  let changed = false;
  const parts = (fields[4] as string).split(",").map((part) => {
    const [range = "", stepText] = part.split("/");
    if (range === "*" || range === "?") return part;
    const ends = range.split("-");
    const values = ends.map((v) => weekdayNames[v.toLowerCase()] ?? Number(v));
    if (values.some((v) => !Number.isInteger(v)) || values.length > 2) return part;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return part;
    const [from = 0, rawTo] = values;
    // "MON-SUN": SUN at the end of a range means 7.
    const to = rawTo === 0 && from > 0 ? 7 : rawTo;
    if (to === undefined) {
      // A stepped single value ("7/2") is refused by both parsers anyway.
      if (from !== 7 || stepText !== undefined) return part;
      changed = true;
      return "0";
    }
    if (to !== 7 || from > 7) return part;
    changed = true;
    if (step === 1) return from === 0 ? "0-6" : from === 7 ? "0" : from === 6 ? "6,0" : `${from}-6,0`;
    const days: number[] = [];
    for (let day = from; day <= 7; day += step) days.push(day === 7 ? 0 : day);
    return [...new Set(days)].join(",");
  });
  if (!changed) return expression;
  fields[4] = parts.join(",");
  return fields.join(" ");
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
