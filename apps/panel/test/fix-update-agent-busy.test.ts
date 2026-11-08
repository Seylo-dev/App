// The 0.2.0 install test race (run 9uahvhfy2ssgd3k7): "update everything"
// on a panel node. The new panel marks the panel step done as soon as it
// boots at the target version and sends UpdateAgent to the panel node at
// once, while that agent's panel swap still holds its update lock for the
// health check and report. The agent answers busy (ABORTED). Before, the
// panel only waited for the new version, which never came, and the step
// failed after 10 minutes with "The update did not finish in time.". Now
// it logs the busy answer and sends UpdateAgent again with a backoff.

import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { updates } from "@seylo/ops";
import { StatusCode } from "@seylo/proto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { nodes, updateRuns, updateSteps } from "../src/db/schema";
import { ensurePanelService } from "../src/modules/nodes/panel-service";
import { releaseSource } from "../src/modules/updates/manifest";
import { advanceRun, busyRetryMs, updateAgentTimeoutMs } from "../src/modules/updates/runs";
import { type FakeAgent, FakeStatus } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";
import { serveReleases } from "./release-fakes";

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
const agents: FakeAgent[] = [];
const original = { ...releaseSource };
let saved: { version: string; image: string | null };

beforeEach(async () => {
  panel = testPanel();
  saved = { version: panel.deps.config.version, image: panel.deps.config.image };
  url = listen(panel);
  owner = await createUser(panel, "owner");
});
afterEach(async () => {
  setSystemTime();
  Object.assign(releaseSource, original);
  Object.assign(panel.deps.config, saved);
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

/** A logger that keeps what it writes. */
function recordingLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: "info" }, { write: (line: string) => lines.push(JSON.parse(line)) });
  return { logger, lines };
}

/** The node the panel runs on, at 0.8.0, with the panel as its protected service. */
async function panelNode() {
  (panel.deps.config as { version: string }).version = "0.8.0";
  panel.deps.config.image = `ghcr.io/x/panel:0.8.0@sha256:${"a".repeat(64)}`;
  const agent = await joinAgent(panel, url, { agentVersion: "0.8.0", facts: { agentVersion: "0.8.0" } });
  agents.push(agent);
  panel.deps.db.update(nodes).set({ isPanelNode: true }).where(eq(nodes.id, agent.nodeId)).run();
  expect(ensurePanelService(panel.deps)).not.toBe("skipped");
  agent.handle("UpdatePanel", () => ({}));
  return agent;
}

const stepOf = (id: string) => panel.deps.db.select().from(updateSteps).where(eq(updateSteps.id, id)).get();

test("the agent step on the panel node sends UpdateAgent again while the panel swap holds the node busy", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const agent = await panelNode();
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  let calls = 0;
  agent.handle("UpdateAgent", () => {
    calls++;
    // A 0.2.0 agent answers at once while the swap holds the lock.
    if (calls === 1) throw new FakeStatus(StatusCode.ABORTED, "another update is in progress on this node (panel update)");
    return {};
  });
  const run = await ok(callOp(panel, updates.updatePanel, {}, { cookie: owner.cookie }));
  expect(run.steps.map((s: { target: string }) => s.target)).toEqual(["panel", "agent"]);
  const { logger, lines } = recordingLogger();
  const ctx = { ...panel.deps, logger };

  // The panel step: UpdatePanel goes out; the agent swaps the container.
  expect(await advanceRun(ctx, run.id)).toBeGreaterThan(0);
  await agent.waitFor("UpdatePanel");

  // The new panel boots at 0.9.0 and resumes the run: its own step is done
  // by version, the agent step starts and the node is busy.
  (panel.deps.config as { version: string }).version = "0.9.0";
  while ((await advanceRun(ctx, run.id)) === 0) {}
  const stepId = (await agent.waitFor("UpdateAgent"))[0].updateId;
  expect(stepOf(stepId)?.status).toBe("running");
  expect(lines.filter((l) => l.msg === "node busy with another update; sending UpdateAgent again")).toMatchObject([
    { stepId, nodeId: agent.nodeId, busy: "another update is in progress on this node (panel update)", attempt: 1, retryInMs: busyRetryMs },
  ]);

  // Before the backoff is over nothing is sent again.
  expect(await advanceRun(ctx, run.id)).toBeGreaterThan(0);
  expect(agent.requests("UpdateAgent")).toHaveLength(1);

  // Then it is (before: never), with the same step id, and the agent takes it.
  setSystemTime(new Date(Date.now() + busyRetryMs + 1000));
  expect(await advanceRun(ctx, run.id)).toBeGreaterThan(0);
  const again = await agent.waitFor("UpdateAgent", 2);
  expect(again.map((r) => r.updateId)).toEqual([stepId, stepId]);
  expect(again[1]).toMatchObject({ targetVersion: "0.9.0" });

  // Accepted: no more resends; the agent reconnects on 0.9.0 and the step is done.
  setSystemTime(new Date(Date.now() + 3 * busyRetryMs));
  expect(await advanceRun(ctx, run.id)).toBeGreaterThan(0);
  expect(agent.requests("UpdateAgent")).toHaveLength(2);
  agent.event({ payload: { case: "nodeFacts", value: { agentVersion: "0.9.0" } } });
  await Bun.sleep(50);
  while ((await advanceRun(ctx, run.id)) === 0) {}
  expect(panel.deps.db.select().from(updateRuns).where(eq(updateRuns.id, run.id)).get()?.status).toBe("succeeded");
  expect(stepOf(stepId)).toMatchObject({ status: "succeeded", error: null });
});

test("a node that stays busy is asked again with a growing backoff until the step's deadline", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const agent = await joinAgent(panel, url, { agentVersion: "0.8.0", facts: { agentVersion: "0.8.0" } });
  agents.push(agent);
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  agent.handle("UpdateAgent", () => {
    throw new FakeStatus(StatusCode.ABORTED, "another update is in progress on this node (Docker update)");
  });
  const run = await ok(callOp(panel, updates.updateNode, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
  const { logger, lines } = recordingLogger();
  const ctx = { ...panel.deps, logger };
  const start = Date.now();
  while ((await advanceRun(ctx, run.id)) === 0) {}
  for (let i = 1; i < 6; i++) {
    setSystemTime(new Date(start + 11 * 60_000 * (i / 10)));
    while ((await advanceRun(ctx, run.id)) === 0) {}
  }
  const waits = lines.filter((l) => l.msg?.toString().startsWith("node busy")).map((l) => l.retryInMs);
  expect(waits.slice(0, 4)).toEqual([busyRetryMs, 2 * busyRetryMs, 4 * busyRetryMs, 8 * busyRetryMs]);
  expect(Math.max(...(waits as number[]))).toBeLessThanOrEqual(60_000);

  // The deadline still holds: the step fails and so does the run.
  setSystemTime(new Date(start + 11 * 60_000));
  while ((await advanceRun(ctx, run.id)) === 0) {}
  const sent = agent.requests("UpdateAgent").length;
  expect(panel.deps.db.select().from(updateRuns).where(eq(updateRuns.id, run.id)).get()?.status).toBe("failed");
  setSystemTime(new Date(start + 12 * 60_000));
  await advanceRun(ctx, run.id);
  expect(agent.requests("UpdateAgent")).toHaveLength(sent);
});

test("a node that already runs the release finishes its step at once", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  // Its facts are behind: the agent itself knows better.
  const agent = await joinAgent(panel, url, { agentVersion: "0.8.0", facts: { agentVersion: "0.8.0" } });
  agents.push(agent);
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  agent.handle("UpdateAgent", () => {
    throw new FakeStatus(StatusCode.ALREADY_EXISTS, "already up to date");
  });
  const run = await ok(callOp(panel, updates.updateNode, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
  while ((await advanceRun(panel.deps, run.id)) === 0) {}
  // Before: it waited for a version the facts never showed and failed after 10 minutes.
  expect(panel.deps.db.select().from(updateRuns).where(eq(updateRuns.id, run.id)).get()?.status).toBe("succeeded");
});

test("UpdateAgent's deadline leaves room for the agent's wait for a panel swap", () => {
  // The agent waits up to a minute and keeps the last 30 seconds of the deadline for the download.
  expect(updateAgentTimeoutMs).toBeGreaterThanOrEqual(60_000 + 30_000);
});
