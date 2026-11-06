// Hover labels for chart points: times for short ranges, dates for long ones.

export type MetricsRange = "live" | "1h" | "24h" | "7d" | "30d";

export function pointLabels(times: readonly number[], range: MetricsRange): string[] {
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(range === "live" ? { second: "2-digit" } : {}),
    hour12: false,
  });
  const dateTime = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const fmt = range === "7d" || range === "30d" ? dateTime : time;
  return times.map((ms) => fmt.format(ms));
}
