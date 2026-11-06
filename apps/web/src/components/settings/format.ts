// Formatting helpers for the settings, activity and approvals screens.
// Pure functions, so they are easy to test and render the same everywhere.

const units = ["B", "KB", "MB", "GB", "TB"] as const;

/** 1536 -> "1.5 KB". Uses 1024 steps, like the node and storage screens. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** US dollars: two decimals, or four below one cent so tiny AI costs are not shown as $0.00. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 4200 -> "4.2 s", 340 -> "340 ms", 125000 -> "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** Timestamps from ops are ISO strings or epoch milliseconds; Eden-style parsing may also hand us a Date. */
export type TimeInput = string | number | Date;

export function toDate(value: TimeInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "Nov 5, 2026, 14:03" in the reader's locale and time zone. */
export function formatDateTime(value: TimeInput): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatDate(value: TimeInput): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const steps: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/** "3 minutes ago", "in 2 days". `now` is a parameter so tests are stable. */
export function formatRelative(value: TimeInput, now: number = Date.now()): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "-";
  let delta = (date.getTime() - now) / 1000;
  if (Math.abs(delta) < 10) return relative.format(0, "second");
  for (const [unit, size] of steps) {
    if (Math.abs(delta) < size) return relative.format(Math.round(delta), unit);
    delta /= size;
  }
  return relative.format(Math.round(delta), "year");
}

/** A short form of a browser user agent: "Firefox on macOS". Unknown parts are left out. */
export function describeUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const browser =
    [
      ["Edg/", "Edge"],
      ["OPR/", "Opera"],
      ["Firefox/", "Firefox"],
      ["Chrome/", "Chrome"],
      ["Safari/", "Safari"],
      ["curl/", "curl"],
    ].find(([needle]) => userAgent.includes(needle as string))?.[1] ?? null;
  const os =
    [
      ["iPhone", "iOS"],
      ["iPad", "iPadOS"],
      ["Android", "Android"],
      ["Mac OS X", "macOS"],
      ["Windows", "Windows"],
      ["Linux", "Linux"],
    ].find(([needle]) => userAgent.includes(needle as string))?.[1] ?? null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? userAgent.slice(0, 60);
}
