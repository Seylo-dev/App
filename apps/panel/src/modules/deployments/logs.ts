// Build and deploy log lines of a deployment. Builder output arrives as
// raw chunks (partial lines, ANSI escapes); a LineSplitter turns it into
// lines. Lines are capped per deployment so a chatty build cannot fill
// panel.db; screens are told to refetch at most a few times a second.

import { and, desc, eq, gt } from "drizzle-orm";
import { type DeployStepKey, deploymentLogs } from "../../db/schema";
import type { Deps } from "../../deps";
import { publishDeploymentEvent } from "./store";

/** Most lines kept per deployment; later lines are dropped with one notice. */
export const maxLinesPerDeployment = 20_000;
/** Longest stored line; longer ones are cut. */
export const maxLineLength = 4000;
const publishEveryMs = 400;

type LogDeps = Pick<Deps, "db" | "live">;

const nextSeq = new WeakMap<object, Map<string, number>>();
const pendingPublish = new WeakMap<object, Map<string, ReturnType<typeof setTimeout>>>();

function seqFor(deps: Pick<Deps, "db">, deploymentId: string): number {
  let map = nextSeq.get(deps.db);
  if (!map) {
    map = new Map();
    nextSeq.set(deps.db, map);
  }
  let seq = map.get(deploymentId);
  if (seq === undefined) {
    const last = deps.db
      .select({ seq: deploymentLogs.seq })
      .from(deploymentLogs)
      .where(eq(deploymentLogs.deploymentId, deploymentId))
      .orderBy(desc(deploymentLogs.seq))
      .limit(1)
      .get();
    seq = last ? last.seq + 1 : 0;
  }
  map.set(deploymentId, seq + 1);
  return seq;
}

/**
 * Appends lines (already split) to a deployment's log and sends them to
 * the deployment's live topic right away.
 */
export function appendLog(
  deps: LogDeps,
  serviceId: string,
  deploymentId: string,
  step: DeployStepKey,
  lines: readonly string[],
  error = false,
): void {
  if (lines.length === 0) return;
  publishLog(deps, serviceId, deploymentId, writeLog(deps, deploymentId, step, lines, error));
}

/** Lines stored by writeLog, for publishLog. */
export type WrittenLines = { seq: number; ts: string; step: DeployStepKey; text: string; error: boolean }[];

/**
 * The storing half of appendLog, for a caller inside a transaction: it
 * calls publishLog with the result once the transaction committed, so no
 * tab is told of lines a rollback takes back.
 */
export function writeLog(
  deps: Pick<Deps, "db">,
  deploymentId: string,
  step: DeployStepKey,
  lines: readonly string[],
  error = false,
): WrittenLines {
  const ts = new Date();
  const sent: WrittenLines = [];
  for (const text of lines) {
    const seq = seqFor(deps, deploymentId);
    if (seq > maxLinesPerDeployment) continue;
    const line =
      seq === maxLinesPerDeployment
        ? `Log limit of ${maxLinesPerDeployment} lines reached; later output is not kept.`
        : text.slice(0, maxLineLength);
    deps.db.insert(deploymentLogs).values({ deploymentId, seq, ts, step, text: line, error }).onConflictDoNothing().run();
    sent.push({ seq, ts: ts.toISOString(), step, text: line, error });
  }
  return sent;
}

/** The publishing half of appendLog: the lines to the deployment's topic now, its state soon after. */
export function publishLog(deps: LogDeps, serviceId: string, deploymentId: string, sent: WrittenLines): void {
  if (sent.length > 0) deps.live.publish(`deployment:${deploymentId}`, { type: "log", lines: sent });
  schedulePublish(deps, serviceId, deploymentId);
}

function schedulePublish(deps: LogDeps, serviceId: string, deploymentId: string): void {
  let map = pendingPublish.get(deps.db);
  if (!map) {
    map = new Map();
    pendingPublish.set(deps.db, map);
  }
  if (map.has(deploymentId)) return;
  const timer = setTimeout(() => {
    map.delete(deploymentId);
    try {
      publishDeploymentEvent(deps, serviceId, deploymentId);
    } catch {
      // The panel shut down (or a test closed its database) before the hint went out.
    }
  }, publishEveryMs);
  // Never keep the process (or a test) alive for a refetch hint.
  (timer as { unref?: () => void }).unref?.();
  map.set(deploymentId, timer);
}

export function readLog(deps: Pick<Deps, "db">, deploymentId: string, afterSeq: number, limit: number) {
  return deps.db
    .select()
    .from(deploymentLogs)
    .where(and(eq(deploymentLogs.deploymentId, deploymentId), gt(deploymentLogs.seq, afterSeq)))
    .orderBy(deploymentLogs.seq)
    .limit(limit)
    .all();
}

/** Splits a byte stream into lines; keeps the unfinished tail for the next chunk. */
export class LineSplitter {
  private tail = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array | string): string[] {
    const text = this.tail + (typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true }));
    // Progress bars redraw with \r; keep only the last state of such a line.
    const parts = text.split("\n");
    this.tail = parts.pop() ?? "";
    return parts.map((line) => lastSegment(line.replace(/\r$/, "")));
  }

  flush(): string[] {
    const rest = this.tail + this.decoder.decode();
    this.tail = "";
    return rest === "" ? [] : [lastSegment(rest)];
  }
}

function lastSegment(line: string): string {
  const i = line.lastIndexOf("\r");
  return i === -1 ? line : line.slice(i + 1);
}
