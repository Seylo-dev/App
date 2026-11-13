// A build's progress lines ("Starting", "Fetching the source", "Building
// with Dockerfile") are in its deployment's log once. The agent sends every
// stage on the build's stream and also as an event (a final one as its
// durable report), and a stream opened again (a re-attach, also after a
// panel restart) replays the stages from the start. The panel logs a
// stage's message the first time it arrives, whichever way, and keeps
// what it logged on the build row (builds.progress_logged), so a restart
// does not log them again. Once per run of the build (BuildProgress.run_id):
// an agent that restarted runs the build again from the start under the
// same id, and those stages are logged again. Before 0.2.15 every one was
// logged twice in a row.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import { deployments as deploymentOps, projects, services as serviceOps } from "@seylo/ops";
import { BuildProgressSchema, BuildStage } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { builds, services } from "../src/db/schema";
import { engineFor, unfinishedDeployments } from "../src/modules/deployments/engine";
import { type BuildScript, FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let target: string;
let ra: string;
let dir: string;
let masterKey: Uint8Array;

const queuedLine = "Waiting for 1 build(s) on this node";
const stageMessages = {
  [BuildStage.FETCHING_SOURCE]: "Fetching the source",
  [BuildStage.BUILDING]: "Building with Dockerfile",
  [BuildStage.PUSHING]: "Pushing the image",
};
const progressLines = [queuedLine, ...Object.values(stageMessages)];

/** Like the agent: QUEUED first, the stages after the slot with their messages and the build's output, held until the test ends it. */
const agentLike =
  (events: "before" | "after" | undefined, extra: Partial<ReturnType<BuildScript>> = {}): BuildScript =>
  () => ({
    queued: true,
    queuedMessage: queuedLine,
    logs: ["#1 building"],
    result: "held",
    digest: `sha256:${"b".repeat(64)}`,
    stageMessages,
    events,
    ...extra,
  });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seylo-build-progress-log-"));
  masterKey = crypto.getRandomValues(new Uint8Array(32));
  // On a file, so a test can restart the panel on the same database.
  panel = testPanel({ panelPath: join(dir, "panel.db"), masterKey, dataDir: dir });
  fleet = new FakeFleet(panel);
  target = fleet.addNode("app-node");
  ra = fleet.addNode("il-ra", { canBuild: true, panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  fleet.buildScript = agentLike("after");
});
afterEach(async () => {
  await stopPanel();
  rmSync(dir, { recursive: true, force: true });
});

async function stopPanel() {
  fleet.online.clear();
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  panel.close();
}

/** The panel stops and starts again on the same database; the node keeps the build and replays it from the start. */
async function restartPanel() {
  const script = fleet.buildScript;
  const runs = fleet.runs;
  await stopPanel();
  panel = testPanel({ panelPath: join(dir, "panel.db"), masterKey, dataDir: dir });
  fleet = new FakeFleet(panel);
  fleet.buildScript = script;
  for (const [buildId, run] of runs) fleet.runs.set(buildId, run);
  for (const id of [target, ra]) fleet.online.add(id);
}

async function app(name: string): Promise<string> {
  const res = await callOp(
    panel,
    serviceOps.create,
    {
      projectId,
      name,
      kind: "app",
      nodeId: target,
      source: { type: "inline" },
      ports: [{ containerPort: 3000, protocol: "tcp" }],
    } as never,
    { cookie },
  );
  expect(res.status).toBe(200);
  const id = res.body.id as string;
  const row = panel.deps.db.select().from(services).where(eq(services.id, id)).get();
  panel.deps.db
    .update(services)
    .set({ spec: { ...(row?.spec as object), build: { builder: "dockerfile", inlineDockerfile: "FROM nginx:1.27\n", buildNodeId: ra } } })
    .where(eq(services.id, id))
    .run();
  return id;
}

async function deploy(serviceId: string): Promise<{ deploymentId: string; buildId: string }> {
  const res = await callOp(panel, deploymentOps.deploy, { serviceId }, { cookie });
  expect(res.status).toBe(200);
  await fleet.settle();
  const build = panel.deps.db.select().from(builds).where(eq(builds.deploymentId, res.body.id)).get();
  return { deploymentId: res.body.id as string, buildId: build?.id as string };
}

async function logOf(serviceId: string, deploymentId: string): Promise<{ step: string; text: string; error: boolean }[]> {
  return (await callOp(panel, deploymentOps.log, { serviceId, deploymentId }, { cookie })).body.lines;
}

/** The progress lines in the log, in order (each one once when nothing doubles). */
async function progressIn(serviceId: string, deploymentId: string): Promise<string[]> {
  return (await logOf(serviceId, deploymentId)).map((l) => l.text).filter((t) => progressLines.includes(t));
}

async function startAndEnd(buildId: string, result: "succeeded" | "failed" = "succeeded") {
  fleet.grantSlot(buildId);
  await fleet.settle();
  fleet.endBuild(buildId, result);
  await fleet.settle();
}

async function tick() {
  const engine = engineFor(panel.deps);
  for (const id of unfinishedDeployments(panel.deps)) engine.kick(id);
  await fleet.settle();
}

/** A BuildProgress event of the build's current run on the agent, like the agent's. */
const progressEvent = (buildId: string, stage: BuildStage, extra: Record<string, unknown> = {}) =>
  fleet.emit(ra, {
    case: "buildProgress",
    value: create(BuildProgressSchema, { buildId, runId: fleet.runIdOf(buildId), stage, ...extra }),
  });

for (const [order, agent] of [
  ["after", "0.2.15"],
  ["before", "0.2.15"],
  ["after", "0.2.14"],
  ["before", "0.2.14"],
] as const) {
  test(`each progress line is logged once when its event comes ${order} the stream's copy (agent ${agent})`, async () => {
    // Agents before 0.2.15 send no run id: once per build.
    fleet.buildScript = agentLike(order, agent === "0.2.14" ? { noRunId: true } : {});
    const web = await app("web");
    const { deploymentId, buildId } = await deploy(web);
    expect(await progressIn(web, deploymentId)).toEqual([queuedLine]);
    await startAndEnd(buildId);

    expect(await progressIn(web, deploymentId)).toEqual(progressLines);
    const log = await logOf(web, deploymentId);
    expect(log.find((l) => l.text === "Fetching the source")?.step).toBe("clone");
    expect(log.find((l) => l.text === "Building with Dockerfile")?.step).toBe("build");
    // The build's own output comes on the stream alone, once.
    expect(log.filter((l) => l.text === "#1 building")).toHaveLength(1);
    expect(panel.deps.db.select().from(builds).where(eq(builds.id, buildId)).get()?.status).toBe("succeeded");
  });
}

test("a re-attached stream replays the stages without logging them again, also after a panel restart", async () => {
  const web = await app("web");
  const { deploymentId, buildId } = await deploy(web);
  expect(await progressIn(web, deploymentId)).toEqual([queuedLine]);

  // The stream drops while the build waits: the runner opens it again and the agent replays QUEUED.
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  expect(fleet.calls.filter((c) => c.method === "build")).toHaveLength(2);
  expect(await progressIn(web, deploymentId)).toEqual([queuedLine]);

  // The panel restarts: the new runner follows the build again, the agent replays it (here with its events
  // again too), and the QUEUED event of before the restart comes in late.
  await restartPanel();
  await tick();
  expect(fleet.calls.filter((c) => c.method === "build")).toHaveLength(1);
  progressEvent(buildId, BuildStage.QUEUED, { message: queuedLine });
  await fleet.settle();
  expect(await progressIn(web, deploymentId)).toEqual([queuedLine]);

  await startAndEnd(buildId);
  expect(await progressIn(web, deploymentId)).toEqual(progressLines);
  const log = (await logOf(web, deploymentId)).map((l) => l.text);
  expect(log.filter((t) => t === "Following the build again after a panel restart.")).toHaveLength(2);
});

test("a build its agent starts over (the agent restarted) logs its stages again, each once per run", async () => {
  const web = await app("web");
  const { deploymentId, buildId } = await deploy(web);
  fleet.grantSlot(buildId);
  await fleet.settle();
  const firstRun = [queuedLine, "Fetching the source", "Building with Dockerfile"];
  expect(await progressIn(web, deploymentId)).toEqual(firstRun);
  const firstRunId = fleet.runIdOf(buildId);

  // The build node's agent restarts mid-build: the stream drops, and once the node is back the runner follows the
  // build again. The agent no longer has it (it keeps builds in memory) and runs it again from the start, as
  // another run that waits for a slot and sends its stages on the stream and as events again.
  fleet.online.delete(ra);
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  fleet.restartAgent(ra);
  fleet.online.add(ra);
  await tick();
  expect(fleet.calls.filter((c) => c.method === "build")).toHaveLength(2);
  expect(await progressIn(web, deploymentId)).toEqual([...firstRun, queuedLine]);

  // The panel restarts while the second run waits: its replay and a late event of the first run log nothing.
  await restartPanel();
  await tick();
  expect(fleet.calls.filter((c) => c.method === "build")).toHaveLength(1);
  progressEvent(buildId, BuildStage.BUILDING, { message: "Building with Dockerfile", runId: firstRunId });
  await fleet.settle();
  expect(await progressIn(web, deploymentId)).toEqual([...firstRun, queuedLine]);

  await startAndEnd(buildId);
  expect(await progressIn(web, deploymentId)).toEqual([...firstRun, ...progressLines]);
  expect(panel.deps.db.select().from(builds).where(eq(builds.id, buildId)).get()?.status).toBe("succeeded");
});

test("a run id the agent sends is cut to 64 characters in the logged keys", async () => {
  const web = await app("web");
  const { buildId } = await deploy(web);
  progressEvent(buildId, BuildStage.QUEUED, { message: "Waiting for 2 build(s) on this node", runId: "r".repeat(10_000) });
  await fleet.settle();
  const logged = panel.deps.db.select().from(builds).where(eq(builds.id, buildId)).get()?.progressLogged ?? [];
  expect(logged.at(-1)).toBe(`${"r".repeat(64)}:${BuildStage.QUEUED}:Waiting for 2 build(s) on this node`);
});

test("a stage only the stream brings, or only an event, is logged", async () => {
  // The stream only (the agent's events were dropped).
  fleet.buildScript = agentLike(undefined);
  const web = await app("web");
  const first = await deploy(web);
  await startAndEnd(first.buildId);
  expect(await progressIn(web, first.deploymentId)).toEqual(progressLines);

  // Events only: the connection dropped while the build waited, and the stages come as events before any re-attach.
  const api = await app("api");
  const second = await deploy(api);
  fleet.online.delete(ra);
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  for (const stage of [BuildStage.FETCHING_SOURCE, BuildStage.BUILDING, BuildStage.PUSHING] as const) {
    progressEvent(second.buildId, stage, { message: stageMessages[stage] });
    await fleet.settle();
  }
  progressEvent(second.buildId, BuildStage.SUCCEEDED, { imageDigest: `sha256:${"c".repeat(64)}`, duration: durationFromMs(30_000) });
  await fleet.settle();
  expect(await progressIn(api, second.deploymentId)).toEqual(progressLines);
  expect(panel.deps.db.select().from(builds).where(eq(builds.id, second.buildId)).get()?.status).toBe("succeeded");
});

test("the same message from another build or another stage is a new line, and a failure is logged once", async () => {
  fleet.buildScript = agentLike("before", { message: "exit code 1" });
  const web = await app("web");
  const failures = [];
  for (let i = 0; i < 2; i++) {
    const { deploymentId, buildId } = await deploy(web);
    await startAndEnd(buildId, "failed");
    failures.push(deploymentId);
  }
  for (const deploymentId of failures) {
    const log = await logOf(web, deploymentId);
    // Each build's stages and its failure, sent on both ways, once in its own log.
    expect(await progressIn(web, deploymentId)).toEqual([queuedLine, "Fetching the source", "Building with Dockerfile"]);
    expect(log.filter((l) => l.text === "exit code 1").map((l) => l.error)).toEqual([true]);
  }

  // Another stage with the same message as one logged before is not the same line.
  const { deploymentId, buildId } = await deploy(web);
  progressEvent(buildId, BuildStage.FETCHING_SOURCE, { message: queuedLine });
  await fleet.settle();
  const log = await logOf(web, deploymentId);
  expect(log.filter((l) => l.text === queuedLine).map((l) => l.step)).toEqual(["clone", "clone"]);
});

test("a progress line reaches the live topic only after its transaction committed", async () => {
  const client = (panel.deps.db as unknown as { $client: Database }).$client;
  const publish = panel.deps.live.publish.bind(panel.deps.live);
  const inTransaction: string[] = [];
  panel.deps.live.publish = (topic, event) => {
    // Before: the line went out from inside the transaction that stored it, so a rollback left tabs with a line
    // that was never kept.
    if (client.inTransaction) inTransaction.push(`${topic} ${event.type}`);
    publish(topic, event);
  };
  const web = await app("web");
  const { deploymentId, buildId } = await deploy(web);
  await startAndEnd(buildId);
  expect(await progressIn(web, deploymentId)).toEqual(progressLines);
  expect(inTransaction).toEqual([]);
});
