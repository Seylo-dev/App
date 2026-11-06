// uptime.history: raw samples for 1h and 24h, hourly buckets for 7d and
// 30d, the uptime percentage, average latency and the down periods.

import type { uptime as uptimeOps } from "@seylo/ops";
import { and, asc, eq, gte } from "drizzle-orm";
import type { MetricsDb } from "../../db/client";
import { uptimeSamples } from "../../db/metrics/schema";

type Range = "1h" | "24h" | "7d" | "30d";

const rangeMs: Record<Range, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const hour = 60 * 60 * 1000;

type Sample = { at: number; ok: boolean; statusCode: number | null; latencyMs: number | null };

/** Down periods: from the first failed sample to the next good one (null while still down). */
export function incidents(samples: readonly Sample[]): { from: string; to: string | null; error: string }[] {
  const out: { from: string; to: string | null; error: string }[] = [];
  let open: { from: number; error: string } | null = null;
  for (const sample of samples) {
    if (!sample.ok && !open) {
      open = { from: sample.at, error: sample.statusCode ? `status ${sample.statusCode}` : "no answer" };
    } else if (sample.ok && open) {
      out.push({ from: new Date(open.from).toISOString(), to: new Date(sample.at).toISOString(), error: open.error });
      open = null;
    }
  }
  if (open) out.push({ from: new Date(open.from).toISOString(), to: null, error: open.error });
  return out;
}

export function history(
  metrics: MetricsDb,
  checkId: string,
  range: Range,
  now = Date.now(),
): Omit<typeof uptimeOps.history.output.static, never> {
  const samples: Sample[] = metrics
    .select({ at: uptimeSamples.at, ok: uptimeSamples.ok, statusCode: uptimeSamples.statusCode, latencyMs: uptimeSamples.latencyMs })
    .from(uptimeSamples)
    .where(and(eq(uptimeSamples.checkId, checkId), gte(uptimeSamples.at, now - rangeMs[range])))
    .orderBy(asc(uptimeSamples.at))
    .all();

  const latencies = samples.map((s) => s.latencyMs).filter((v): v is number => v !== null);
  const okCount = samples.filter((s) => s.ok).length;
  const summary = {
    range,
    uptimePercent: samples.length ? Math.round((okCount / samples.length) * 10_000) / 100 : null,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    incidents: incidents(samples),
  };

  if (range === "1h" || range === "24h") {
    return {
      ...summary,
      bucketSeconds: 0,
      points: samples.map((s) => ({
        at: new Date(s.at).toISOString(),
        ok: s.ok ? 1 : 0,
        latencyMs: s.latencyMs,
        statusCode: s.statusCode,
      })),
    };
  }

  const buckets = new Map<number, { total: number; ok: number; latency: number; latencyCount: number; lastStatus: number | null }>();
  for (const s of samples) {
    const start = Math.floor(s.at / hour) * hour;
    const bucket = buckets.get(start) ?? { total: 0, ok: 0, latency: 0, latencyCount: 0, lastStatus: null };
    bucket.total++;
    if (s.ok) bucket.ok++;
    if (s.latencyMs !== null) {
      bucket.latency += s.latencyMs;
      bucket.latencyCount++;
    }
    bucket.lastStatus = s.statusCode;
    buckets.set(start, bucket);
  }
  return {
    ...summary,
    bucketSeconds: hour / 1000,
    points: [...buckets.entries()].map(([start, b]) => ({
      at: new Date(start).toISOString(),
      ok: b.ok / b.total,
      latencyMs: b.latencyCount ? Math.round(b.latency / b.latencyCount) : null,
      statusCode: b.lastStatus,
    })),
  };
}
