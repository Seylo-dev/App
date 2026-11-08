// What a metrics sample tells the web app (topics in @seylo/ops live.ts).
// Samples arrive about every 10 s per node, but the stored series change
// only when a minute is written, and the 5-minute and hourly buckets the
// longer ranges show change even less. So a sample pushes the node's newest
// values and refreshes only what moved, and the graphs refetch about once
// a minute, however many nodes report:
//
//   every sample
//     "node:<id>"     nodeUsage { usage }                    the node's newest values (the dashboard's and the node page's)
//                     invalidate metrics.node, range live
//     "service:<id>"  invalidate metrics.service, live + 1h   (1h carries the current values) at most once per 9 s per service
//   a minute was written
//     "panel"         invalidate metrics.nodes, metrics.summary  one publish for the whole fleet, fleetDelayMs after the
//                                                                first node's minute; 1h every minute, 24h every 5 minutes,
//                                                                7d and 30d every hour (refreshEveryMs)
//     "node:<id>"     invalidate metrics.node                 the same ranges
//     "service:<id>"  invalidate metrics.service              24h, 7d and 30d by the same periods
//
// Before, every sample of every node refetched the whole fleet's series on
// every open dashboard (K nodes: K responses of K series per 10 s).

import type { LiveEvent, LiveTopic } from "@seylo/ops";
import type { LiveHub } from "../../live/hub";
import type { Range } from "./query";

/** A node's newest values, as metrics.nodes returns them in `latest`. */
export type NodeUsageNow = Extract<LiveEvent, { type: "nodeUsage" }>["usage"];

type StoredRange = Exclude<Range, "live">;

/** How often a range's graphs refetch at most: about once per bucket they show. */
export const refreshEveryMs: Record<StoredRange, number> = {
  "1h": 60_000,
  "24h": 5 * 60_000,
  "7d": 3_600_000,
  "30d": 3_600_000,
};

/** Nodes sample on their own clocks: the first samples of a minute arrive within 10 s of each other. */
export const fleetDelayMs = 12_000;
/** A service on several nodes hears one sample per node per 10 s; its graphs refetch once. */
export const serviceIntervalMs = 9_000;
/** Minute writes arrive about 60 s apart, give or take the sampling jitter. */
const slackMs = 30_000;

const storedRanges = Object.keys(refreshEveryMs) as StoredRange[];

interface Pending {
  topic: LiveTopic;
  op: string;
  /** null: no match, every input of the op. */
  ranges: Set<string> | null;
}

export interface MetricsLiveOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
}

export interface MetricsLive {
  /** One node sample: its newest values, the services it carried and whether it wrote a minute. */
  sample(nodeId: string, usage: NodeUsageNow | null, serviceIds: readonly string[], wrote: boolean): void;
}

export function createMetricsLive(live: Pick<LiveHub, "publish">, options: MetricsLiveOptions = {}): MetricsLive {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
    });
  const pending = new Map<string, Pending>();
  const lastFired = new Map<string, number>();
  const lastRange = new Map<string, number>();

  const fire = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    lastFired.set(key, now());
    const event: LiveEvent = { type: "invalidate", ops: [entry.op], ...(entry.ranges ? { match: { range: [...entry.ranges] } } : {}) };
    live.publish(entry.topic, event);
  };

  /** Publishes one invalidation after delayMs, and no sooner than minIntervalMs after the last one; requests in between merge. */
  const schedule = (topic: LiveTopic, op: string, ranges: readonly string[] | null, delayMs: number, minIntervalMs = 0) => {
    if (ranges && ranges.length === 0) return;
    const key = `${topic}\0${op}`;
    const entry = pending.get(key);
    if (entry) {
      if (!ranges) entry.ranges = null;
      else if (entry.ranges) for (const range of ranges) entry.ranges.add(range);
      return;
    }
    pending.set(key, { topic, op, ranges: ranges ? new Set(ranges) : null });
    const at = Math.max(now() + delayMs, (lastFired.get(key) ?? Number.NEGATIVE_INFINITY) + minIntervalMs);
    setTimer(() => fire(key), Math.max(0, at - now()));
  };

  /** The stored ranges of this topic's op that are due for a refetch, marked as refreshed. */
  const due = (topic: LiveTopic, op: string): StoredRange[] =>
    storedRanges.filter((range) => {
      const key = `${topic}\0${op}\0${range}`;
      const last = lastRange.get(key);
      if (last !== undefined && now() - last < refreshEveryMs[range] - slackMs) return false;
      lastRange.set(key, now());
      return true;
    });

  return {
    sample(nodeId, usage, serviceIds, wrote) {
      const nodeTopic: LiveTopic = `node:${nodeId}`;
      if (usage) live.publish(nodeTopic, { type: "nodeUsage", nodeId, usage });
      live.publish(nodeTopic, { type: "invalidate", ops: ["metrics.node"], match: { range: ["live"] } });
      for (const id of serviceIds) schedule(`service:${id}`, "metrics.service", ["live", "1h"], 0, serviceIntervalMs);
      if (!wrote) return;
      schedule("panel", "metrics.nodes", due("panel", "metrics.nodes"), fleetDelayMs);
      schedule("panel", "metrics.summary", null, fleetDelayMs);
      schedule(nodeTopic, "metrics.node", due(nodeTopic, "metrics.node"), 0);
      for (const id of serviceIds) {
        const topic: LiveTopic = `service:${id}`;
        // 1h already follows every sample.
        schedule(
          topic,
          "metrics.service",
          due(topic, "metrics.service").filter((range) => range !== "1h"),
          0,
        );
      }
    },
  };
}
