// Follows a deployment's build and deploy log into a LogBuffer. Lines
// arrive on the live topic deployment:<id>; deployments.log with afterSeq
// fills the start and any gap (after a reconnect, or when the topic skipped
// lines). Polling stays as the fallback: every second while the live socket
// is down or refused the topic, and a slow check while it is up, which is
// also how the hook learns that the log is done.

import { deployments, type LiveTopic } from "@seylo/ops";
import { opQueryKey, useOpClient } from "@seylo/ops/react";
import type { LogBuffer, LogLineInput } from "@seylo/ui/components/log-viewer";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type LiveSignal, live } from "../../lib/live";
import { isActiveDeployment } from "./status";

export type DeployLogLine = (typeof deployments.LogLine)["static"];
type Deployment = (typeof deployments.Deployment)["static"];
type GetOutput = { deployment: Deployment };
type ListOutput = { deployments: Deployment[] };

/**
 * Puts a deployment from the live topic into every cached deployments.get
 * and deployments.list answer that holds it, so status and steps move
 * without a refetch.
 */
export function applyDeployment(cache: QueryClient, deployment: Deployment): void {
  cache.setQueriesData<GetOutput>({ queryKey: opQueryKey(deployments.get) }, (old) =>
    old?.deployment.id === deployment.id ? { ...old, deployment } : old,
  );
  cache.setQueriesData<ListOutput>({ queryKey: opQueryKey(deployments.list) }, (old) =>
    old?.deployments.some((d) => d.id === deployment.id)
      ? { ...old, deployments: old.deployments.map((d) => (d.id === deployment.id ? deployment : d)) }
      : old,
  );
}

/** One deploy log line as the LogViewer shows it: the step as source, errors in red. */
export function toLogInput(line: DeployLogLine): LogLineInput {
  return { text: line.text, ts: Date.parse(line.ts), source: line.step, level: line.error ? "error" : "info" };
}

/** The next afterSeq after a page; keeps the old one when the page was empty. */
export function nextSeq(afterSeq: number, lines: readonly { seq: number }[]): number {
  let last = afterSeq;
  for (const line of lines) if (line.seq > last) last = line.seq;
  return last;
}

/**
 * Lines of a live event that are new after afterSeq, and whether some are
 * missing in between (seq numbers are consecutive, so a jump means the
 * socket missed lines and a deployments.log page has to fill them).
 */
export function freshLines<T extends { seq: number }>(afterSeq: number, lines: readonly T[]): { fresh: T[]; gap: boolean } {
  const fresh = lines.filter((line) => line.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  const first = fresh[0];
  return { fresh, gap: first !== undefined && first.seq > afterSeq + 1 };
}

export interface DeployLogState {
  done: boolean;
  lines: number;
  error: unknown;
  /** True while lines come over the live socket (false: polling). */
  live: boolean;
}

const pollMs = 1000;
/** While the topic is live, a page now and then catches the end of the log. */
const livePollMs = 5000;
const pageSize = 5000;

/** Streams a deployment's log into buffer (cleared first) while mounted. */
export function useDeploymentLog(serviceId: string, deploymentId: string | null, buffer: LogBuffer): DeployLogState {
  const client = useOpClient();
  const cache = useQueryClient();
  const [state, setState] = useState<DeployLogState>({ done: false, lines: 0, error: null, live: false });

  useEffect(() => {
    buffer.clear();
    setState({ done: false, lines: 0, error: null, live: false });
    if (!deploymentId) return;
    const abort = new AbortController();
    let afterSeq = -1;
    let count = 0;
    let done = false;
    let liveUp = false;
    let fetching = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const push = (lines: readonly DeployLogLine[]) => {
      if (!lines.length) return;
      buffer.pushMany(lines.map(toLogInput));
      count += lines.length;
      afterSeq = nextSeq(afterSeq, lines);
    };
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!done && !abort.signal.aborted) timer = setTimeout(() => void page(), ms);
    };

    // One page at a time; a request while one runs is folded into a second run.
    const page = async (): Promise<void> => {
      if (fetching) {
        again = true;
        return;
      }
      fetching = true;
      try {
        const res = await client.call(deployments.log, { serviceId, deploymentId, afterSeq, limit: pageSize }, { signal: abort.signal });
        if (abort.signal.aborted) return;
        push(res.lines);
        done = res.done;
        setState({ done, lines: count, error: null, live: liveUp });
        // A full page means more is waiting: ask again right away.
        if (res.lines.length >= pageSize) again = true;
        schedule(liveUp ? livePollMs : pollMs);
      } catch (error) {
        if (abort.signal.aborted) return;
        setState((s) => ({ ...s, error }));
        schedule(pollMs * 5);
      } finally {
        fetching = false;
        if (again && !abort.signal.aborted && !done) {
          again = false;
          void page();
        }
      }
    };

    const onSignal = (signal: LiveSignal) => {
      if (abort.signal.aborted) return;
      if (signal.type === "subscribed") {
        liveUp = true;
        // Anything written before the subscription took effect comes from a page.
        void page();
      } else if (signal.type === "down") {
        liveUp = false;
        setState((s) => ({ ...s, live: false }));
        schedule(pollMs);
      } else if (signal.event.type === "log") {
        // While a page is in flight its answer may overlap; the page ends with a re-check.
        if (fetching) {
          again = true;
          return;
        }
        const { fresh, gap } = freshLines(afterSeq, signal.event.lines);
        if (gap) return void page();
        push(fresh);
        if (fresh.length) setState({ done, lines: count, error: null, live: true });
      } else if (signal.event.type === "deployment") {
        applyDeployment(cache, signal.event.deployment);
        // A finished deployment also finishes its log: one page reads the end and "done". While it
        // runs, its lines come as "log" events; the deployment event comes every 400 ms then.
        if (!isActiveDeployment(signal.event.deployment.status)) void page();
      } else if (signal.event.type === "invalidate") {
        void page();
      }
    };

    const topic: LiveTopic = `deployment:${deploymentId}`;
    const stop = live.listen(topic, onSignal);
    void page();
    return () => {
      abort.abort();
      clearTimeout(timer);
      stop();
    };
  }, [client, cache, serviceId, deploymentId, buffer]);

  return state;
}

/** All kept lines as plain text, for Copy and Download. */
export function bufferText(buffer: LogBuffer): string {
  const out: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.at(i);
    if (line) out.push(line.source ? `${line.source}\t${line.plain}` : line.plain);
  }
  return out.join("\n");
}

/** Saves text as a file through a temporary link. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
