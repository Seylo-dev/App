// Helpers for the AI usage card: the months to pick from and the daily
// spend as chart series (per day and running total), with days that had no
// requests filled in as zero.

/** "2026-11", "2026-10", ... newest first, in UTC like the usage op. */
export function recentMonths(now: Date, count: number): string[] {
  const months: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

export function daysInMonth(month: string): number {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, m ?? 1, 0)).getUTCDate();
}

/**
 * One value per day of the month: the spend that day and the running
 * total. Future days of the current month are null so the lines stop at
 * today.
 */
export function dailySeries(
  month: string,
  byDay: readonly { day: string; costUsd: number }[],
  now: Date,
): { daily: (number | null)[]; total: (number | null)[]; labels: string[] } {
  const days = daysInMonth(month);
  const cost = new Map(byDay.map((d) => [Number(d.day.slice(8, 10)), d.costUsd]));
  const current = recentMonths(now, 1)[0] === month;
  const lastDay = current ? now.getUTCDate() : days;
  const daily: (number | null)[] = [];
  const total: (number | null)[] = [];
  const labels: string[] = [];
  let sum = 0;
  for (let day = 1; day <= days; day++) {
    labels.push(`${month}-${String(day).padStart(2, "0")}`);
    if (day > lastDay) {
      daily.push(null);
      total.push(null);
      continue;
    }
    const value = cost.get(day) ?? 0;
    sum += value;
    daily.push(value);
    total.push(Math.round(sum * 10_000) / 10_000);
  }
  return { daily, total, labels };
}
