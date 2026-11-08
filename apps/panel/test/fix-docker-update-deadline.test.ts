// A Docker update whose UpdateResult never comes (the agent restarted
// mid-upgrade, the node died or was removed) used to stay running for good,
// and every update run and reconnect catch-up waited on it. Now the run job
// watches it: no result within an hour, or its node removed, fails it, and
// a late result still counts.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { nodes as nodeOps, updates } from "@seylo/ops";
import { ReportEventRequestSchema, ReportEventResponseSchema, UpdateTarget } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { jobs, nodes, updateRuns, updateSteps } from "../src/db/schema";
import { releaseSource } from "../src/modules/updates/manifest";
import { dockerNoResultError, dockerStepTimeoutMs, watchRunningRuns } from "../src/modules/updates/runs";
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
  Object.assign(releaseSource, original);
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

async function join(version: string, name: string) {
  const agent = await joinAgent(panel, url, { agentVersion: version, name, facts: { agentVersion: version } });
  agents.push(agent);
  agent.handle("UpdateAgent", () => ({}));
  // Answers, then never reports (its agent restarts mid-upgrade).
  agent.handle("UpdateDocker", () => ({ fromVersion: "27.0", toVersion: "29.0", warning: "" }));
  return agent;
}

async function goOffline(agent: FakeAgent) {
  await agent.close();
  for (let i = 0; i < 100 && panel.deps.agents.isOnline(agent.nodeId); i++) await Bun.sleep(5);
}

/** Runs due jobs (also ones queued for later) until none is left. */
async function drain() {
  const later = new Date(Date.now() + 24 * 3600_000);
  for (let i = 0; i < 20; i++) if ((await panel.runner.runDue(panel.deps, later)) === 0) return;
}

const runStatus = (runId: string) => panel.deps.db.select().from(updateRuns).where(eq(updateRuns.id, runId)).get()?.status;
const stepOf = (runId: string) => panel.deps.db.select().from(updateSteps).where(eq(updateSteps.runId, runId)).get();
const backdate = (runId: string) =>
  panel.deps.db
    .update(updateSteps)
    .set({ startedAt: new Date(Date.now() - dockerStepTimeoutMs - 1000) })
    .where(eq(updateSteps.runId, runId))
    .run();

test("a Docker update without a result fails after the deadline and no longer holds other updates back", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0", "n1");
  const other = await join("0.8.0", "n2");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  const real = await ok(callOp(panel, nodeOps.updateDocker, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  const runId = real.runId as string;
  await goOffline(node);

  // Within the hour it waits (Docker restarting takes the agent offline): other updates are refused.
  await drain();
  expect(runStatus(runId)).toBe("running");
  expect((await callOp(panel, updates.updateNode, { nodeId: other.nodeId }, { cookie: owner.cookie })).status).toBe(409);

  backdate(runId);
  await drain();
  expect(runStatus(runId)).toBe("failed");
  expect(stepOf(runId)).toMatchObject({ status: "failed", error: dockerNoResultError });
  expect((await ok(callOp(panel, updates.status, {}, { cookie: owner.cookie }))).activeRun).toBeNull();
  expect((await callOp(panel, updates.updateNode, { nodeId: other.nodeId }, { cookie: owner.cookie })).status).toBe(200);
});

test("a late result still counts, and removing the node fails its Docker update at once", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0", "n1");
  const real = await ok(callOp(panel, nodeOps.updateDocker, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  const runId = real.runId as string;
  backdate(runId);
  await drain();
  expect(runStatus(runId)).toBe("failed");
  const updateId = node.requests("UpdateDocker").at(-1).updateId;
  await node.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: 1n,
    event: {
      payload: {
        case: "updateResult",
        value: { target: UpdateTarget.DOCKER, updateId, success: true, fromVersion: "27.0", toVersion: "29.0" },
      },
    },
  });
  expect(runStatus(runId)).toBe("succeeded");
  expect(stepOf(runId)).toMatchObject({ status: "succeeded", error: null });

  // Another Docker update, then the node is removed while it runs.
  const second = await ok(callOp(panel, nodeOps.updateDocker, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  panel.deps.db.delete(nodes).where(eq(nodes.id, node.nodeId)).run();
  await drain();
  expect(runStatus(second.runId as string)).toBe("failed");
  expect(stepOf(second.runId as string)?.error).toContain("removed");
});

test("a Docker run an older panel left running gets watched when the panel starts", async () => {
  // Without it the run job asks the real GitHub releases API, which made this test slow and flaky.
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0", "n1");
  const real = await ok(callOp(panel, nodeOps.updateDocker, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  const runId = real.runId as string;
  // Older panels queued no job for it.
  panel.deps.db.delete(jobs).where(eq(jobs.type, "updates.run")).run();
  backdate(runId);
  await drain();
  expect(runStatus(runId)).toBe("running");
  watchRunningRuns(panel.deps);
  watchRunningRuns(panel.deps);
  expect(panel.deps.db.select().from(jobs).where(eq(jobs.type, "updates.run")).all()).toHaveLength(1);
  await drain();
  expect(runStatus(runId)).toBe("failed");
});
