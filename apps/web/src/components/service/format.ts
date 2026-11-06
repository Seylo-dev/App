// Small number and time formatters for the service screens. Pure, so they
// are tested without a DOM. Units are symbols ("MB", "s"), not words, so
// they stay out of the i18n catalog like digits do.

const units = ["B", "KB", "MB", "GB", "TB"] as const;

/** 241 MB, 1.2 GB, 812 KB. Decimal units, like docker stats. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "-";
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[unit]}`;
}

/** 1.2 MB/s */
export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null) return "-";
  return `${formatBytes(bytesPerSec)}/s`;
}

/** 7%, 0.4%, 112% (per core, like docker stats). */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value > 0 && value < 1) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

/** 41s, 1m 02s, 2h 05m. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "-";
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** 0:34, 12:05, 1:02:10: a running timer. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** 14:02:11 in local time. */
export function formatTimeOfDay(at: string | number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** 3 Feb, 3 Feb 2027 when not this year. */
export function formatDate(at: string | number | Date, now = new Date()): string {
  const date = at instanceof Date ? at : new Date(at);
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** 3 Feb 14:02. */
export function formatDateTime(at: string | number | Date, now = new Date()): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${formatDate(date, now)} ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

const relative =
  typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;

/** "40 seconds ago", "2 hours ago", "yesterday", "in 5 minutes". Uses the browser's locale. */
export function formatRelative(at: string | number | Date, now: number = Date.now()): string {
  const time = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const diff = (time - now) / 1000;
  const abs = Math.abs(diff);
  const pick: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [diff, "second"]
      : abs < 3600
        ? [diff / 60, "minute"]
        : abs < 86_400
          ? [diff / 3600, "hour"]
          : abs < 30 * 86_400
            ? [diff / 86_400, "day"]
            : abs < 365 * 86_400
              ? [diff / (30 * 86_400), "month"]
              : [diff / (365 * 86_400), "year"];
  const value = Math.round(pick[0]);
  return relative ? relative.format(value, pick[1]) : new Date(time).toISOString();
}

/** First 7 characters of a commit. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

/** sha256:4be1a9...07c3 shortened to 4be1a9…07c3 for chips. */
export function shortDigest(digest: string | null | undefined): string {
  if (!digest) return "";
  const hex = digest.replace(/^sha256:/, "");
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

/** Unix mode bits as rwxr-xr-x. */
export function formatMode(mode: number): string {
  const bits = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : "-";
  return out;
}

/** 0644 */
export function formatOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}
