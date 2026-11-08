// A node that was offline during an update run. The run skipped it with
// "The node is offline; it updates itself when it starts", but a node whose
// agent only reconnected (no restart) never did. Now the panel updates it
// when it reconnects, to the version of the run that skipped it unless a
// later run included the node, not when it rolled that version back, and
// with UpdateAgent marked automatic so the agent's own waits apply. The
// outcome is on the skipped step (retry) and in the run made for it.

import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { type OpOutput, updates } from "@seylo/ops";
import { ReportEventRequestSchema, ReportEventResponseSchema, StatusCode, UpdateTarget } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { jobs, nodes, updateRuns, updateSteps } from "../src/db/schema";
import { releaseSource } from "../src/modules/updates/manifest";
import { wasRolledBack } from "../src/modules/updates/rollbacks";
import { checkJob } from "../src/modules/updates/runs";
import { type FakeAgent, FakeStatus } from "./fake-agent";
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

type Run = OpOutput<typeof updates.history>["runs"][number];

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

function track(agent: FakeAgent) {
  agents.push(agent);
  agent.handle("UpdateAgent", () => ({}));
  return agent;
}

const join = async (version: string, name?: string) =>
  track(await joinAgent(panel, url, { agentVersion: version, name, facts: { agentVersion: version } }));

/** The same node connecting again: its agent did not restart, it runs `version`. */
async function reconnect(agent: FakeAgent, version: string) {
  return track(
    await joinAgent(panel, url, { nodeId: agent.nodeId, key: agent.key, agentVersion: version, facts: { agentVersion: version } }),
  );
}

async function goOffline(agent: FakeAgent) {
  await agent.close();
  for (let i = 0; i < 100 && panel.deps.agents.isOnline(agent.nodeId); i++) await Bun.sleep(5);
}

/** Runs due jobs until none is left (a job may queue the next one). */
async function drain(now?: Date) {
  for (let i = 0; i < 20; i++) if ((await panel.runner.runDue(panel.deps, now)) === 0) return;
}

const stepsOf = (nodeId: string) =>
  panel.deps.db
    .select({ step: updateSteps, run: updateRuns })
    .from(updateSteps)
    .innerJoin(updateRuns, eq(updateRuns.id, updateSteps.runId))
    .where(eq(updateSteps.nodeId, nodeId))
    .orderBy(updateRuns.createdAt)
    .all();

async function reportResult(agent: FakeAgent, outboxId: number, value: Record<string, unknown>) {
  await agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: BigInt(outboxId),
    event: { payload: { case: "updateResult", value: value as never } },
  });
}

/** Starts "update everything" while `offline` is offline and lets the run finish. */
async function runWhileOffline(offline: FakeAgent) {
  await goOffline(offline);
  const run = await ok(callOp(panel, updates.updatePanel, {}, { cookie: owner.cookie }));
  await drain();
  return run;
}

test("a node that was offline during a run gets the run's release when it reconnects, recorded on both runs", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  const first = await runWhileOffline(node);
  const skipped = stepsOf(node.nodeId)[0]?.step;
  expect(skipped).toMatchObject({
    status: "skipped",
    retry: "waiting",
    error: "The node is offline; it gets the update when it reconnects.",
  });
  expect(panel.deps.db.select().from(updateRuns).where(eq(updateRuns.id, first.id)).get()?.status).toBe("succeeded");

  // A newer release is checked meanwhile; the node still gets the run's 0.9.0.
  serveReleases([{ tag: "v0.9.1" }, { tag: "v0.9.0" }]);
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));

  // The agent only reconnects (it did not restart). Before: nothing was ever sent.
  const back = await reconnect(node, "0.8.0");
  await drain();
  const request = (await back.waitFor("UpdateAgent"))[0];
  expect(request).toMatchObject({ targetVersion: "0.9.0", automatic: true });
  expect(new TextDecoder().decode(request.manifest)).toContain('"0.9.0"');

  const [original, retry] = stepsOf(node.nodeId);
  expect(retry?.run).toMatchObject({ trigger: "reconnect", targetVersion: "0.9.0", status: "running", startedBy: null });
  expect(original?.step).toMatchObject({ retry: "retried", retryRunId: retry?.run.id });
  await reportResult(back, 1, {
    target: UpdateTarget.AGENT,
    updateId: request.updateId,
    fromVersion: "0.8.0",
    toVersion: "0.9.0",
    success: true,
  });
  await drain();

  const history = await ok(callOp(panel, updates.history, {}, { cookie: owner.cookie }));
  expect(history.runs.map((r: Run) => [r.trigger, r.targetVersion, r.status])).toEqual([
    ["reconnect", "0.9.0", "succeeded"],
    ["manual", "0.9.0", "succeeded"],
  ]);
  expect(history.runs[1]?.steps[0]).toMatchObject({ status: "skipped", retry: "retried", retryRunId: history.runs[0]?.id });
  expect(history.runs[0]?.steps[0]).toMatchObject({ status: "succeeded", fromVersion: "0.8.0", toVersion: "0.9.0", retry: null });

  // Connecting again later sends nothing more.
  await goOffline(back);
  const again = await reconnect(node, "0.9.0");
  await drain();
  expect(again.requests("UpdateAgent")).toHaveLength(0);
  expect(panel.deps.db.select().from(updateRuns).all()).toHaveLength(2);
});

test("a later run that included the node supersedes the earlier skip: it gets the newer run's version", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  await runWhileOffline(node);
  serveReleases([{ tag: "v0.9.1" }, { tag: "v0.9.0" }]);
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  await ok(callOp(panel, updates.updatePanel, {}, { cookie: owner.cookie }));
  await drain();
  expect(stepsOf(node.nodeId).map((s) => [s.step.toVersion, s.step.retry])).toEqual([
    ["0.9.0", "superseded"],
    ["0.9.1", "waiting"],
  ]);
  const back = await reconnect(node, "0.8.0");
  await drain();
  expect((await back.waitFor("UpdateAgent")).map((r) => r.targetVersion)).toEqual(["0.9.1"]);
});

test("a node that rolled the version back is held, not retried; one already there is up to date", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const bad = await join("0.8.0");
  const fine = await join("0.8.0");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  await goOffline(fine);
  await runWhileOffline(bad);
  expect(stepsOf(bad.nodeId)[0]?.step.retry).toBe("waiting");
  expect(stepsOf(fine.nodeId)[0]?.step.retry).toBe("waiting");

  // It comes back having updated itself to 0.9.0 on start and rolled it back;
  // the result reaches the panel before the catch-up looks.
  const back = await reconnect(bad, "0.8.0");
  await reportResult(back, 1, {
    target: UpdateTarget.AGENT,
    updateId: "auto-0.9.0",
    fromVersion: "0.8.0",
    toVersion: "0.9.0",
    success: false,
    rolledBack: true,
  });
  expect(wasRolledBack(panel.deps.db, bad.nodeId, "0.9.0")).toBe(true);
  await drain();
  expect(back.requests("UpdateAgent")).toHaveLength(0);
  expect(stepsOf(bad.nodeId)[0]?.step).toMatchObject({ retry: "held", retryRunId: null });

  // The other one updated itself on start.
  const updated = await reconnect(fine, "0.9.0");
  await drain();
  expect(updated.requests("UpdateAgent")).toHaveLength(0);
  expect(stepsOf(fine.nodeId)[0]?.step.retry).toBe("up_to_date");
  const history = await ok(callOp(panel, updates.history, {}, { cookie: owner.cookie }));
  expect(history.runs).toHaveLength(1);
  expect(history.runs[0]?.steps.map((s: Run["steps"][number]) => s.retry).sort()).toEqual(["held", "upToDate"]);

  // Update now still installs the held release.
  await ok(callOp(panel, updates.updateNode, { nodeId: bad.nodeId }, { cookie: owner.cookie }));
  await drain();
  expect((await back.waitFor("UpdateAgent"))[0]).toMatchObject({ targetVersion: "0.9.0", automatic: false });
});

test("an agent that rolled the release back ends the catch-up step as skipped and held; the run does not fail", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  await runWhileOffline(node);
  const back = await reconnect(node, "0.8.0");
  const message = "0.9.0 was rolled back on this node (once); automatic updates to it wait until 2026-11-08 12:30 UTC.";
  back.handle("UpdateAgent", () => {
    throw new FakeStatus(StatusCode.FAILED_PRECONDITION, message, { backoff: "rolledBack", retryAfter: "2026-11-08T12:30:00Z" });
  });
  await drain();
  expect((await back.waitFor("UpdateAgent"))[0]?.automatic).toBe(true);
  const [original, retry] = stepsOf(node.nodeId);
  expect(original?.step).toMatchObject({ retry: "retried", retryRunId: retry?.run.id });
  expect(retry?.run).toMatchObject({ trigger: "reconnect", status: "succeeded" });
  // Not retried automatically, like the panel's own rollback record; Update now installs it.
  expect(retry?.step).toMatchObject({ status: "skipped", error: message, retry: "held" });
  await goOffline(back);
  const again = await reconnect(node, "0.8.0");
  await drain();
  expect(again.requests("UpdateAgent")).toHaveLength(0);
  expect(stepsOf(node.nodeId)).toHaveLength(2);
});

test("an agent whose automatic update failed within the hour gets the catch-up again when its wait is over", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  await runWhileOffline(node);
  const back = await reconnect(node, "0.8.0");
  const until = new Date(Date.now() + 40 * 60_000);
  const message = "updating to 0.9.0 failed less than an hour ago; automatic updates to it wait until then.";
  const shown = "Updating to 0.9.0 failed less than an hour ago; automatic updates to it wait until then.";
  back.handle("UpdateAgent", () => {
    throw new FakeStatus(StatusCode.FAILED_PRECONDITION, message, { backoff: "failed", retryAfter: until.toISOString() });
  });
  await drain();
  expect(back.requests("UpdateAgent")).toHaveLength(1);
  const first = stepsOf(node.nodeId)[1];
  expect(first?.run).toMatchObject({ trigger: "reconnect", status: "succeeded" });
  // Before: the catch-up ended here for good. Now the step waits for the end of the agent's wait.
  expect(first?.step).toMatchObject({ status: "skipped", error: shown, retry: "waiting" });
  const retryAt = first?.step.retryAt?.getTime() ?? 0;
  expect(retryAt).toBe(until.getTime() + 30_000);
  const queued = panel.deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "updates.catchUp"), eq(jobs.status, "queued")))
    .all();
  expect(queued.map((j) => j.runAt.getTime())).toEqual([retryAt]);

  // Reconnecting during the wait sends nothing and queues nothing more.
  const catchUpJobs = () => panel.deps.db.select().from(jobs).where(eq(jobs.type, "updates.catchUp")).all().length;
  const jobsBefore = catchUpJobs();
  await goOffline(back);
  const during = await reconnect(node, "0.8.0");
  await drain();
  expect(during.requests("UpdateAgent")).toHaveLength(0);
  expect(catchUpJobs()).toBe(jobsBefore);

  // The wait is over: the job queued for then sends the update again, in a run of its own.
  try {
    setSystemTime(new Date(retryAt + 1000));
    await drain();
    expect((await during.waitFor("UpdateAgent"))[0]).toMatchObject({ targetVersion: "0.9.0", automatic: true });
  } finally {
    setSystemTime();
  }
  const steps = stepsOf(node.nodeId);
  expect(steps).toHaveLength(3);
  expect(steps[1]?.step).toMatchObject({ retry: "retried", retryRunId: steps[2]?.run.id });
  expect(steps[2]?.run).toMatchObject({ trigger: "reconnect", status: "running" });
});

test("a connect with nothing to catch up writes no job", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0");
  await goOffline(node);
  await reconnect(node, "0.8.0");
  await drain();
  // Before: one succeeded "updates.catchUp" job per connect, kept 7 days.
  expect(panel.deps.db.select().from(jobs).where(eq(jobs.type, "updates.catchUp")).all()).toHaveLength(0);
});

test("while another run is active the catch-up waits for it", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  // Steps go by name: the offline node's comes first.
  const node = await join("0.8.0", "a-node");
  const busy = await join("0.8.0", "b-busy");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  await goOffline(node);
  // The node's own step is skipped; the other node's step keeps the run going.
  await ok(callOp(panel, updates.updatePanel, {}, { cookie: owner.cookie }));
  await drain();
  expect(stepsOf(node.nodeId)[0]?.step.retry).toBe("waiting");
  const back = await reconnect(node, "0.8.0");
  await drain();
  expect(back.requests("UpdateAgent")).toHaveLength(0);
  expect(stepsOf(node.nodeId)[0]?.step.retry).toBe("waiting");

  const busyStep = (await busy.waitFor("UpdateAgent"))[0].updateId;
  await reportResult(busy, 1, { target: UpdateTarget.AGENT, updateId: busyStep, toVersion: "0.9.0", success: true });
  await drain();
  const { catchUpRetryMs } = await import("../src/modules/updates/catch-up");
  await drain(new Date(Date.now() + catchUpRetryMs + 1000));
  expect((await back.waitFor("UpdateAgent"))[0]?.targetVersion).toBe("0.9.0");
});

test("the automatic run marks UpdateAgent automatic (Update now does not: see the held test)", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0");
  await ok(callOp(panel, updates.setAutoUpdate, { enabled: true }, { cookie: owner.cookie }));
  await checkJob.run({}, { ...panel.deps, jobId: "test", attempt: 1 });
  await drain();
  expect((await node.waitFor("UpdateAgent"))[0]).toMatchObject({ targetVersion: "0.9.0", automatic: true });
});

test("a disabled node is not caught up", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  await runWhileOffline(node);
  panel.deps.db.update(nodes).set({ disabledAt: new Date() }).where(eq(nodes.id, node.nodeId)).run();
  const { catchUp } = await import("../src/modules/updates/catch-up");
  expect(catchUp(panel.deps, node.nodeId)).toBe("offline");
  expect(stepsOf(node.nodeId)[0]?.step.retry).toBe("waiting");
});

test("a node that drops while UpdateAgent is in flight waits for its reconnect; the run does not fail", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  await runWhileOffline(node);
  // Back for the catch-up, then gone again before the agent answers.
  const back = await reconnect(node, "0.8.0");
  back.handle("UpdateAgent", () => new Promise(() => {}));
  const draining = drain();
  await back.waitFor("UpdateAgent");
  const [original, retry] = stepsOf(node.nodeId);
  expect(retry?.step.status).toBe("running");
  await goOffline(back);
  await draining;

  // Before: the step failed with "The node is offline. Try again when it is back.",
  // the run failed and nothing tried again.
  const run = panel.deps.db
    .select()
    .from(updateRuns)
    .where(eq(updateRuns.id, retry?.run.id ?? ""))
    .get();
  expect(run).toMatchObject({ trigger: "reconnect", status: "succeeded", error: null });
  const step = panel.deps.db
    .select()
    .from(updateSteps)
    .where(eq(updateSteps.id, retry?.step.id ?? ""))
    .get();
  expect(step).toMatchObject({ status: "skipped", error: "The node is offline; it gets the update when it reconnects.", retry: "waiting" });
  expect(
    panel.deps.db
      .select()
      .from(updateSteps)
      .where(eq(updateSteps.id, original?.step.id ?? ""))
      .get()?.retry,
  ).toBe("retried");

  // The next reconnect sends it again, in a run of its own.
  const again = await reconnect(node, "0.8.0");
  await drain();
  expect((await again.waitFor("UpdateAgent"))[0]).toMatchObject({ targetVersion: "0.9.0", automatic: true });
  const steps = stepsOf(node.nodeId);
  expect(steps).toHaveLength(3);
  expect(steps[1]?.step).toMatchObject({ retry: "retried", retryRunId: steps[2]?.run.id });
});

test("a person's run whose node drops mid-call skips it the same way", async () => {
  serveReleases([{ tag: "v0.9.0" }]);
  const node = await join("0.8.0");
  await ok(callOp(panel, updates.check, {}, { cookie: owner.cookie }));
  node.handle("UpdateAgent", () => new Promise(() => {}));
  const run = await ok(callOp(panel, updates.updateNode, { nodeId: node.nodeId }, { cookie: owner.cookie }));
  const draining = drain();
  await node.waitFor("UpdateAgent");
  await goOffline(node);
  await draining;
  expect(panel.deps.db.select().from(updateRuns).where(eq(updateRuns.id, run.id)).get()?.status).toBe("succeeded");
  expect(stepsOf(node.nodeId)[0]?.step).toMatchObject({ status: "skipped", retry: "waiting" });
});
