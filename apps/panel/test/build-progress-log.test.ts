// A build's progress lines ("Starting", "Fetching the source", "Building
// with Dockerfile") are in its deployment's log once. The agent sends every
// stage on the build's stream and also as an event (a final one as its
// durable report), and a stream opened again (a re-attach, also after a
// panel restart) replays the stages from the start. The panel logs a
// stage's message the first time it arrives, whichever way, and keeps
// what it logged on the build row (builds.progress_logged), so a restart
// does not log them again. Before 0.2.15 every one was logged twice in a row.

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
  await stopPanel();
  panel = testPanel({ panelPath: join(dir, "panel.db"), masterKey, dataDir: dir });
  fleet = new FakeFleet(panel);
  fleet.buildScript = script;
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

const progressEvent = (buildId: string, stage: BuildStage, extra: Record<string, unknown> = {}) =>
  fleet.emit(ra, { case: "buildProgress", value: create(BuildProgressSchema, { buildId, stage, ...extra }) });

for (const order of ["after", "before"] as const) {
  test(`each progress line is logged once when its event comes ${order} the stream's copy`, async () => {
    fleet.buildScript = agentLike(order);
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
