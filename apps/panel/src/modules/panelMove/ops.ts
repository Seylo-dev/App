// The panelMove ops (contracts: packages/ops/src/ops/panelMove.ts).

import { OpError, panelMove } from "@seylo/ops";
import { nodeOffline } from "../../agent-hub/calls";
import { requireFreshSignIn } from "../../auth/fresh";
import { implement, type OpContext } from "../../ops/implement";
import { getSetting, setSetting } from "../../settings";
import { panelServiceId } from "../nodes/panel-service";
import { beginMove, cancelMove, publishStatus } from "./orchestrator";
import { callerBlocks, moveCheck, panelNodeRow, parseAddress, refusal } from "./preflight";
import { activeMove } from "./state";
import { moveStatus } from "./status";

function refuseCaller(ctx: OpContext): void {
  const caller = refusal(callerBlocks(ctx), false);
  if (caller) throw caller;
}

function by(ctx: OpContext): string {
  return ctx.principal.type === "session" ? ctx.principal.user.email : "the owner";
}

export const check = implement(panelMove.check, (input, ctx) => moveCheck(ctx, input.targetNodeId));

export const status = implement(panelMove.status, (_input, ctx) => moveStatus(ctx, ctx.access.can("settings.view")));

export const start = implement(panelMove.start, (input, ctx) => {
  refuseCaller(ctx);
  const checked = moveCheck(ctx, input.targetNodeId);
  const refused = refusal(checked.blocks, input.leftBehind === true);
  if (refused) throw refused;
  const raw = input.address ?? checked.defaultAddress;
  const target = checked.targets.find((node) => node.id === input.targetNodeId);
  if (!raw || !target) {
    throw new OpError(
      "BAD_REQUEST",
      `The panel knows no address of ${target?.name ?? "that node"}: enter the address other servers reach it at.`,
      {
        field: "address",
      },
    );
  }
  const address = parseAddress(raw);
  requireFreshSignIn(ctx);
  const from = panelNodeRow(ctx);
  if (!from) throw new OpError("CONFLICT", "The panel has no node of its own to move from.", { reason: "panelNotManaged" });
  const move = beginMove(ctx, {
    targetNodeId: target.id,
    targetNodeName: target.name,
    address,
    fromNodeId: from.id,
    fromNodeName: from.name,
    domain: checked.domain,
    follow: checked.nodesToMove.map((node) => node.id),
    leftBehind: checked.nodesLeftBehind.map((node) => ({ id: node.id, name: node.name })),
    by: by(ctx),
  });
  ctx.auditDetails?.({ moveId: move.moveId, address, leftBehindIds: move.leftBehind.map((node) => node.id) });
  return moveStatus(ctx, true);
});

export const cancel = implement(panelMove.cancel, (_input, ctx) => {
  refuseCaller(ctx);
  const move = activeMove(ctx.db);
  if (!move || move.doneAt !== null || move.abort.signal.aborted) {
    throw new OpError("CONFLICT", "No panel move is running.", { reason: "notRunning" });
  }
  if (move.switching) {
    throw new OpError("CONFLICT", "The switch to the new server has started; it cannot be cancelled any more.", { reason: "switching" });
  }
  cancelMove(move, by(ctx));
  ctx.auditDetails?.({ moveId: move.moveId });
  return moveStatus(ctx, true);
});

export const removeOldCopy = implement(panelMove.removeOldCopy, async (_input, ctx) => {
  refuseCaller(ctx);
  const done = getSetting(ctx.db, "panelMoveDone");
  if (!done) throw new OpError("CONFLICT", "This panel was not moved here, so there is no old copy to delete.", { reason: "notMoved" });
  if (done.oldCopyRemoved) throw new OpError("CONFLICT", `The old copy on ${done.fromNodeName} is deleted already.`, { reason: "removed" });
  // Never the panel's own node: that copy is the one running (a move back to the old server).
  if (panelNodeRow(ctx)?.id === done.fromNodeId) {
    throw new OpError("CONFLICT", `The panel runs on ${done.fromNodeName} again, so its data there is not an old copy.`, {
      reason: "runsHere",
    });
  }
  requireFreshSignIn(ctx);
  if (!ctx.agents.isOnline(done.fromNodeId)) throw nodeOffline(done.fromNodeId);
  const removed = await ctx.agents.call(done.fromNodeId, "removeOldPanel", { serviceId: panelServiceId }, { timeoutMs: 5 * 60_000 });
  const freedBytes = Number(removed.freedBytes);
  const now = getSetting(ctx.db, "panelMoveDone");
  if (now?.moveId === done.moveId) setSetting(ctx.db, "panelMoveDone", { ...now, oldCopyRemoved: true, freedBytes });
  ctx.auditDetails?.({ moveId: done.moveId, nodeId: done.fromNodeId, freedBytes });
  publishStatus(ctx);
  return { freedBytes, status: moveStatus(ctx, true) };
});

export const panelMoveHandlers = [check, status, start, cancel, removeOldCopy];
