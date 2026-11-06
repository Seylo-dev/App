// A plain sentence for common five-field cron schedules ("Daily at 03:00"),
// used by backup schedules and cron jobs. Anything unusual is shown as the
// expression itself.

import { t } from "../../i18n/t";

const two = (n: string) => n.padStart(2, "0");
const isNum = (s: string) => /^\d+$/.test(s);

export function describeCron(expression: string): string {
  const e = expression.trim();
  const named: Record<string, string> = {
    "@hourly": t("serviceCron.every.hour"),
    "@daily": t("serviceCron.every.dayAt", { time: "00:00" }),
    "@weekly": t("serviceCron.every.weekAt", { day: weekday(0), time: "00:00" }),
    "@monthly": t("serviceCron.every.monthAt", { day: "1", time: "00:00" }),
    "@yearly": t("serviceCron.every.year"),
  };
  if (named[e]) return named[e] as string;
  const parts = e.split(/\s+/);
  if (parts.length !== 5) return e;
  const [min = "", hour = "", dom = "", mon = "", dow = ""] = parts;
  const step = min.match(/^\*\/(\d+)$/);
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") return t("serviceCron.every.minutes", { count: Number(step[1]) });
  if (min === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*") return t("serviceCron.every.minute");
  if (!isNum(min)) return e;
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") return t("serviceCron.every.hourAt", { minute: two(min) });
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep && dom === "*" && mon === "*" && dow === "*") return t("serviceCron.every.hours", { count: Number(hourStep[1]) });
  if (!isNum(hour)) return e;
  const time = `${two(hour)}:${two(min)}`;
  if (dom === "*" && mon === "*" && dow === "*") return t("serviceCron.every.dayAt", { time });
  if (dom === "*" && mon === "*" && isNum(dow)) return t("serviceCron.every.weekAt", { day: weekday(Number(dow) % 7), time });
  if (dom === "*" && mon === "*" && dow === "1-5") return t("serviceCron.every.weekdaysAt", { time });
  if (isNum(dom) && mon === "*" && dow === "*") return t("serviceCron.every.monthAt", { day: dom, time });
  return e;
}

function weekday(index: number): string {
  // 2023-01-01 was a Sunday, cron's day 0.
  return new Date(Date.UTC(2023, 0, 1 + index)).toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });
}

/** Schedules offered in pickers, as cron expressions. */
export const schedulePresets = ["0 3 * * *", "0 * * * *", "0 */6 * * *", "0 3 * * 0", "0 3 1 * *"] as const;
