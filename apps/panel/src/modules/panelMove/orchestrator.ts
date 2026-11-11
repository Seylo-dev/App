// The move itself, run by the old panel in the background (not a job: the
// job runner is held while it runs, and its rows are in the database being
// copied). The steps, with the agent calls of panel_move.proto:
//
//   pausing    the write pause (pause.ts) and the job runner held; jobs and
//              changes in flight finish first
//   registry   ExportRegistry on the panel's node piped into
//              ImportRegistry on the target (staged there)
//   snapshot   consistent copies of the databases, edited for the target,
//              the panel service's spec from the edited copy, an archive
//              with a manifest (snapshot.ts)
//   shipping   ImportPanelData on the target (staged, checked against the
//              manifest)
//   starting   StartMovedPanel: the target starts the moved panel, waits
//              until it is healthy and checks it presents the agents' TLS
//              key every node pins
//   staging    StagePanelAddress on every node that follows, then on nodes
//              left behind that came back meanwhile: the address it
//              switches to once this panel goes away (probed first: the
//              panel there must answer as the moved copy of this move)
//   committing CommitMovedPanel on the target: the switch. Until it, the
//              moved panel answers agents with 503, so a node that dials it
//              early comes back here; from its answer on the moved panel
//              takes agents and nothing undoes the move. An answer that
//              never comes (a timeout, the target away) is no answer: it is
//              sent again every few seconds while this panel stays
//              read-only and keeps every node, and after each miss the
//              panel looks at the moved panel's address itself (probe.ts):
//              when that shows the switch landed (the commit marker, or the
//              moved panel took its first agent), the move goes on. Only a
//              definite refusal ("notStarted") or, after 10 minutes, a
//              cancel with force undoes the move, and a forced cancel the
//              target answers with "committed" (or whose moved panel shows
//              the switch) goes on with the switch instead.
//   switching  agents' connects answer 503, every session but the panel
//              node's own closes, RetirePanel stops this panel
//
// A failure (or panelMove.cancel) before the commit undoes everything:
// AbortMovedPanel on the target, ClearPanelAddress on every node staged so
// far, the target's desired state released, then writes resume. Calls that
// fail because a node is away are kept in panelMoveCleanups and finished
// when it is back (cleanup.ts).
//
// panelMoveOut in this panel's own database (the offline edit drops it from
// the copy, so the moved panel never sees it) records how far the move got,
// for a restart in the middle (recover.ts).

import { createReadStream, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import { OpError, type panelMove } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { agentRefusalOf } from "../../agent-hub/calls";
import { dialedUrlOf, dialsLoopback, dialsPlainHttp } from "../../agent-hub/dialed";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { newId } from "../../ids";
import { deleteSetting, setSetting } from "../../settings";
import { urlHost } from "../domains/lookup";
import { panelServiceId } from "../nodes/panel-service";
import { panelPortOf } from "../settings/ip-access";
import { writeMoveAudit } from "./audit";
import { addCleanup, refusedAsCommitted } from "./cleanup";
import type { PanelMoveFailure, PanelMoveOut, PanelMoveOutPhase } from "./keys";
import { setWritePause, writesSettled } from "./pause";
import { type MovedPanelSeen, movedPanelProbe, tookTheSwitch } from "./probe";
import { bytesNeeded, dataFiles, editSnapshot, freeBytes, type ManifestEntry, panelSpecFromCopy, writeArchive } from "./snapshot";
import { activeMove, canForceCancel, type RunningMove, setActiveMove } from "./state";

/** How long jobs in flight may take to finish before the move gives up. */
export const holdTimeoutMs = 2 * 60_000;
/** The moved panel's health wait on the target (StartMovedPanel.health_timeout). */
export const healthTimeoutMs = 3 * 60_000;
/** The panel's own wait for StartMovedPanel: the health wait, the pull and the checks. */
/** The agent pulls the image, starts the panel (up to 3 minutes healthy) and checks the pin and version: room for a slow pull. */
export const startTimeoutMs = 8 * 60_000;
/** StagePanelAddress probes with a 10 s dial. */
const stageTimeoutMs = 30_000;
/** One CommitMovedPanel; the agent answers at once (it writes a journal and a marker file). */
const commitTimeoutMs = 30_000;
const abortTimeoutMs = 2 * 60_000;
const clearTimeoutMs = 30_000;
const retireTimeoutMs = 30_000;
const retireAttempts = 3;
/** Progress events at most this often while bytes move. */
const progressEveryMs = 500;

/** Timings tests shorten. */
export const moveTiming = {
  /** How long changes that passed the gate (ops, webhooks) may take to finish before the move gives up. */
  writesTimeoutMs: 2 * 60_000,
  /** The pause between two CommitMovedPanel calls that got no answer. */
  commitRetryMs: 5_000,
};

const stepOrder: panelMove.PanelMoveStep[] = ["pausing", "registry", "snapshot", "shipping", "starting", "staging", "switching"];

export interface MovePlan {
  targetNodeId: string;
  targetNodeName: string;
  address: string;
  fromNodeId: string;
  fromNodeName: string;
  domain: string | null;
  follow: string[];
  leftBehind: { id: string; name: string }[];
  by: string;
}

/** Thrown inside the move: the message is for the owner, as it is. */
class MoveFailure extends Error {}

/** The address nodes stage for the target: loopback on the target itself, the address everywhere else. */
export function stagedUrl(move: Pick<RunningMove, "targetNodeId" | "address">, nodeId: string, agentPort: number): string {
  return nodeId === move.targetNodeId ? `https://127.0.0.1:${agentPort}` : `https://${urlHost(move.address)}:${agentPort}`;
}

/** Where people reach the moved panel on IP:port. */
export function newIpUrl(deps: Pick<Deps, "db" | "config">, address: string): string {
  return `http://${urlHost(address)}:${panelPortOf(deps)}`;
}

/** Tells every open screen that the move's status changed. */
export function publishStatus(deps: Pick<Deps, "live">): void {
  deps.live.publish("panel", { type: "invalidate", ops: ["panelMove.status", "panelMove.check"] });
}

/** Starts a move whose checks passed; answers at once, the steps run in the background. */
export function beginMove(deps: Deps, plan: MovePlan): RunningMove {
  if (activeMove(deps.db)) throw new OpError("CONFLICT", "The panel is moving already.", { reason: "moveRunning" });
  const move: RunningMove = {
    moveId: newId(),
    targetNodeId: plan.targetNodeId,
    targetNodeName: plan.targetNodeName,
    address: plan.address,
    fromNodeId: plan.fromNodeId,
    fromNodeName: plan.fromNodeName,
    domain: plan.domain,
    follow: plan.follow,
    leftBehind: plan.leftBehind,
    startedAt: Date.now(),
    step: "pausing",
    bytesDone: 0,
    bytesTotal: 0,
    abort: new AbortController(),
    committing: false,
    waitingSince: null,
    seen: null,
    switching: false,
    staged: new Set(),
    doneAt: null,
    oldPanelRunning: false,
    by: plan.by,
  };
  setActiveMove(deps.db, move);
  deleteSetting(deps.db, "panelMoveFailure");
  // Before anything else: the very next op must find the panel read-only.
  setWritePause(deps.db, { reason: "moving", targetName: move.targetNodeName, agentsClosed: false });
  publishStatus(deps);
  deps.logger.info({ moveId: move.moveId, to: move.targetNodeId, address: move.address }, "moving the panel");
  void runMove(deps, move).catch((error) => deps.logger.error({ err: error, moveId: move.moveId }, "the panel move ended badly"));
  return move;
}

/**
 * After a restart of this panel with the commit sent (recover.ts): the
 * panel is read-only again, the job runner and the target's desired state
 * are held again, and CommitMovedPanel goes out until the target answers,
 * then the switch, as if the panel never stopped.
 */
export function resumeCommit(deps: Deps, out: PanelMoveOut): RunningMove {
  const move: RunningMove = {
    moveId: out.moveId,
    targetNodeId: out.targetNodeId,
    targetNodeName: out.targetNodeName,
    address: out.address,
    fromNodeId: out.fromNodeId,
    fromNodeName: out.fromNodeName,
    domain: out.domain,
    follow: out.staged.filter((id) => !out.leftBehind.includes(id)),
    leftBehind: out.leftBehind.map((id) => ({ id, name: nodeName(deps, id) })),
    startedAt: out.startedAt,
    step: "switching",
    bytesDone: 0,
    bytesTotal: 0,
    abort: new AbortController(),
    committing: true,
    waitingSince: out.waitingSince ?? null,
    seen: null,
    switching: false,
    staged: new Set(out.staged),
    doneAt: null,
    oldPanelRunning: false,
    by: out.by ?? "the owner",
  };
  setActiveMove(deps.db, move);
  setWritePause(deps.db, { reason: "moving", targetName: move.targetNodeName, agentsClosed: false });
  // Before the target reconnects: its first full sync from here would drop the moved panel's spec.
  move.releaseTarget = deps.agents.desired.hold(move.targetNodeId);
  // Nothing runs yet at start, so this resolves at once; the main start then starts a held runner.
  if (deps.jobControl) void deps.jobControl.hold();
  deps.logger.warn({ moveId: move.moveId, to: move.targetNodeId }, "the panel restarted during a move's switch; sending it again");
  void commitAndSwitch(deps, move, deps.jobControl !== undefined).catch((error) =>
    deps.logger.error({ err: error, moveId: move.moveId }, "the panel move ended badly"),
  );
  return move;
}

/**
 * panelMove.cancel: stops what runs; the move undoes the rest. Once the
 * commit was sent only with force, after the target left it unconfirmed for
 * 10 minutes (canForceCancel); false when the cancel was not taken.
 */
export function cancelMove(move: RunningMove, by: string, force = false): boolean {
  if (move.switching || move.abort.signal.aborted) return false;
  if (move.committing) {
    if (!force || !canForceCancel(move)) return false;
    move.abort.abort(new MoveFailure(`Cancelled with force by ${by}: ${move.targetNodeName} never confirmed the switch.`));
    return true;
  }
  move.abort.abort(new MoveFailure(`Cancelled by ${by}.`));
  return true;
}

function setStep(deps: Deps, move: RunningMove, step: panelMove.PanelMoveStep): void {
  move.step = step;
  move.bytesDone = 0;
  move.bytesTotal = 0;
  publishStatus(deps);
}

/** Progress events for bytes, at most every progressEveryMs. */
function progress(deps: Deps, move: RunningMove): (bytes: number) => void {
  let last = 0;
  return (bytes) => {
    move.bytesDone += bytes;
    const now = performance.now();
    if (now - last < progressEveryMs) return;
    last = now;
    publishStatus(deps);
  };
}

function cancelled(move: RunningMove): void {
  if (move.abort.signal.aborted) throw move.abort.signal.reason ?? new MoveFailure("Cancelled.");
}

/** `promise`, or a MoveFailure after `ms` or once the move was cancelled. */
async function within<T>(promise: Promise<T>, ms: number, signal: AbortSignal, timedOut: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new MoveFailure(timedOut)), ms);
        onAbort = () => reject(signal.reason ?? new MoveFailure("Cancelled."));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Waits `ms`, or less once the move was cancelled. */
async function sleepUnlessCancelled(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function nodeName(deps: Pick<Deps, "db">, nodeId: string): string {
  return deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? nodeId;
}

function writeOut(deps: Deps, move: RunningMove, phase: PanelMoveOutPhase, extra: Partial<PanelMoveOut> = {}): void {
  const out: PanelMoveOut = {
    moveId: move.moveId,
    targetNodeId: move.targetNodeId,
    targetNodeName: move.targetNodeName,
    address: move.address,
    fromNodeId: move.fromNodeId,
    fromNodeName: move.fromNodeName,
    phase,
    staged: [...move.staged],
    leftBehind: move.leftBehind.map((node) => node.id),
    domain: move.domain,
    startedAt: move.startedAt,
    at: Date.now(),
    by: move.by,
    ...(move.waitingSince !== null ? { waitingSince: move.waitingSince } : {}),
    ...(move.oldPanelRunning ? { oldPanelRunning: true } : {}),
    ...extra,
  };
  setSetting(deps.db, "panelMoveOut", out);
}

/** Words for a failure: the panel's own messages, an agent's (safe to show), else something plain. */
function failureMessage(error: unknown): string {
  if (error instanceof MoveFailure || error instanceof OpError) return error.message;
  return "Something went wrong on the panel. The panel log has the details.";
}

async function runMove(deps: Deps, move: RunningMove): Promise<void> {
  const log = deps.logger.child({ component: "panel-move", moveId: move.moveId });
  const signal = move.abort.signal;
  let held = false;
  let workDir: string | null = null;
  try {
    // ---- pausing
    if (deps.jobControl) {
      held = true;
      await within(deps.jobControl.hold(), holdTimeoutMs, signal, "Jobs that were running did not finish within 2 minutes. Try again.");
    }
    // Ops and webhooks that passed the gate a moment ago may still write: the copy must have their rows.
    await within(
      writesSettled(deps.db),
      moveTiming.writesTimeoutMs,
      signal,
      "Changes that were being saved when the move started did not finish in time. Try again.",
    );
    // Desired-state sends in flight write revisions: let them land before the copy.
    await within(deps.agents.desired.settled(), 30_000, signal, "The panel could not finish sending desired state to the nodes.");
    cancelled(move);

    // ---- registry: from here the target may hold staged data, which the old panel must clean up even
    // after a restart. The journal is in this database; the offline edit drops it from the copy.
    writeOut(deps, move, "registry");
    setStep(deps, move, "registry");
    await relayRegistry(deps, move);
    cancelled(move);

    // ---- snapshot
    setStep(deps, move, "snapshot");
    const pin = deps.agentTls?.pin;
    const agentPort = deps.agentTls?.port;
    if (!pin || !agentPort || !deps.databases)
      throw new MoveFailure("The panel has no agents' TLS port, so nodes could not find it at its new address.");
    const dataDir = deps.config.dataDir;
    const files = dataFiles(dataDir);
    if (!files.some((file) => file.path === "master.key")) throw new MoveFailure("The panel's data folder has no master.key to move.");
    if (!files.some((file) => file.path === "agent-tls.key")) {
      throw new MoveFailure("The panel's data folder has no agents' TLS key, so nodes could not trust the moved panel.");
    }
    workDir = join(dataDir, `.move-${move.moveId}`);
    mkdirSync(workDir, { mode: 0o700 });
    const needed = bytesNeeded(dataDir, files);
    const free = freeBytes(workDir);
    if (free !== null && free < needed) {
      throw new MoveFailure(
        `${move.fromNodeName} has ${Math.floor(free / 1048576)} MB free; the copy needs about ${Math.ceil(needed / 1048576)} MB. Free some disk space and try again.`,
      );
    }
    const copies = deps.databases.snapshotTo(workDir);
    const now = Date.now();
    const generation = editSnapshot(copies.panel, {
      moveId: move.moveId,
      fromNodeId: move.fromNodeId,
      fromNodeName: move.fromNodeName,
      toNodeId: move.targetNodeId,
      toNodeName: move.targetNodeName,
      address: move.address,
      leftBehind: move.leftBehind.map((node) => node.id),
      domain: move.domain,
      startedAt: move.startedAt,
      now,
    });
    const spec = panelSpecFromCopy(copies.panel, {
      nodeId: move.targetNodeId,
      secrets: deps.secrets,
      contributors: deps.agents.desired.contributors(),
    });
    const archive = join(workDir, "panel-data.tar.gz");
    const manifest = await writeArchive(
      [{ path: "panel.db", from: copies.panel }, { path: "metrics.db", from: copies.metrics }, ...files],
      archive,
    );
    // The copies are in the archive; they hold every sealed secret, so they go now.
    rmSync(copies.panel, { force: true });
    rmSync(copies.metrics, { force: true });
    log.info({ files: manifest.length, generation }, "made the copy of the panel");
    cancelled(move);

    // ---- shipping
    writeOut(deps, move, "shipping");
    setStep(deps, move, "shipping");
    await ship(deps, move, archive, manifest);
    rmSync(archive, { force: true });
    cancelled(move);

    // ---- starting
    writeOut(deps, move, "starting");
    setStep(deps, move, "starting");
    // From here this panel must send the target nothing: its desired state (where the target is not the
    // panel node) would drop the panel spec StartMovedPanel installs. Released on an abort; after the
    // switch this panel is gone.
    move.releaseTarget = deps.agents.desired.hold(move.targetNodeId);
    const started = await deps.agents.call(
      move.targetNodeId,
      "startMovedPanel",
      {
        moveId: move.moveId,
        spec,
        panelPin: pin,
        agentTlsPort: agentPort,
        hostPort: panelPortOf(deps),
        expectedVersion: deps.config.version,
        healthTimeout: durationFromMs(healthTimeoutMs),
      },
      { timeoutMs: startTimeoutMs, signal },
    );
    if (started.version !== deps.config.version) {
      throw new MoveFailure(`The moved panel answers as version ${started.version || "unknown"}, this one is ${deps.config.version}.`);
    }
    cancelled(move);

    // ---- staging: the journal names every node first, since a call that fails may have staged it anyway.
    // The target first: it reaches the moved panel on loopback, so a failure there says the most.
    const order = [move.targetNodeId, ...move.follow.filter((id) => id !== move.targetNodeId)];
    for (const nodeId of order) move.staged.add(nodeId);
    writeOut(deps, move, "staging");
    setStep(deps, move, "staging");
    await stageAll(deps, move, order, pin, agentPort);
    cancelled(move);
    await stageLateNodes(deps, move, pin, agentPort);
    cancelled(move);
  } catch (error) {
    await abortMove(deps, move, error, held, log);
    return;
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }
  await commitAndSwitch(deps, move, held);
}

/** Committing and switching: from a running move, or after a restart in the committing phase (resumeCommit). */
async function commitAndSwitch(deps: Deps, move: RunningMove, held: boolean): Promise<void> {
  const log = deps.logger.child({ component: "panel-move", moveId: move.moveId });
  try {
    // ---- committing: written before the first call, since any call may land
    move.committing = true;
    writeOut(deps, move, "committing");
    setStep(deps, move, "switching");
    await commit(deps, move, log);
  } catch (error) {
    await abortMove(deps, move, error, held, log);
    return;
  }
  // A cancel that came while the moved panel showed the switch is too late for it.
  await switchOver(deps, move, log, move.abort.signal.aborted ? failureMessage(move.abort.signal.reason) : undefined);
}

/**
 * Switching, once the target took the switch: no way back from here.
 * `undoSkipped` is the cancel or failure that came after the target had
 * taken it, for the audit row.
 */
async function switchOver(deps: Deps, move: RunningMove, log: Deps["logger"], undoSkipped?: string): Promise<void> {
  try {
    move.switching = true;
    writeOut(deps, move, "switching");
    setWritePause(deps.db, { reason: "moving", targetName: move.targetNodeName, agentsClosed: true });
    publishStatus(deps);
    for (const nodeId of deps.agents.onlineNodeIds()) {
      if (nodeId !== move.fromNodeId) deps.agents.reconnect(nodeId, "The panel moved to another server: connecting to its new address.");
    }
    const retired = await retire(deps, move);
    if (!retired) {
      // This node must reach the moved panel too: without its own connection here it dials the staged address.
      deps.agents.reconnect(move.fromNodeId, "The panel moved to another server: connecting to its new address.");
    }
    move.oldPanelRunning = !retired;
    finishSwitch(deps, move, undoSkipped);
    log.info({ to: move.targetNodeId, retired }, "the panel moved; this copy is retired");
  } catch (error) {
    // Some nodes may be on the moved panel already: this copy stays retired whatever failed.
    log.error({ err: error }, "the switch to the moved panel failed half way; this copy stays retired");
    move.oldPanelRunning = true;
    finishSwitch(deps, move, undoSkipped);
  }
}

/**
 * The target refused the switch for sure, so nothing was committed there:
 * it runs no healthy moved panel of this move ("notStarted"), the request
 * was refused as it is, or its agent does not know the call. Anything else
 * (a timeout, the target away, an error half way) may have landed.
 */
function refusedForSure(error: unknown): boolean {
  if (error instanceof OpError && error.details?.reason === "capability") return true;
  const refusal = agentRefusalOf(error);
  if (!refusal) return false;
  if (refusal.status === "FAILED_PRECONDITION") return refusal.reason === "notStarted";
  return refusal.status === "INVALID_ARGUMENT" || refusal.status === "UNIMPLEMENTED";
}

/** Where nodes other than the target reach the moved panel, on the agents' TLS port. */
function movedPanelUrl(move: Pick<RunningMove, "address">, agentPort: number): string {
  return `https://${urlHost(move.address)}:${agentPort}`;
}

/**
 * Looks at the moved panel's address over the agents' pinned key (probe.ts).
 * What it found is kept on the move for the status, unless it found the
 * switch there, which ends the wait anyway.
 */
async function lookAtMovedPanel(deps: Deps, move: RunningMove, log: Deps["logger"]): Promise<MovedPanelSeen> {
  const pin = deps.agentTls?.pin;
  const agentPort = deps.agentTls?.port;
  let seen: MovedPanelSeen = "noAnswer";
  if (pin && agentPort) {
    try {
      seen = await movedPanelProbe.see(movedPanelUrl(move, agentPort), pin, move.moveId);
    } catch (error) {
      log.warn({ err: error }, "looking at the moved panel failed");
    }
  }
  if (seen === "standby" || seen === "noAnswer") move.seen = seen;
  return seen;
}

/**
 * CommitMovedPanel until the target answers it, or until the moved panel
 * shows it took the switch (an answer lost while the target was away for
 * 10 s can move the target onto it for good); a definite refusal or a
 * forced cancel throws.
 */
async function commit(deps: Deps, move: RunningMove, log: Deps["logger"]): Promise<void> {
  const signal = move.abort.signal;
  let forceable = false;
  let recorded = move.waitingSince !== null;
  // Failures of this panel's own (a busy or full database, say) are no answer from the target: the wait goes on.
  const tell = () => {
    try {
      publishStatus(deps);
    } catch (failed) {
      log.error({ err: failed }, "telling screens about the wait for the switch failed");
    }
  };
  for (;;) {
    cancelled(move);
    try {
      await deps.agents.call(move.targetNodeId, "commitMovedPanel", { moveId: move.moveId }, { timeoutMs: commitTimeoutMs, signal });
      if (move.waitingSince !== null) log.info({ nodeId: move.targetNodeId }, "the target confirmed the switch after all");
      return;
    } catch (error) {
      cancelled(move);
      if (refusedForSure(error)) {
        throw new MoveFailure(`${move.targetNodeName} did not take the switch: ${failureMessage(error).replace(/\.$/, "")}.`);
      }
      log.warn({ err: error, nodeId: move.targetNodeId }, "the target did not confirm the switch; asking again");
      const first = move.waitingSince === null;
      if (first) move.waitingSince = Date.now();
      if (!recorded) {
        try {
          writeOut(deps, move, "committing");
          recorded = true;
        } catch (failed) {
          log.error({ err: failed }, "recording the wait for the switch failed");
        }
      }
      if (first) tell();
      const before = move.seen;
      const seen = await lookAtMovedPanel(deps, move, log);
      if (tookTheSwitch(seen)) {
        log.warn({ nodeId: move.targetNodeId, seen }, "the target did not answer the switch, but the moved panel shows it took it");
        return;
      }
      cancelled(move);
      if (move.seen !== before || forceable !== canForceCancel(move)) {
        forceable = canForceCancel(move);
        tell();
      }
    }
    await sleepUnlessCancelled(moveTiming.commitRetryMs, signal);
  }
}

/** What the status says while the target leaves the switch unconfirmed: what the panel saw at the moved panel. */
export function waitingMessage(move: Pick<RunningMove, "targetNodeName" | "address" | "seen">): string {
  const unconfirmed = `${move.targetNodeName} has not confirmed the switch`;
  if (move.seen === "standby") {
    return `${unconfirmed}. The moved panel at ${move.address} answers and still waits for it, so no node is on it.`;
  }
  if (move.seen === "noAnswer") return `${unconfirmed}, and the panel gets no answer from the moved panel at ${move.address} either.`;
  return `${unconfirmed}. The panel is looking at the moved panel at ${move.address}.`;
}

function finishSwitch(deps: Deps, move: RunningMove, undoSkipped?: string): void {
  move.doneAt = Date.now();
  try {
    writeOut(deps, move, "moved");
  } catch (error) {
    deps.logger.error({ err: error, moveId: move.moveId }, "recording the finished move failed");
  }
  setWritePause(deps.db, {
    reason: "moved",
    targetName: move.targetNodeName,
    newUrl: move.domain ? `https://${move.domain}` : newIpUrl(deps, move.address),
    agentsClosed: true,
  });
  writeMoveAudit(deps, "panelMove.switched", {
    moveId: move.moveId,
    to: move.targetNodeId,
    address: move.address,
    leftBehind: move.leftBehind.map((node) => node.id),
    oldPanelRunning: move.oldPanelRunning,
    by: move.by,
    ...(undoSkipped ? { undoSkipped } : {}),
  });
  publishStatus(deps);
}

/** ExportRegistry piped into ImportRegistry; the byte counts must agree. */
async function relayRegistry(deps: Deps, move: RunningMove): Promise<void> {
  const signal = move.abort.signal;
  const exported = deps.agents.openRaw(move.fromNodeId, "exportRegistry", { moveId: move.moveId }, { signal, initialWindow: 1 << 20 });
  const imported = deps.agents.openRaw(move.targetNodeId, "importRegistry", { moveId: move.moveId, sizeBytes: 0n }, { signal });
  const count = progress(deps, move);
  let relayed = 0;
  try {
    for await (const chunk of exported.body) {
      await imported.writer.write(chunk);
      relayed += chunk.length;
      count(chunk.length);
    }
    imported.writer.end();
    const [sent, received] = await Promise.all([exported.response, imported.response]);
    const got = Number(received.sizeBytes);
    // The target counts what it received; an older count of what it unpacked matches the export's.
    if (got !== relayed && got !== Number(sent.sizeBytes)) {
      throw new MoveFailure(`${move.targetNodeName} received ${got} bytes of the image registry, the panel relayed ${relayed}.`);
    }
  } catch (error) {
    exported.cancel("the panel move failed");
    imported.cancel("the panel move failed");
    throw error;
  }
}

/** ImportPanelData with the archive; the target checks every file against the manifest. */
async function ship(deps: Deps, move: RunningMove, archive: string, manifest: readonly ManifestEntry[]): Promise<void> {
  const size = statSync(archive).size;
  move.bytesTotal = size;
  // At 256 KiB/s the slowest link still fits; a stalled target ends the move instead of holding it forever.
  const timeoutMs = 10 * 60_000 + Math.ceil(size / (256 * 1024)) * 1000;
  const stream = deps.agents.openRaw(
    move.targetNodeId,
    "importPanelData",
    {
      moveId: move.moveId,
      sizeBytes: BigInt(size),
      manifest: manifest.map((entry) => ({ path: entry.path, size: BigInt(entry.size), sha256: entry.sha256 })),
    },
    { signal: move.abort.signal, timeoutMs },
  );
  const count = progress(deps, move);
  try {
    for await (const chunk of createReadStream(archive, { highWaterMark: 256 << 10 })) {
      const bytes = chunk as Buffer;
      await stream.writer.write(bytes);
      count(bytes.length);
    }
    stream.writer.end();
    const done = await stream.response;
    if (Number(done.sizeBytes) !== size) {
      throw new MoveFailure(`${move.targetNodeName} received ${Number(done.sizeBytes)} bytes of the panel's data, the panel sent ${size}.`);
    }
    if (done.files !== manifest.length) {
      throw new MoveFailure(`${move.targetNodeName} unpacked ${done.files} files of the panel's data, the panel sent ${manifest.length}.`);
    }
  } catch (error) {
    stream.cancel("the panel move failed");
    throw error;
  }
}

async function stageOne(deps: Deps, move: RunningMove, nodeId: string, pin: string, agentPort: number, timeoutMs: number): Promise<void> {
  // Recorded first: a call that times out here may still have staged it there, and clearing is harmless.
  move.staged.add(nodeId);
  await deps.agents.call(
    nodeId,
    "stagePanelAddress",
    { moveId: move.moveId, panelUrl: stagedUrl(move, nodeId, agentPort), panelPin: pin, probe: true },
    { timeoutMs, signal: move.abort.signal },
  );
}

/** Every node that follows gets the new address, the target first; one that cannot ends the move, by name. */
async function stageAll(deps: Deps, move: RunningMove, order: readonly string[], pin: string, agentPort: number): Promise<void> {
  const results = await Promise.allSettled(order.map((nodeId) => stageOne(deps, move, nodeId, pin, agentPort, stageTimeoutMs)));
  const failed = results.findIndex((result) => result.status === "rejected");
  if (failed < 0) return;
  const nodeId = order[failed] as string;
  const reason = (results[failed] as PromiseRejectedResult).reason;
  if (move.abort.signal.aborted) throw move.abort.signal.reason ?? reason;
  throw new MoveFailure(
    `${nodeName(deps, nodeId)} could not reach the moved panel at ${stagedUrl(move, nodeId, agentPort)}: ${failureMessage(reason).replace(/\.$/, "")}. Open the agents' port ${agentPort} on ${move.targetNodeName} to that node (a firewall or cloud security group), or move to another address.`,
  );
}

/**
 * Nodes left behind that came back during the move: told the new address
 * too when they can take it, so they follow after all. Best effort: one
 * that cannot stays left behind, as the owner accepted (and is cleared too
 * if the move is undone, since its call may have landed).
 */
async function stageLateNodes(deps: Deps, move: RunningMove, pin: string, agentPort: number): Promise<void> {
  const late = move.leftBehind.filter((node) => {
    if (!deps.agents.isOnline(node.id) || !deps.agents.supports(node.id, "stagePanelAddress")) return false;
    const url = dialedUrlOf(deps, node.id);
    return !(dialsPlainHttp(url) && !dialsLoopback(url));
  });
  if (late.length === 0) return;
  for (const node of late) move.staged.add(node.id);
  writeOut(deps, move, "staging");
  await Promise.all(
    late.map(async (node) => {
      try {
        await stageOne(deps, move, node.id, pin, agentPort, 10_000);
        move.leftBehind = move.leftBehind.filter((other) => other.id !== node.id);
      } catch (error) {
        deps.logger.info({ err: error, nodeId: node.id }, "a node that came back during the move could not take the new address");
      }
    }),
  );
}

/** RetirePanel on the panel's own node: its agent answers, then stops this panel. */
async function retire(deps: Deps, move: RunningMove): Promise<boolean> {
  for (let attempt = 1; attempt <= retireAttempts; attempt++) {
    try {
      await deps.agents.call(
        move.fromNodeId,
        "retirePanel",
        { moveId: move.moveId, serviceId: panelServiceId },
        { timeoutMs: retireTimeoutMs },
      );
      return true;
    } catch (error) {
      deps.logger.warn({ err: error, attempt, nodeId: move.fromNodeId }, "the panel's node did not take RetirePanel");
      if (!deps.agents.isOnline(move.fromNodeId)) return false;
      await Bun.sleep(2000);
    }
  }
  return false;
}

/** AbortMovedPanel on the target: done, refused because it took the switch of this move, or no answer (kept for later). */
async function abortOnTarget(deps: Deps, move: RunningMove, log: Deps["logger"]): Promise<"removed" | "committed" | "unknown"> {
  try {
    await deps.agents.call(move.targetNodeId, "abortMovedPanel", { moveId: move.moveId }, { timeoutMs: abortTimeoutMs });
    return "removed";
  } catch (failure) {
    if (refusedAsCommitted(failure)) return "committed";
    log.warn({ err: failure, nodeId: move.targetNodeId }, "the target did not take AbortMovedPanel; retrying when it is back");
    return "unknown";
  }
}

/**
 * Undoes a move that stopped before the commit, then lets the panel take
 * changes again. A target that took the switch after all (a forced cancel,
 * or a failure here, while its answer was lost) sends the move on with the
 * switch instead: nothing is undone then.
 */
async function abortMove(deps: Deps, move: RunningMove, error: unknown, held: boolean, log: Deps["logger"]): Promise<void> {
  const step = move.step;
  const message = failureMessage(move.abort.signal.aborted && move.abort.signal.reason ? move.abort.signal.reason : error);
  if (!(error instanceof MoveFailure) && !(error instanceof OpError)) log.error({ err: error, step }, "the panel move failed");
  else log.warn({ step, reason: message }, "the panel move failed; undoing it");
  // Whatever still runs (a stream, a call) stops now.
  if (!move.abort.signal.aborted) move.abort.abort(new MoveFailure(message));

  // From the registry step on the target may hold staged data, and from staging on nodes may hold the address.
  const onTarget = stepOrder.indexOf(step) >= stepOrder.indexOf("registry");
  let onTargetAnswer: "removed" | "committed" | "unknown" = "removed";
  if (onTarget && move.committing) {
    // The commit may have landed: the target is asked first, with the journal still at committing, so a
    // restart meanwhile sends the commit again rather than undo a move the target may have switched to.
    onTargetAnswer = await abortOnTarget(deps, move, log);
    // No answer: the moved panel itself may show the switch (the target on it for good, its agent gone from here).
    if (onTargetAnswer === "unknown" && tookTheSwitch(await lookAtMovedPanel(deps, move, log))) onTargetAnswer = "committed";
  }
  if (onTarget && onTargetAnswer !== "committed") {
    // A restart from here finishes the undo (recover.ts), never resumes or retires.
    try {
      writeOut(deps, move, "aborting", { abortStep: step, abortMessage: message });
    } catch (failed) {
      log.error({ err: failed }, "recording the undo of the move failed");
    }
    if (!move.committing) onTargetAnswer = await abortOnTarget(deps, move, log);
  }
  if (onTargetAnswer === "committed") {
    // Its answer is the one the commit waited for: nothing was undone yet, so the switch goes on.
    log.warn({ nodeId: move.targetNodeId, reason: message }, "the target had taken the switch; switching instead of undoing the move");
    await switchOver(deps, move, log, message);
    return;
  }
  const targetCleaned = onTargetAnswer === "removed";
  // The target gets this panel's desired state again (a full sync).
  move.releaseTarget?.();
  move.releaseTarget = undefined;
  const notCleared: string[] = [];
  await Promise.all(
    [...move.staged].map(async (nodeId) => {
      try {
        await deps.agents.call(nodeId, "clearPanelAddress", { moveId: move.moveId }, { timeoutMs: clearTimeoutMs });
        move.staged.delete(nodeId);
      } catch (failure) {
        notCleared.push(nodeId);
        log.warn({ err: failure, nodeId }, "a node did not take ClearPanelAddress; retrying when it is back");
      }
    }),
  );
  if (!targetCleaned || notCleared.length > 0) {
    addCleanup(deps, {
      moveId: move.moveId,
      abortNodeId: targetCleaned ? null : move.targetNodeId,
      clearNodeIds: notCleared,
      at: Date.now(),
    });
  }

  const failure: PanelMoveFailure = {
    moveId: move.moveId,
    targetNodeId: move.targetNodeId,
    targetNodeName: move.targetNodeName,
    address: move.address,
    step,
    message,
    startedAt: move.startedAt,
    at: Date.now(),
  };
  try {
    deleteSetting(deps.db, "panelMoveOut");
    setSetting(deps.db, "panelMoveFailure", failure);
  } catch (failed) {
    log.error({ err: failed }, "recording the failed move failed");
  }
  setActiveMove(deps.db, null);
  setWritePause(deps.db, null);
  if (held) deps.jobControl?.release();
  writeMoveAudit(deps, "panelMove.failed", { moveId: move.moveId, to: move.targetNodeId, step, reason: message, by: move.by }, "CONFLICT");
  publishStatus(deps);
}

/** The step a stored phase stands for, for a failure or a status after a restart. */
export function phaseStep(out: Pick<PanelMoveOut, "phase" | "abortStep">): panelMove.PanelMoveStep {
  switch (out.phase) {
    case "aborting":
      return out.abortStep ?? "staging";
    case "committing":
    case "switching":
    case "moved":
      return "switching";
    default:
      return out.phase;
  }
}
