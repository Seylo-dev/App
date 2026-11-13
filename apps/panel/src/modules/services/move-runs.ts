// Moves to another node whose copy runs in this panel now (move.ts
// moveJob), by deployment id, and when a move may be cancelled.
//
// A move with volumes stops the old copy, copies every volume through the
// panel and only then starts the service on the new node. Cancelling it
// while it copies (deployments.cancel, engine.ts cancelDeployment) does not
// end the deployment itself: it asks the job to stop (cancelMoveRun), the
// job cancels both streams (ExportVolume on the old node, ImportVolume on
// the new one) or its wait for the old copy to stop, and only then ends the
// deployment as cancelled, which puts the service back on the old node and
// starts it there (engine.ts restoreMove). So the old copy never starts
// while the copy still reads it, the new node drops its partial copy once
// nothing writes into it, and nothing is lost: the old node kept its data.
// Once the copy is done and the new node starts it, a cancel could lose
// what the new copy wrote, so it is refused (assertMoveCancellable).

import { OpError } from "@seylo/ops";
import type { PanelDb } from "../../db/client";
import type { DeploymentRow } from "../deployments/store";
import { dataVolumes } from "./insert";
import { nodeNames } from "./rows";

interface MoveRun {
  controller: AbortController;
  /** Resolves once the job is done with the deployment. */
  done: Promise<void>;
  /** The cancel's log line ("Cancelled by ..."), once one asked. */
  message: string | null;
}

const runs = new WeakMap<object, Map<string, MoveRun>>();

function runsOf(db: object): Map<string, MoveRun> {
  let map = runs.get(db);
  if (!map) {
    map = new Map();
    runs.set(db, map);
  }
  return map;
}

export interface MoveRunHandle {
  readonly signal: AbortSignal;
  /** The cancel's message once one asked to stop, else null. */
  cancelled(): string | null;
  /** The job is done with the deployment: a cancel waiting for it returns. */
  end(): void;
}

/** The move job's own run of a deployment: a cancel reaches it through signal. */
export function startMoveRun(db: object, deploymentId: string): MoveRunHandle {
  const controller = new AbortController();
  let end!: () => void;
  const done = new Promise<void>((resolve) => (end = resolve));
  const run: MoveRun = { controller, done, message: null };
  runsOf(db).set(deploymentId, run);
  return {
    signal: controller.signal,
    cancelled: () => run.message,
    end() {
      if (runsOf(db).get(deploymentId) === run) runsOf(db).delete(deploymentId);
      end();
    },
  };
}

/**
 * Asks the job copying this move to stop and end it as cancelled with
 * `message`. Resolves once the job is done with it, or after `waitMs`
 * (the job still ends it once its streams are closed). Null when no job
 * runs it in this panel now: it has not started, or the panel restarted
 * since, and the caller ends it itself.
 */
export function cancelMoveRun(db: object, deploymentId: string, message: string, waitMs = 20_000): Promise<void> | null {
  const run = runsOf(db).get(deploymentId);
  if (!run) return null;
  run.message ??= message;
  run.controller.abort(new Error(message));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  return Promise.race([run.done, timeout]).finally(() => clearTimeout(timer));
}

/** A move to another node (services.move), not a move to another project. */
export function isNodeMove(d: Pick<DeploymentRow, "trigger" | "movedFromNodeId">): boolean {
  return d.trigger === "move" && d.movedFromNodeId !== null;
}

/**
 * The node a move to another node goes to: its target that is not the old
 * node (a move without volumes rolls out on both), or before the rollout
 * the ship step's node, which services.move sets to it. Null for other
 * deployments.
 */
export function moveTarget(d: Pick<DeploymentRow, "trigger" | "movedFromNodeId" | "targetNodeIds" | "steps">): string | null {
  const from = d.movedFromNodeId;
  if (!isNodeMove(d) || !from) return null;
  return (
    d.targetNodeIds.find((id) => id !== from) ??
    d.steps.find((s) => s.key === "ship" && s.nodeId !== null && s.nodeId !== from)?.nodeId ??
    null
  );
}

/**
 * Whether deployments.cancel takes this unfinished move now (Deployment.move.canCancel):
 * always without volumes (the old copy keeps serving), with volumes only while it copies.
 */
export function moveCancellable(db: PanelDb, d: Pick<DeploymentRow, "serviceId" | "moveCopying">): boolean {
  return d.moveCopying || dataVolumes(db, d.serviceId).length === 0;
}

/** CONFLICT (reason moveStarting) for a move with volumes that copied them and starts on the new node. */
export function assertMoveCancellable(db: PanelDb, d: DeploymentRow): void {
  if (!isNodeMove(d) || moveCancellable(db, d)) return;
  const to = moveTarget(d);
  const names = nodeNames(db, [d.movedFromNodeId as string, ...(to ? [to] : [])]);
  const toName = (to && names.get(to)) ?? "the new node";
  const fromName = names.get(d.movedFromNodeId as string) ?? "the old node";
  throw new OpError(
    "CONFLICT",
    `The data is copied and the service is starting on ${toName}, so cancelling now could lose what it writes there. The move ends on its own: it runs on ${toName} once it is healthy, or goes back to ${fromName} if it fails.`,
    { reason: "moveStarting" },
  );
}
