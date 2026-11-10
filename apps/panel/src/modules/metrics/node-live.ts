// The dashboard's live graphs ("node-live:<id>", metrics.nodeLive in
// @seylo/ops). Agents report every 10 s; a live graph wants a point every
// 2 s. So while at least one tab follows a node's node-live topic, the
// panel keeps one light WatchMetrics stream open to that node's agent
// (CPU, memory and the network counters: three /proc reads per sample, no
// Docker) and sends each sample to the topic; the hub fans it out to every
// tab. Nothing is stored: the 10 s samples keep feeding metrics.db.
//
//   the first tab follows   open a watch: light, every intervalMs, lease leaseMs
//   more tabs               the same watch
//   its lease ends soon     open the next one renewBeforeMs early; at its first sample cancel the old
//   the last tab leaves     keep the watch lingerMs (a reload, a quick tab switch), then cancel it
//   node offline            reopen when it connects again
//   the watch fails         reopen after retryMs, doubling to maxRetryMs
//   no metrics.read.v1      nothing: the graphs fall back to the hour's series
//
// Agents that do not know light or lease send full node samples (the same
// fields) until cancelled, so the renewal's cancel ends each of theirs too.

import { durationFromMs, timestampDate } from "@bufbuild/protobuf/wkt";
import { type LiveEvent, type LiveTopic, metrics, OpError } from "@seylo/ops";
import type { MetricsReport } from "@seylo/proto";
import type { AgentStream } from "../../agent-hub/calls";
import type { AgentHub } from "../../agent-hub/hub";
import type { LiveHub } from "../../live/hub";
import type { Logger } from "../../logger";
import { type Counter, rate } from "./ingest";

export type NodeLiveSample = Extract<LiveEvent, { type: "nodeLive" }>["sample"];

export interface NodeLiveOptions {
  /** How often the agent samples. */
  intervalMs?: number;
  /** Each watch ends by itself on the agent after this long. */
  leaseMs?: number;
  /** The next watch opens this long before the current one's lease ends. */
  renewBeforeMs?: number;
  /** How long a node keeps streaming after its last tab left. */
  lingerMs?: number;
  /** First wait before reopening a failed watch; doubles up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
}

export const nodeLiveDefaults: Required<NodeLiveOptions> = {
  intervalMs: metrics.nodeLive.intervalMs,
  leaseMs: 60_000,
  renewBeforeMs: 5_000,
  lingerMs: 10_000,
  retryMs: 2_000,
  maxRetryMs: 30_000,
};

export interface NodeLiveDeps {
  agents: Pick<AgentHub, "open" | "supports" | "onConnection">;
  live: Pick<LiveHub, "publish" | "onTopicActive">;
  logger: Logger;
  /** The node's counters from its latest periodic sample (the first live sample's rate). */
  counters?: (nodeId: string) => Counter | undefined;
}

export interface NodeLive {
  /** Nodes with a watch open now. */
  streaming(): string[];
  /** Cancels every watch and stops following the hub. */
  stop(): void;
}

const topicPrefix = "node-live:";

interface Stream {
  openedAt: number;
  /** Cancelled by us, or ended: its samples no longer go out. */
  cancelled: boolean;
  cancel(reason: string): void;
}

interface Watch {
  nodeId: string;
  /** Some tab follows the topic. */
  wanted: boolean;
  /** The watch whose samples go out. */
  current: Stream | null;
  /** The renewal, opened before current's lease ends; it takes over with its first sample. */
  next: Stream | null;
  /** Counters of the last sample sent, for the rates of the next. */
  last: Counter | null;
  retryMs: number;
  linger?: ReturnType<typeof setTimeout>;
  renew?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
}

const isOffline = (error: unknown) => error instanceof OpError && error.details?.reason === "offline";

function timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, Math.max(0, ms));
  t.unref?.();
  return t;
}

export function createNodeLive(deps: NodeLiveDeps, options: NodeLiveOptions = {}): NodeLive {
  const o = { ...nodeLiveDefaults, ...options };
  const watches = new Map<string, Watch>();

  const publish = (w: Watch, report: MetricsReport | undefined) => {
    const node = report?.node;
    if (!node) return;
    const t = report.time ? timestampDate(report.time).getTime() : Date.now();
    // Not newer than a sample already handled (the old watch of a renewal): nothing new.
    if (w.last && t <= w.last.t) return;
    const prev = w.last ?? deps.counters?.(w.nodeId);
    w.last = { t, rx: node.networkRxBytes, tx: node.networkTxBytes };
    // Without a reading before it there is no rate yet: the next sample has one.
    if (!prev || t <= prev.t) return;
    const r = rate(prev, t, node.networkRxBytes, node.networkTxBytes);
    const sample: NodeLiveSample = {
      t,
      cpuPercent: node.cpuPercent,
      memoryUsedBytes: Number(node.memoryUsedBytes),
      memoryTotalBytes: Number(node.memoryTotalBytes),
      networkRxBytesPerSec: r.rx,
      networkTxBytesPerSec: r.tx,
    };
    deps.live.publish(`${topicPrefix}${w.nodeId}` as LiveTopic, { type: "nodeLive", nodeId: w.nodeId, sample });
  };

  const scheduleRenew = (w: Watch, s: Stream) => {
    clearTimeout(w.renew);
    w.renew = timer(
      () => {
        w.renew = undefined;
        if (w.wanted && w.current === s && !w.next) open(w, "next");
      },
      s.openedAt + o.leaseMs - o.renewBeforeMs - Date.now(),
    );
  };

  const scheduleRetry = (w: Watch) => {
    if (w.retry) return;
    const wait = w.retryMs;
    w.retryMs = Math.min(w.retryMs * 2, o.maxRetryMs);
    w.retry = timer(() => {
      w.retry = undefined;
      if (w.wanted && !w.current) open(w, "current");
    }, wait);
  };

  /** A watch ended: by its lease (error null), the node going away or a failure. */
  const ended = (w: Watch, s: Stream, error: unknown) => {
    if (s.cancelled) return;
    s.cancelled = true;
    if (w.next === s) {
      // The renewal failed before it sent anything; the current watch runs on to its lease.
      w.next = null;
      return;
    }
    if (w.current !== s) return;
    w.current = null;
    clearTimeout(w.renew);
    if (w.next) {
      // The lease ran out before the renewal's first sample: the renewal takes over now.
      w.current = w.next;
      w.next = null;
      scheduleRenew(w, w.current);
      return;
    }
    if (!w.wanted) return;
    if (error === null) {
      // Its lease ran out without a renewal (that failed): the next one now. One
      // that ends early on its own waits like a failure, so it never spins.
      if (Date.now() - s.openedAt >= o.leaseMs / 2) open(w, "current");
      else scheduleRetry(w);
    } else if (!isOffline(error)) {
      deps.logger.warn({ err: error, nodeId: w.nodeId }, "live metrics watch failed");
      scheduleRetry(w);
    }
    // Offline: the connection listener opens it again.
  };

  const open = (w: Watch, as: "current" | "next") => {
    // Offline, or an agent without metrics.read.v1: nothing to ask (the graphs fall back).
    if (!deps.agents.supports(w.nodeId, "watchMetrics")) return;
    let stream: AgentStream<"watchMetrics">;
    try {
      stream = deps.agents.open(w.nodeId, "watchMetrics", {
        interval: durationFromMs(o.intervalMs),
        light: true,
        lease: durationFromMs(o.leaseMs),
      });
    } catch (error) {
      if (as === "current" && !isOffline(error)) scheduleRetry(w);
      return;
    }
    const s: Stream = {
      openedAt: Date.now(),
      cancelled: false,
      cancel(reason) {
        if (this.cancelled) return;
        this.cancelled = true;
        stream.cancel(reason);
      },
    };
    if (as === "current") {
      w.current = s;
      scheduleRenew(w, s);
    } else w.next = s;
    void (async () => {
      try {
        for await (const response of stream) {
          if (s.cancelled) break;
          if (w.next === s) {
            // The renewal's first sample: it takes over, the old watch goes.
            const old = w.current;
            w.current = s;
            w.next = null;
            scheduleRenew(w, s);
            old?.cancel("renewed");
          }
          if (w.current !== s) continue;
          w.retryMs = o.retryMs;
          publish(w, response.sample);
        }
        await stream.done;
        ended(w, s, null);
      } catch (error) {
        ended(w, s, error);
      }
    })();
  };

  const stopWatch = (w: Watch) => {
    for (const t of [w.linger, w.renew, w.retry]) clearTimeout(t);
    w.current?.cancel("nobody watches");
    w.next?.cancel("nobody watches");
    watches.delete(w.nodeId);
  };

  const want = (nodeId: string) => {
    let w = watches.get(nodeId);
    if (!w) {
      w = { nodeId, wanted: true, current: null, next: null, last: null, retryMs: o.retryMs };
      watches.set(nodeId, w);
    }
    w.wanted = true;
    clearTimeout(w.linger);
    w.linger = undefined;
    if (!w.current && !w.retry) open(w, "current");
  };

  const unwant = (nodeId: string) => {
    const w = watches.get(nodeId);
    if (!w) return;
    w.wanted = false;
    clearTimeout(w.linger);
    w.linger = timer(() => {
      if (!w.wanted) stopWatch(w);
    }, o.lingerMs);
  };

  const removeTopic = deps.live.onTopicActive((topic, active) => {
    if (!topic.startsWith(topicPrefix)) return;
    const nodeId = topic.slice(topicPrefix.length);
    if (active) want(nodeId);
    else unwant(nodeId);
  });

  const removeConnection = deps.agents.onConnection((nodeId, online) => {
    const w = watches.get(nodeId);
    if (!online || !w?.wanted) return;
    // After the handshake: register() runs before HelloAccepted goes out.
    queueMicrotask(() => {
      if (w.wanted && !w.current && watches.get(nodeId) === w) {
        w.last = null;
        w.retryMs = o.retryMs;
        open(w, "current");
      }
    });
  });

  return {
    streaming: () => [...watches.values()].filter((w) => w.current).map((w) => w.nodeId),
    stop() {
      removeTopic();
      removeConnection();
      for (const w of [...watches.values()]) stopWatch(w);
    },
  };
}
