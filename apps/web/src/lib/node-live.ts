// The dashboard's Live graphs (metrics.nodeLive in @seylo/ops). While they
// are on screen and the tab is visible, the tab follows every shown node's
// "node-live:<id>" topic and the panel streams a sample per node every
// 2 s; nothing flows while nobody watches, and a hidden tab stops
// following. Samples go into a NodeLiveBuffer (node-live-buffer.ts); the
// graphs re-render from it at most once a second, and SmoothChart's window
// slides them smoothly in between.

import type { LiveTopic } from "@seylo/ops";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { live, useLiveUp } from "./live";
import { type LivePoint, liveState, NodeLiveBuffer, type NodeLiveState } from "./node-live-buffer";

const pageVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/** True while the page is visible. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(pageVisible);
  useEffect(() => {
    const onChange = () => setVisible(pageVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export interface NodeLiveFeed {
  buffer: NodeLiveBuffer;
  state: NodeLiveState;
  /** Why it stalled: the live socket is down, or the nodes sent nothing. */
  reason: "socket" | "samples" | null;
  /** Changes when the buffer did, at most once per renderEveryMs: render on it. */
  version: number;
}

export interface NodeLiveOptions {
  /** The panel's points of the last 5 minutes per node, shown until live samples cover them. */
  seed?: readonly { nodeId: string; points: readonly LivePoint[] }[];
  /** Called when the live view starts again (the tab came back): fetch a fresh seed. */
  refetchSeed?: () => void;
  renderEveryMs?: number;
}

/** Follows the nodes' node-live topics while `enabled` and the page is visible, and says whether samples arrive. */
export function useNodeLive(nodeIds: readonly string[], enabled: boolean, options: NodeLiveOptions = {}): NodeLiveFeed {
  const [buffer] = useState(() => new NodeLiveBuffer());
  const visible = usePageVisible();
  const up = useLiveUp();
  const active = enabled && visible;
  const key = nodeIds.join(" ");
  const startedAt = useRef(Date.now());
  const refetch = useRef(options.refetchSeed);
  refetch.current = options.refetchSeed;

  const [version, setVersion] = useState(0);

  // Each start begins empty: samples from before a pause would leave a hole the seed cannot fill.
  // Layout effects, so the seed below is in before the first paint (no empty frame).
  const started = useRef(false);
  const seeded = useRef(new WeakSet<readonly LivePoint[]>());
  useLayoutEffect(() => {
    if (!active) return;
    buffer.clear();
    seeded.current = new WeakSet();
    startedAt.current = Date.now();
    if (started.current) refetch.current?.();
    started.current = true;
  }, [active, buffer]);

  // Seed points, once per answer (a nodeUsage patch keeps the point arrays, so it does not seed again).
  useLayoutEffect(() => {
    if (!active) return;
    let changed = false;
    for (const { nodeId, points } of options.seed ?? []) {
      if (seeded.current.has(points)) continue;
      seeded.current.add(points);
      buffer.seed(nodeId, points);
      changed = true;
    }
    if (changed) setVersion(buffer.version);
  }, [active, options.seed, buffer]);

  // The socket came back: the panel gets the subscriptions again and samples resume within a sample or two.
  useEffect(() => {
    if (up && active) startedAt.current = Math.max(startedAt.current, Date.now());
  }, [up, active]);

  useEffect(() => {
    if (!active || !key) return undefined;
    const stops = key.split(" ").map((nodeId) =>
      live.listen(`node-live:${nodeId}` as LiveTopic, (signal) => {
        if (signal.type === "event" && signal.event.type === "nodeLive") buffer.push(nodeId, signal.event.sample, Date.now());
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [active, key, buffer]);

  const renderEveryMs = options.renderEveryMs ?? 1000;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const off = buffer.subscribe(() => {
      if (timer !== undefined) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          last = Date.now();
          setVersion(buffer.version);
        },
        Math.max(0, last + renderEveryMs - Date.now()),
      );
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [buffer, renderEveryMs]);

  const isActive = useRef(active);
  isActive.current = active;
  const read = useCallback(
    () => liveState(Date.now(), { active: isActive.current, startedAt: startedAt.current, lastArrival: buffer.lastArrival }),
    [buffer],
  );
  const [state, setState] = useState<NodeLiveState>(read);
  // A sample, a reconnect or a switch: at once; samples stopping: the next tick sees it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version and up are what makes the state worth reading again.
  useEffect(() => setState(read()), [read, active, version, up]);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setState(read()), 1000);
    return () => clearInterval(timer);
  }, [active, read]);

  return { buffer, state, reason: state === "stalled" ? (up ? "samples" : "socket") : null, version };
}
