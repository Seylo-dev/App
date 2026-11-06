// Numbers, sizes and times as screens show them (lib/format.ts).

export default {
  justNow: "now",
  minutesAgo: "{count} min ago",
  hoursAgo: "{count} h ago",
  daysAgo: { one: "{count} day ago", other: "{count} days ago" },
  inMinutes: { one: "in {count} minute", other: "in {count} minutes" },
  inHours: { one: "in {count} hour", other: "in {count} hours" },
  inDays: { one: "in {count} day", other: "in {count} days" },
  inSeconds: { one: "in {count} second", other: "in {count} seconds" },
  expired: "expired",
  usage: "{cpu} · {memory}",
  usedOfTotal: "{used} / {total}",
  seconds: "{count}s",
  minutesSeconds: "{minutes}m {seconds}s",
  separator: " · ",
} as const;
