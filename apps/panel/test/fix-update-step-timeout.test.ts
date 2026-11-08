// An update step that fails by timeout ("The update did not finish in
// time."). Before, it raised no alert (only a rollback did), and the node
// stayed on the old version until someone clicked Update now. Now it raises
// update_failed like a failed result does, and an agent step is tried once
// more a few minutes later in a run of its own.

import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { type OpOutput, updates } from "@seylo/ops";
import { ReportEventRequestSchema, ReportEventResponseSchema, UpdateTarget } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { alerts, jobs, updateRuns, updateSteps } from "../src/db/schema";
import { releaseSource } from "../src/modules/updates/manifest";
import { advanceRun, stepTimeoutError, stepTimeoutMs, timeoutRetryMs } from "../src/modules/updates/runs";
import type { FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";
import { serveReleases } from "./release-fakes";

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
const agents: FakeAgent[] = [];
const original = { ...releaseSource };

beforeEach(async () => {
  panel = testPanel();
  url = listen(panel);
  owner = await createUser(panel, "owner");
});
afterEach(async () => {
  setSystemTime();
  Object.assign(releaseSource, original);
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

type Run = OpOutput<typeof updates.history>["runs"][number];

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

/** A node whose agent takes UpdateAgent and then never comes back on the new version. */
async function silentNode(name = "de-fsn-1") {
  const agent = await joinAgent(panel, url, { name, agentVersion: "0.8.0", facts: { agentVersion: "0.8.0" } });
  agents.push(agent);
  agent.handle("UpdateAgent", () => ({}));
  return agent;
}

async function drain(now?: Date) {
  for (let i = 0; i < 20; i++) if ((await panel.runner.runDue(panel.deps, now)) === 0) return;
}

const updateAlerts = () => panel.deps.db.select().from(alerts).where(eq(alerts.event, "update_failed")).orderBy(alerts.createdAt).all();
const stepsOf = (nodeId: string) =>
  panel.deps.db
    .select({ step: updateSteps, run: updateRuns })
    .from(updateSteps)
    .innerJoin(updateRuns, eq(updateRuns.id, updateSteps.runId))
    .where(eq(updateSteps.nodeId, nodeId))
    .orderBy(updateRuns.createdAt)
    .all();

/** Lets the running step of `runId` time out at `now`. */
async function timeOut(runId: string, now: number) {
  setSystemTime(new Date(now + stepTimeoutMs + 1000));
  while ((await advanceRun(panel.deps, runId)) === 0) {}
}

test("an agent step that times out raises update_failed and is tried once more on its own", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await silentNode();
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  const first = await ok(callOp(panel, updates.updateNode, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  const start = Date.now();
  while ((await advanceRun(panel.deps, first.id)) === 0) {}
  expect(await node.waitFor("UpdateAgent")).toHaveLength(1);

  await timeOut(first.id, start);
  expect(panel.deps.db.select().from(updateRuns).where(eq(updateRuns.id, first.id)).get()).toMatchObject({
    status: "failed",
    error: stepTimeoutError,
  });
  const failed = stepsOf(node.nodeId)[0]?.step;
  const retryAt = start + stepTimeoutMs + 1000 + timeoutRetryMs;
  expect(failed).toMatchObject({ status: "failed", error: stepTimeoutError, retry: "waiting" });
  expect(failed?.retryAt?.getTime()).toBe(retryAt);

  // Before: no alert at all.
  expect(updateAlerts()).toMatchObject([
    {
      eventKey: `update-failed:${failed?.id}`,
      severity: "error",
      title: "Update to 0.9.0 did not finish on de-fsn-1",
      nodeId: node.nodeId,
      link: "/settings/updates",
    },
  ]);
  expect(updateAlerts()[0]?.message).toContain("The panel tries again in 5 minutes");

  // A late failed UpdateResult for the same step does not alert twice.
  await node.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: 1n,
    event: {
      payload: {
        case: "updateResult",
        value: { target: UpdateTarget.AGENT, updateId: failed?.id, toVersion: "0.9.0", success: false, error: "late" },
      },
    },
  });
  expect(updateAlerts()).toHaveLength(1);

  // The catch-up is queued for retryAt; nothing is sent before then.
  const queued = panel.deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "updates.catchUp"), eq(jobs.status, "queued")))
    .all();
  expect(queued.map((j) => j.runAt.getTime())).toEqual([retryAt]);
  await drain();
  expect(node.requests("UpdateAgent")).toHaveLength(1);

  // Then the panel tries again: a run of its own, started by the panel (not "Node came back").
  setSystemTime(new Date(retryAt + 1000));
  await drain(new Date(retryAt + 1000));
  const second = (await node.waitFor("UpdateAgent", 2))[1];
  expect(second).toMatchObject({ targetVersion: "0.9.0", automatic: true });
  const [original, retry] = stepsOf(node.nodeId);
  expect(original?.step).toMatchObject({ status: "failed", retry: "retried", retryRunId: retry?.run.id });
  expect(retry?.run).toMatchObject({ trigger: "auto", status: "running", startedBy: null });

  // The second try times out too: another alert, and no third try.
  await timeOut(retry?.run.id as string, retryAt + 1000);
  const last = stepsOf(node.nodeId)[1]?.step;
  expect(last).toMatchObject({ status: "failed", error: stepTimeoutError, retry: null });
  expect(updateAlerts()).toHaveLength(2);
  expect(updateAlerts()[1]?.message).toContain("It was the second try. Update now in Settings > Updates tries again.");
  await drain(new Date(retryAt + stepTimeoutMs + 2 * timeoutRetryMs));
  expect(node.requests("UpdateAgent")).toHaveLength(2);

  const history = await ok(callOp(panel, updates.history, {}, { cookie: owner.cookie }));
  expect(history.runs.map((r: Run) => [r.trigger, r.status, r.steps[0]?.retry])).toEqual([
    ["auto", "failed", null],
    ["manual", "failed", "retried"],
  ]);
});

test("Update now during the wait supersedes the retry", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await silentNode();
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  const first = await ok(callOp(panel, updates.updateNode, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  const start = Date.now();
  while ((await advanceRun(panel.deps, first.id)) === 0) {}
  await timeOut(first.id, start);
  await ok(callOp(panel, updates.updateNode, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  expect(stepsOf(node.nodeId)[0]?.step.retry).toBe("superseded");
});

test("a node that reconnects on the new version after the timeout is up to date, not updated again", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await silentNode();
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  const first = await ok(callOp(panel, updates.updateNode, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  const start = Date.now();
  while ((await advanceRun(panel.deps, first.id)) === 0) {}
  await timeOut(first.id, start);
  node.event({ payload: { case: "nodeFacts", value: { agentVersion: "0.9.0" } } });
  await Bun.sleep(50);
  const at = new Date(start + stepTimeoutMs + timeoutRetryMs + 5000);
  setSystemTime(at);
  await drain(at);
  expect(node.requests("UpdateAgent")).toHaveLength(1);
  expect(stepsOf(node.nodeId)[0]?.step.retry).toBe("up_to_date");
});

test("a Docker update without a result alerts too, and the alert is resolved when the result comes late", async () => {
  const { nodes: nodeOps } = await import("@seylo/ops");
  const { dockerNoResultError, dockerStepTimeoutMs } = await import("../src/modules/updates/runs");
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await silentNode("de-fsn-2");
  node.handle("UpdateDocker", () => ({ fromVersion: "27.0", toVersion: "29.0", warning: "" }));
  const real = await ok(callOp(panel, nodeOps.updateDocker, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  const runId = real.runId as string;
  panel.deps.db
    .update(updateSteps)
    .set({ startedAt: new Date(Date.now() - dockerStepTimeoutMs - 1000) })
    .where(eq(updateSteps.runId, runId))
    .run();
  while ((await advanceRun(panel.deps, runId)) === 0) {}
  const step = panel.deps.db.select().from(updateSteps).where(eq(updateSteps.runId, runId)).get();
  expect(step).toMatchObject({ status: "failed", error: dockerNoResultError });
  expect(updateAlerts()).toMatchObject([
    {
      eventKey: `update-failed:${step?.id}`,
      title: "Docker update on de-fsn-2 did not report back",
      nodeId: node.nodeId,
      resolvedAt: null,
    },
  ]);
  await node.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: 1n,
    event: {
      payload: { case: "updateResult", value: { target: UpdateTarget.DOCKER, updateId: step?.id, success: true, toVersion: "29.0" } },
    },
  });
  expect(updateAlerts()[0]?.resolvedAt).not.toBeNull();
});

test("the panel step timing out raises update_failed for the panel node", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const { nodes } = await import("../src/db/schema");
  const { ensurePanelService } = await import("../src/modules/nodes/panel-service");
  const saved = { version: panel.deps.config.version, image: panel.deps.config.image };
  try {
    (panel.deps.config as { version: string }).version = "0.8.0";
    panel.deps.config.image = `ghcr.io/x/panel:0.8.0@sha256:${"a".repeat(64)}`;
    const agent = await joinAgent(panel, url, { name: "here", agentVersion: "0.9.0", facts: { agentVersion: "0.9.0" } });
    agents.push(agent);
    agent.handle("UpdatePanel", () => ({}));
    panel.deps.db.update(nodes).set({ isPanelNode: true }).where(eq(nodes.id, agent.nodeId)).run();
    ensurePanelService(panel.deps);
    await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
    const run = await ok(callOp(panel, updates.updatePanel, { panelOnly: true }, { cookie: owner.cookie }));
    const start = Date.now();
    while ((await advanceRun(panel.deps, run.id)) === 0) {}
    await timeOut(run.id, start);
    const step = panel.deps.db.select().from(updateSteps).where(eq(updateSteps.runId, run.id)).get();
    expect(step).toMatchObject({ target: "panel", status: "failed", error: stepTimeoutError, retry: null });
    expect(updateAlerts()).toMatchObject([
      { eventKey: `update-failed:${step?.id}`, title: "Update of the panel to 0.9.0 did not finish", nodeId: agent.nodeId },
    ]);
    expect(updateAlerts()[0]?.message).toContain("Update the panel again in Settings > Updates.");
  } finally {
    Object.assign(panel.deps.config, saved);
  }
});
