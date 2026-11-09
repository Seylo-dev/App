// Formatting for sizes, rates, percentages and times. Units follow the
// design: binary sizes with the short decimal names people expect
// ("182 MB", "6.2 / 16 GB"), one decimal under 10.

import { t } from "../i18n/t";

const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** 190840832 -> "182 MB". */
export function formatBytes(bytes: number): string {
  const [value, unit] = scale(bytes);
  return `${trim(value)} ${unit}`;
}

/** Both sides in the larger value's unit: "6.2 / 16 GB". */
export function formatUsedOfTotal(used: number, total: number): string {
  const [, unit, power] = scale(total);
  const divisor = 1024 ** power;
  return `${t("format.usedOfTotal", { used: trim(used / divisor), total: trim(total / divisor) })} ${unit}`;
}

/** Bytes per second -> "4.1 MB/s". */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** 23.4 -> "23%"; under 1 shows one decimal so idle services do not all read 0%. */
export function formatPercent(percent: number): string {
  return percent > 0 && percent < 1 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** "4% · 182 MB" for usage columns; null when there is no sample. */
export function formatUsage(cpuPercent: number | null, memoryBytes: number | null): string | null {
  if (cpuPercent === null || memoryBytes === null) return null;
  return t("format.usage", { cpu: formatPercent(cpuPercent), memory: formatBytes(memoryBytes) });
}

/** "now", "3 min ago", "2 h ago", "4 days ago". */
export function formatAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return t("format.justNow");
  if (seconds < 3600) return t("format.minutesAgo", { count: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t("format.hoursAgo", { count: Math.floor(seconds / 3600) });
  return t("format.daysAgo", { count: Math.floor(seconds / 86_400) });
}

/** "in 58 minutes", "in 40 seconds", "expired". */
export function formatExpiresIn(iso: string, now = Date.now()): string {
  const seconds = Math.floor((Date.parse(iso) - now) / 1000);
  if (seconds <= 0) return t("format.expired");
  if (seconds < 60) return t("format.inSeconds", { count: seconds });
  if (seconds < 2 * 3600) return t("format.inMinutes", { count: Math.ceil(seconds / 60) });
  if (seconds < 2 * 86_400) return t("format.inHours", { count: Math.round(seconds / 3600) });
  return t("format.inDays", { count: Math.round(seconds / 86_400) });
}

/** Chart tooltip labels: time for short ranges, day and time for long ones. */
export function formatPointTime(ms: number, longRange: boolean): string {
  const date = new Date(ms);
  return longRange
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** 41000 -> "41s", 125000 -> "2m 5s". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return t("format.seconds", { count: total });
  return t("format.minutesSeconds", { minutes: Math.floor(total / 60), seconds: total % 60 });
}

/** ["b1"] -> "b1", ["b1", "b2"] -> "b1 and b2", ["b1", "b2", "b3"] -> "b1, b2 and b3". */
export function formatNames(names: readonly string[]): string {
  const last = names.at(-1) ?? "";
  if (names.length <= 1) return last;
  if (names.length === 2) return t("format.namesTwo", { first: names[0] ?? "", last });
  return t("format.namesMany", { list: names.slice(0, -1).join(", "), last });
}

function scale(bytes: number): [number, (typeof units)[number], number] {
  let value = Math.max(0, bytes);
  let power = 0;
  while (value >= 1024 && power < units.length - 1) {
    value /= 1024;
    power++;
  }
  return [value, units[power] as (typeof units)[number], power];
}

function trim(value: number): string {
  return value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
}
