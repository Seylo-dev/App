// Fleet updates: one switch updates the panel first, then nodes one by one
// (runs.ts), from a signed release manifest (manifest.ts) on the release
// channel the owner picked. Nodes that were offline during a run catch up
// when they reconnect (catch-up.ts). Contracts: packages/ops/src/ops/updates.ts.

import { OpError, updates } from "@seylo/ops";
import { userOf } from "../../auth/principal";
import type { Deps } from "../../deps";
import { implement } from "../../ops/implement";
import { setSetting } from "../../settings";
import { defineModule } from "../module";
import { adoptOldSkips, catchUpJob, queueCatchUp } from "./catch-up";
import { testReleaseOverrides } from "./manifest";
import { releaseChannel } from "./release-state";
import {
  applyUpdateResult,
  checkIntervalSeconds,
  checkJob,
  checkNow,
  isOwner,
  history as runHistory,
  runJob,
  startRun,
  toRun,
  updateStatus,
} from "./runs";
import "./settings";

const publish = (deps: Pick<Deps, "live">) =>
  deps.live.publish("panel", { type: "invalidate", ops: ["updates.status", "updates.history", "nodes.list"] });

const status = implement(updates.status, (_input, ctx) => updateStatus(ctx));

const check = implement(updates.check, async (_input, ctx) => {
  await checkNow(ctx);
  publish(ctx);
  return updateStatus(ctx);
});

const setAutoUpdate = implement(updates.setAutoUpdate, (input, ctx) => {
  setSetting(ctx.db, "autoUpdate", input.enabled);
  // Every node's NodeSettings carries the switch.
  ctx.agents.desired.markDirty({ all: true });
  publish(ctx);
  return updateStatus(ctx);
});

const setChannel = implement(updates.setChannel, async (input, ctx) => {
  if (!isOwner(ctx.principal)) throw new OpError("FORBIDDEN", "Only the owner can change the release channel.");
  if (releaseChannel(ctx.db) !== input.channel) {
    setSetting(ctx.db, "updateChannel", input.channel);
    // Offer the channel's release right away; until a check on it succeeds nothing is offered.
    await checkNow(ctx);
    publish(ctx);
  }
  return updateStatus(ctx);
});

const updatePanel = implement(updates.updatePanel, (input, ctx) => {
  const run = startRun(ctx, { trigger: "manual", startedBy: userOf(ctx.principal)?.id ?? null, panelOnly: input.panelOnly ?? false });
  publish(ctx);
  return toRun(ctx.db, run);
});

const updateNode = implement(updates.updateNode, (input, ctx) => {
  const run = startRun(ctx, { trigger: "manual", startedBy: userOf(ctx.principal)?.id ?? null, onlyNodeId: input.nodeId });
  publish(ctx);
  return toRun(ctx.db, run);
});

const history = implement(updates.history, (input, ctx) => runHistory(ctx.db, input.limit ?? 20, input.before));

function start(deps: Deps) {
  const overrides = testReleaseOverrides();
  if (overrides) {
    deps.logger.warn(overrides, "TEST BUILD: release source and signing key are compiled-in overrides; never ship this build");
  }
  deps.agents.onEvent("updateResult", (nodeId, result, _event, meta) => {
    if (meta.durable) applyUpdateResult(deps, nodeId, result);
  });
  // A node that was offline during a run gets its update when it is back,
  // also one a panel before 0.2.0-rc.2 skipped (before any node connects).
  const adopted = adoptOldSkips(deps.db);
  if (adopted > 0) deps.logger.info({ steps: adopted }, "update steps skipped as offline before rc.2 now wait for their node");
  deps.agents.onConnection((nodeId, online) => {
    if (online) queueCatchUp(deps, nodeId);
  });
  // Every few hours; "Check now" (updates.check) does it on demand.
  deps.schedules.ensure({ key: "updates.check", jobType: "updates.check", intervalSeconds: checkIntervalSeconds, jitterSeconds: 600 });
}

export default defineModule({
  name: "updates",
  ops: [status, check, setAutoUpdate, setChannel, updatePanel, updateNode, history],
  jobs: [runJob, checkJob, catchUpJob],
  start,
});
