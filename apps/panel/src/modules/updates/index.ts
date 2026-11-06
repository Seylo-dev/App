// Fleet updates: one switch updates the panel first, then nodes one by one
// (runs.ts), from a signed release manifest (manifest.ts). Contracts:
// packages/ops/src/ops/updates.ts.

import { updates } from "@seylo/ops";
import { userOf } from "../../auth/principal";
import type { Deps } from "../../deps";
import { implement } from "../../ops/implement";
import { setSetting } from "../../settings";
import { defineModule } from "../module";
import { testReleaseOverrides } from "./manifest";
import {
  applyUpdateResult,
  checkIntervalSeconds,
  checkJob,
  checkNow,
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
  // Every few hours; "Check now" (updates.check) does it on demand.
  deps.schedules.ensure({ key: "updates.check", jobType: "updates.check", intervalSeconds: checkIntervalSeconds, jitterSeconds: 600 });
}

export default defineModule({
  name: "updates",
  ops: [status, check, setAutoUpdate, updatePanel, updateNode, history],
  jobs: [runJob, checkJob],
  start,
});
