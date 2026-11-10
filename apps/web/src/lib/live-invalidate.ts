// How the live socket's invalidations reach the query cache. Bursts are
// merged: an op's cached queries refetch at most once a second, however
// many events name it. While the tab is hidden nothing refetches: the
// invalidations wait and run once when the tab is shown again, so a tab
// left open in the background neither downloads graphs nobody sees nor
// keeps its session alive by itself (sessions slide on use).

import type { LiveInputMatch } from "@seylo/ops";
import { opQueryKey } from "@seylo/ops/react";
import type { Query, QueryClient } from "@tanstack/react-query";

/** At most one refetch per op per this many milliseconds. */
export const invalidateIntervalMs = 1_000;

export interface Invalidator {
  /** These ops' cached queries (all inputs, or those `match` names) are stale. */
  invalidate(ops: readonly string[], match?: LiveInputMatch): void;
  /** Everything is stale (the socket was down and may have missed events). */
  invalidateAll(): void;
  /** The tab was shown again: runs what waited. */
  visible(): void;
}

export interface InvalidatorOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
  hidden?: () => boolean;
}

/**
 * The match an invalidation without its own gets from its topic. The panel
 * publishes "services.list is stale" on project:<id> when a container of
 * that project changes; without a match every project's services.list on
 * screen (the dashboard, the sidebar's open projects) refetched each time.
 * A project, service or node topic names only that one; an input without
 * the key still matches (matchesInput), so nothing that refetched for the
 * topic's own project, service or node stops refetching.
 */
export function topicMatch(topic: string): LiveInputMatch | undefined {
  const colon = topic.indexOf(":");
  if (colon < 0) return undefined;
  const id = topic.slice(colon + 1);
  if (!id) return undefined;
  switch (topic.slice(0, colon)) {
    case "project":
      return { projectId: [id] };
    case "service":
      return { serviceId: [id] };
    case "node":
      return { nodeId: [id] };
    default:
      return undefined;
  }
}

/** True when the query's input matches (a key the input leaves out matches: the op's default applies). */
export function matchesInput(query: Pick<Query, "queryKey">, match: LiveInputMatch): boolean {
  const input = query.queryKey[2];
  if (input === null || typeof input !== "object") return true;
  for (const [key, values] of Object.entries(match)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (!values.includes(value as string | number | boolean)) return false;
  }
  return true;
}

export function createInvalidator(cache: QueryClient, options: InvalidatorOptions = {}): Invalidator {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  const hidden = options.hidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  /** Per op: the matches waiting, or "all" for every input. */
  const pending = new Map<string, LiveInputMatch[] | "all">();
  let everything = false;
  let lastRun = Number.NEGATIVE_INFINITY;
  let timer = false;

  const run = () => {
    timer = false;
    if (hidden()) return;
    lastRun = now();
    if (everything) {
      everything = false;
      pending.clear();
      void cache.invalidateQueries();
      return;
    }
    const due = [...pending];
    pending.clear();
    for (const [opId, matches] of due) {
      void cache.invalidateQueries({
        queryKey: opQueryKey({ id: opId }),
        ...(matches === "all" ? {} : { predicate: (query: Query) => matches.some((match) => matchesInput(query, match)) }),
      });
    }
  };

  const kick = () => {
    if (timer || hidden()) return;
    timer = true;
    setTimer(run, Math.max(0, lastRun + invalidateIntervalMs - now()));
  };

  return {
    invalidate(ops, match) {
      for (const opId of ops) {
        const waiting = pending.get(opId);
        if (!match || waiting === "all") pending.set(opId, "all");
        else pending.set(opId, [...(waiting ?? []), match]);
      }
      kick();
    },
    invalidateAll() {
      everything = true;
      kick();
    },
    visible() {
      if (everything || pending.size > 0) kick();
    },
  };
}
