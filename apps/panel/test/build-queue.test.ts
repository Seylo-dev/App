// Builds that wait for a slot of their node's Builds at once (added in
// 0.2.15). The agent queues a build it has no slot for and reports
// BUILD_STAGE_QUEUED; the build row stays queued (startedAt null) until a
// stage after the slot arrives, then runs from that moment. Waiting builds
// say so on their deployment (buildWait, the clone step), their service
// (buildWaiting), builds.queue and the build node list, with their place in
// line, and move up when a build ahead starts, ends or is cancelled.
// Places follow the order builds reach their node's agent (the hand-over),
// which serves them first come, first served.

import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import {
  builds as buildOps,
  deployments as deploymentOps,
  type LiveTopic,
  nodes as nodeOps,
  previews as previewOps,
  projects,
  services as serviceOps,
} from "@seylo/ops";
import { BuildProgressSchema, BuildStage, NodeFactsSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { builds, nodes, previews, services, sourceUploads } from "../src/db/schema";
import { buildTimeoutMs, engineFor, queuedBuildTimeoutMs, unfinishedDeployments } from "../src/modules/deployments/engine";
import { pickBuildNode } from "../src/modules/deployments/source";
import { defaultSpec } from "../src/modules/services/spec";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let target: string;
let ra: string;
let tlv: string;
let dir: string;
let masterKey: Uint8Array;

beforeEach(async () => {
  setSystemTime();
  dir = mkdtempSync(join(tmpdir(), "seylo-build-queue-"));
  mkdirSync(join(dir, "uploads"), { recursive: true });
  masterKey = crypto.getRandomValues(new Uint8Array(32));
  // On a file, so a test can restart the panel on the same database.
  panel = testPanel({ panelPath: join(dir, "panel.db"), masterKey, dataDir: dir });
  fleet = new FakeFleet(panel);
  target = fleet.addNode("app-node");
  // Builds at once is 1 on both builders: new nodes are on Auto, which gives 1 until a node reports its cores and memory.
  ra = fleet.addNode("il-ra", { canBuild: true, panelNode: true });
  tlv = fleet.addNode("il-tlv", { canBuild: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  // Every build waits in the agent's queue until the test gives it its slot, then runs until endBuild.
  fleet.buildScript = () => ({ queued: true, result: "held", digest: `sha256:${"b".repeat(64)}` });
});
afterEach(async () => {
  await stopPanel();
  setSystemTime();
  rmSync(dir, { recursive: true, force: true });
});

/** Held streams end as if the nodes went away, then the database closes. */
async function stopPanel() {
  fleet.online.clear();
  fleet.releaseUploads();
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  panel.close();
}

/** The panel stops and starts again on the same database: its deploy runner starts from nothing, the nodes keep their builds. */
async function restartPanel() {
  const script = fleet.buildScript;
  await stopPanel();
  panel = testPanel({ panelPath: join(dir, "panel.db"), masterKey, dataDir: dir });
  fleet = new FakeFleet(panel);
  fleet.buildScript = script;
  for (const id of [target, ra, tlv]) fleet.online.add(id);
}

/** An app with an inline Dockerfile that builds on the given node. */
async function app(name: string, buildNodeId: string): Promise<string> {
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
    .set({ spec: { ...(row?.spec as object), build: { builder: "dockerfile", inlineDockerfile: "FROM nginx:1.27\n", buildNodeId } } })
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

async function deployment(serviceId: string, deploymentId: string) {
  return (await callOp(panel, deploymentOps.get, { serviceId, deploymentId }, { cookie })).body.deployment;
}

const buildRow = (id: string) => panel.deps.db.select().from(builds).where(eq(builds.id, id)).get();
const cloneDetail = (d: { steps: { key: string; detail: string }[] }) => d.steps.find((s) => s.key === "clone")?.detail;

async function queue(nodeId?: string) {
  const res = await callOp(panel, buildOps.queue, nodeId ? { nodeId } : {}, { cookie });
  expect(res.status).toBe(200);
  return res.body.builds as {
    id: string;
    status: string;
    position: number | null;
    waiting: boolean;
    nodeId: string;
    startedAt: string | null;
  }[];
}

async function start(buildId: string) {
  fleet.grantSlot(buildId);
  await fleet.settle();
}

async function end(buildId: string, result: "succeeded" | "failed" = "succeeded") {
  fleet.endBuild(buildId, result);
  await fleet.settle();
}

async function tick() {
  const engine = engineFor(panel.deps);
  for (const id of unfinishedDeployments(panel.deps)) engine.kick(id);
  await fleet.settle();
}

/** Waits for cond without fleet.settle (which waits for every deploy runner, also one held on purpose). */
async function until(cond: () => boolean) {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
}

const buildOf = (deploymentId: string) => panel.deps.db.select().from(builds).where(eq(builds.deploymentId, deploymentId)).get();
const handedOver = (deploymentId: string) =>
  fleet.calls.some((c) => c.method === "build" && (c.request as { buildId: string }).buildId === buildOf(deploymentId)?.id);

test("a build is queued until its node starts it: QUEUED alone keeps it queued, the first stage after the slot runs it", async () => {
  const web = await app("web", ra);
  const { deploymentId, buildId } = await deploy(web);

  // The agent said QUEUED ("Starting" or "Waiting for ..."): still queued, never started.
  expect(buildRow(buildId)).toMatchObject({ status: "queued", startedAt: null });
  let d = await deployment(web, deploymentId);
  expect(d.status).toBe("building");
  // The only build of a node with a free slot is about to start, not waiting.
  expect(d.buildWait).toBeNull();
  expect((await queue())[0]).toMatchObject({ id: buildId, status: "queued", position: 1, waiting: false, startedAt: null });
  const log = (await callOp(panel, deploymentOps.log, { serviceId: web, deploymentId }, { cookie })).body.lines;
  expect(log.find((l: { text: string }) => l.text === "Waiting for 1 build(s) on this node")?.step).toBe("clone");

  const before = Date.now();
  await start(buildId);
  const row = buildRow(buildId);
  expect(row?.status).toBe("running");
  expect(row?.startedAt?.getTime()).toBeGreaterThanOrEqual(before);
  expect((await queue())[0]).toMatchObject({ id: buildId, status: "running", position: null, waiting: false });
  d = await deployment(web, deploymentId);
  expect(d.steps.map((s: { status: string }) => s.status)).toEqual(["ok", "running", "pending", "pending", "pending"]);
  await end(buildId);
});

test("waiting builds show their place in line per node, and move up when a build ahead ends or starts", async () => {
  const [a, b, c, other] = [await app("a", ra), await app("b", ra), await app("c", ra), await app("other", tlv)];
  const first = await deploy(a);
  await start(first.buildId);
  const second = await deploy(b);
  const third = await deploy(c);
  const elsewhere = await deploy(other);

  // il-ra runs a; b and c wait for its one slot. il-tlv has a free slot for other.
  let db = await deployment(b, second.deploymentId);
  expect(db.buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 1 });
  expect(cloneDetail(db)).toBe("Waiting for a build slot on il-ra - next in line");
  let dc = await deployment(c, third.deploymentId);
  expect(dc.buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 2 });
  expect(cloneDetail(dc)).toBe("Waiting for a build slot on il-ra - 1 ahead");
  expect((await deployment(other, elsewhere.deploymentId)).buildWait).toBeNull();
  expect(cloneDetail(await deployment(other, elsewhere.deploymentId))).not.toContain("Waiting");

  // The service and its list row say so too; a deploy that runs does not.
  expect((await callOp(panel, serviceOps.get, { serviceId: b }, { cookie })).body).toMatchObject({
    status: "building",
    buildWaiting: true,
  });
  expect((await callOp(panel, serviceOps.get, { serviceId: a }, { cookie })).body).toMatchObject({
    status: "building",
    buildWaiting: false,
  });
  const listed = (await callOp(panel, serviceOps.list, { projectId }, { cookie })).body.services as { id: string; buildWaiting: boolean }[];
  expect(
    listed
      .filter((s) => s.buildWaiting)
      .map((s) => s.id)
      .sort(),
  ).toEqual([b, c].sort());

  // builds.queue: positions count per node; one node's queue alone.
  expect((await queue()).map((q) => [q.id, q.status, q.position, q.waiting])).toEqual([
    [first.buildId, "running", null, false],
    [second.buildId, "queued", 1, true],
    [third.buildId, "queued", 2, true],
    [elsewhere.buildId, "queued", 1, false],
  ]);
  expect((await queue(tlv)).map((q) => q.id)).toEqual([elsewhere.buildId]);

  // The Source tab's node list: how many hold a slot and how many wait.
  const settings = (await callOp(panel, buildOps.getSettings, { serviceId: a }, { cookie })).body;
  const nodeRow = (id: string) => settings.nodes.find((n: { id: string }) => n.id === id);
  expect(nodeRow(ra)).toMatchObject({ queued: 3, running: 1, waiting: 2 });
  expect(nodeRow(tlv)).toMatchObject({ queued: 1, running: 1, waiting: 0 });
  expect(nodeRow(target)).toMatchObject({ queued: 0, running: 0, waiting: 0 });

  // a ends: b has the free slot (about to start), c is next behind it, and c's page hears it.
  const events: { type: string; deployment?: { buildWait: unknown; steps: { key: string; detail: string }[] } }[] = [];
  panel.deps.live.subscribe(
    { id: "tab", send: (m) => events.push((m as { event: (typeof events)[number] }).event) },
    `deployment:${third.deploymentId}`,
  );
  await end(first.buildId);
  db = await deployment(b, second.deploymentId);
  expect(db.buildWait).toBeNull();
  dc = await deployment(c, third.deploymentId);
  expect(dc.buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 2 });
  const pushed = events.filter((e) => e.type === "deployment").at(-1);
  expect(pushed?.deployment?.buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 2 });

  // b starts: c is next in line.
  events.length = 0;
  await start(second.buildId);
  dc = await deployment(c, third.deploymentId);
  expect(dc.buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 1 });
  expect(cloneDetail(dc)).toBe("Waiting for a build slot on il-ra - next in line");
  expect(cloneDetail(events.filter((e) => e.type === "deployment").at(-1)?.deployment as never)).toBe(
    "Waiting for a build slot on il-ra - next in line",
  );

  // More slots on the node: c is no longer waiting, and says so at once.
  const raised = await callOp(panel, nodeOps.updateSettings, { nodeId: ra, maxParallelBuilds: 2 }, { cookie });
  expect(raised.status).toBe(200);
  expect((await deployment(c, third.deploymentId)).buildWait).toBeNull();
  expect(events.filter((e) => e.type === "deployment").at(-1)?.deployment?.buildWait).toBeNull();
});

test("cancelling a queued build reaches its node and takes it out of the queue", async () => {
  const [a, b, c] = [await app("a", ra), await app("b", ra), await app("c", ra)];
  const first = await deploy(a);
  await start(first.buildId);
  const second = await deploy(b);
  const third = await deploy(c);
  expect((await deployment(c, third.deploymentId)).buildWait?.position).toBe(2);

  const res = await callOp(panel, deploymentOps.cancel, { serviceId: b, deploymentId: second.deploymentId }, { cookie });
  expect(res.body.status).toBe("cancelled");
  await fleet.settle();
  // The agent drops it from its queue (go/internal/build Cancel), so the call must reach the node.
  expect(
    fleet.calls.filter((call) => call.method === "cancelBuild").map((call) => [call.nodeId, (call.request as { buildId: string }).buildId]),
  ).toEqual([[ra, second.buildId]]);
  // Cancelled before it ever started.
  expect(buildRow(second.buildId)).toMatchObject({ status: "cancelled", startedAt: null });
  expect((await queue()).map((q) => q.id)).toEqual([first.buildId, third.buildId]);
  const dc = await deployment(c, third.deploymentId);
  expect(dc.buildWait?.position).toBe(1);
  expect(cloneDetail(dc)).toBe("Waiting for a build slot on il-ra - next in line");
});

test("built in Xs counts from the real start, and the clone step leaves out the wait", async () => {
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  const web = await app("web", ra);
  const { deploymentId, buildId } = await deploy(web);

  // Ten minutes in the agent's queue.
  setSystemTime(new Date(t0 + 10 * 60_000));
  await start(buildId);
  expect(buildRow(buildId)?.startedAt?.getTime()).toBe(t0 + 10 * 60_000);
  setSystemTime(new Date(t0 + 10 * 60_000 + 30_000));
  await end(buildId);

  const d = await deployment(web, deploymentId);
  const clone = d.steps.find((s: { key: string }) => s.key === "clone");
  const build = d.steps.find((s: { key: string }) => s.key === "build");
  expect(clone.status).toBe("ok");
  expect(clone.durationMs).toBeLessThan(60_000);
  // The fake agent reports 4s; the panel measured 30s from the start it saw.
  expect(build.detail).toBe("Dockerfile on il-ra in 30s");
  expect(buildRow(buildId)).toMatchObject({ status: "succeeded" });
  expect(buildRow(buildId)?.finishedAt?.getTime()).toBe(t0 + 10 * 60_000 + 30_000);
});

test("a final result with no start seen (the progress was lost) still ends the build, timed by the agent", async () => {
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  const web = await app("web", ra);
  const { deploymentId, buildId } = await deploy(web);
  // The connection drops while the build waits, and nothing comes back but the durable result.
  fleet.online.delete(ra);
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  expect(buildRow(buildId)).toMatchObject({ status: "queued", startedAt: null });

  setSystemTime(new Date(t0 + 5 * 60_000));
  fleet.emit(ra, {
    case: "buildProgress",
    value: create(BuildProgressSchema, {
      buildId,
      stage: BuildStage.SUCCEEDED,
      imageDigest: `sha256:${"c".repeat(64)}`,
      duration: durationFromMs(90_000),
    }),
  });
  await fleet.settle();
  const row = buildRow(buildId);
  expect(row?.status).toBe("succeeded");
  expect(row?.startedAt?.getTime()).toBe(t0 + 5 * 60_000 - 90_000);
  const d = await deployment(web, deploymentId);
  expect(d.status).toBe("deploying");
  expect(d.steps.find((s: { key: string }) => s.key === "build").detail).toBe("Dockerfile on il-ra in 90s");
});

test("a re-attached stream of a queued build keeps it queued until the start comes again", async () => {
  const web = await app("web", ra);
  const { deploymentId, buildId } = await deploy(web);
  const handed = buildRow(buildId)?.handedOverAt?.getTime();
  expect(handed).toBeNumber();
  // The stream drops (as after a panel restart): the runner opens the build again and the agent replays QUEUED.
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  expect(fleet.calls.filter((c) => c.method === "build")).toHaveLength(2);
  // The agent re-attaches to the build it has, so its place in the queue stays.
  expect(buildRow(buildId)).toMatchObject({ status: "queued", startedAt: null });
  expect(buildRow(buildId)?.handedOverAt?.getTime()).toBe(handed as number);
  await start(buildId);
  expect(buildRow(buildId)?.status).toBe("running");
  expect((await deployment(web, deploymentId)).status).toBe("building");
  await end(buildId);
  expect(buildRow(buildId)?.status).toBe("succeeded");
});

test("a queued build waits past the build timeout while its node's queue moves, and fails once it stops", async () => {
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  const [a, b] = [await app("a", ra), await app("b", ra)];
  const first = await deploy(a);
  await start(first.buildId);
  const second = await deploy(b);

  // The running one times out from its start; the queued one behind it does not, its queue just moved.
  setSystemTime(new Date(t0 + buildTimeoutMs + 60_000));
  await tick();
  expect(buildRow(first.buildId)?.status).toBe("failed");
  expect(buildRow(second.buildId)?.status).toBe("queued");
  expect((await deployment(b, second.deploymentId)).status).toBe("building");

  // The node never starts it (it lost the build): once nothing moved there for the timeout, it fails and is cancelled there.
  setSystemTime(new Date(t0 + 2 * buildTimeoutMs + 2 * 60_000));
  await tick();
  expect(buildRow(second.buildId)?.status).toBe("failed");
  const d = await deployment(b, second.deploymentId);
  expect(d.status).toBe("failed");
  expect(d.error).toBe("The build never started: no build started or finished on il-ra for 90 minutes while it waited for a build slot.");
  expect(fleet.calls.some((c) => c.method === "cancelBuild" && (c.request as { buildId: string }).buildId === second.buildId)).toBe(true);
});

test("a node without Can build runs one build at a time, like its agent", async () => {
  const [a, b] = [await app("a", ra), await app("b", ra)];
  panel.deps.db.update(nodes).set({ parallelBuildsAuto: false, maxParallelBuilds: 4 }).where(eq(nodes.id, ra)).run();
  const first = await deploy(a);
  await start(first.buildId);
  const second = await deploy(b);
  expect((await deployment(b, second.deploymentId)).buildWait).toBeNull();
  // The panel sends max_parallel_builds 0 without Can build, which the agent runs as 1.
  panel.deps.db.update(nodes).set({ canBuild: false }).where(eq(nodes.id, ra)).run();
  expect((await deployment(b, second.deploymentId)).buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 1 });
});

/** An app built from an uploaded archive whose upload to the build node waits until fleet.releaseUpload. */
async function slowUploadApp(name: string, buildNodeId: string): Promise<{ serviceId: string; uploadId: string }> {
  const serviceId = await app(name, buildNodeId);
  const upload = panel.deps.db
    .insert(sourceUploads)
    .values({ serviceId, fileName: `${name}.tar.gz`, sizeBytes: 4, sha256: "0".repeat(64) })
    .returning()
    .get();
  writeFileSync(join(dir, "uploads", `${upload.id}.tar.gz`), "data");
  const row = panel.deps.db.select().from(services).where(eq(services.id, serviceId)).get();
  panel.deps.db
    .update(services)
    .set({ spec: { ...(row?.spec as object), source: { type: "upload", fileName: `${name}.tar.gz` } } })
    .where(eq(services.id, serviceId))
    .run();
  fleet.holdUpload(upload.id);
  return { serviceId, uploadId: upload.id };
}

const uploading = (uploadId: string) =>
  fleet.calls.some((call) => call.method === "uploadBuildContext" && (call.request as { uploadId: string }).uploadId === uploadId);

test("queue places follow the order builds reach their node, not the order they were dispatched", async () => {
  const [a, b, c] = [await app("a", ra), await app("b", ra), await app("c", ra)];
  // u builds an uploaded archive, which takes a while to send to il-ra.
  const { serviceId: u, uploadId } = await slowUploadApp("u", ra);
  const first = await deploy(a);
  await start(first.buildId);

  // u is dispatched first and b second, but b reaches il-ra while u's archive is still on its way.
  const uDeploy = (await callOp(panel, deploymentOps.deploy, { serviceId: u }, { cookie })).body.id as string;
  await until(() => uploading(uploadId));
  const bDeploy = (await callOp(panel, deploymentOps.deploy, { serviceId: b }, { cookie })).body.id as string;
  await until(() => handedOver(bDeploy));
  const [uBuild, bBuild] = [buildOf(uDeploy), buildOf(bDeploy)];
  expect(uBuild?.createdAt.getTime()).toBeLessThanOrEqual(bBuild?.createdAt.getTime() as number);
  expect(uBuild?.handedOverAt).toBeNull();
  const [uId, bId] = [uBuild?.id as string, bBuild?.id as string];

  // Not on the node yet, u joins its queue behind every build il-ra has: b is next in line.
  expect((await queue()).map((q) => [q.id, q.status, q.position, q.waiting])).toEqual([
    [first.buildId, "running", null, false],
    [bId, "queued", 1, true],
    [uId, "queued", 2, true],
  ]);
  expect(cloneDetail(await deployment(b, bDeploy))).toBe("Waiting for a build slot on il-ra - next in line");
  expect(cloneDetail(await deployment(u, uDeploy))).toBe("Waiting for a build slot on il-ra - 1 ahead");

  // The archive arrives and u is handed over: still behind b, and ahead of a build sent after it.
  fleet.releaseUpload(uploadId);
  await fleet.settle();
  expect(buildOf(uDeploy)?.handedOverAt?.getTime()).toBeGreaterThanOrEqual(buildOf(bDeploy)?.handedOverAt?.getTime() as number);
  const third = await deploy(c);
  expect((await queue(ra)).map((q) => [q.id, q.position])).toEqual([
    [first.buildId, null],
    [bId, 1],
    [uId, 2],
    [third.buildId, 3],
  ]);

  // a ends and the agent starts b, the one that reached it first: u is next in line.
  await end(first.buildId);
  await start(bId);
  expect((await deployment(u, uDeploy)).buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 1 });
  expect((await deployment(c, third.deploymentId)).buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 2 });
});

test("a build that reaches its node ahead of one sent there before it tells that one it moved back", async () => {
  const first = await deploy(await app("a", ra));
  await start(first.buildId);
  const [u, v] = [await slowUploadApp("u", ra), await slowUploadApp("v", ra)];
  const uDeploy = (await callOp(panel, deploymentOps.deploy, { serviceId: u.serviceId }, { cookie })).body.id as string;
  await until(() => uploading(u.uploadId));
  const vDeploy = (await callOp(panel, deploymentOps.deploy, { serviceId: v.serviceId }, { cookie })).body.id as string;
  await until(() => uploading(v.uploadId));
  // Neither is on il-ra yet: in the order they were sent.
  expect((await deployment(u.serviceId, uDeploy)).buildWait?.position).toBe(1);
  expect((await deployment(v.serviceId, vDeploy)).buildWait?.position).toBe(2);

  const events: { type: string; deployment?: { buildWait: { position: number } | null } }[] = [];
  panel.deps.live.subscribe(
    { id: "tab", send: (m) => events.push((m as { event: (typeof events)[number] }).event) },
    `deployment:${uDeploy}`,
  );
  // v's archive arrives first: v is next in line, and u's page hears that it is behind v now.
  fleet.releaseUpload(v.uploadId);
  await until(() => handedOver(vDeploy));
  expect((await deployment(u.serviceId, uDeploy)).buildWait?.position).toBe(2);
  expect(events.filter((e) => e.type === "deployment").at(-1)?.deployment?.buildWait?.position).toBe(2);
});

test("a queued build the runner never handed over takes its place when it is handed over after a restart", async () => {
  const [a, b, c, d] = [await app("a", ra), await app("b", ra), await app("c", ra), await app("d", ra)];
  const first = await deploy(a);
  await start(first.buildId);
  const second = await deploy(b);
  const third = await deploy(c);
  // As if the panel stopped while it fetched b's source, before its Build call.
  panel.deps.db.update(builds).set({ handedOverAt: null }).where(eq(builds.id, second.buildId)).run();
  expect((await queue(ra)).map((q) => [q.id, q.position])).toEqual([
    [first.buildId, null],
    [third.buildId, 1],
    [second.buildId, 2],
  ]);

  // The runner opens every build again: b reaches il-ra now, behind c and ahead of a build sent later.
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  expect(buildRow(second.buildId)?.handedOverAt).not.toBeNull();
  const fourth = await deploy(d);
  expect((await queue(ra)).map((q) => [q.id, q.position])).toEqual([
    [first.buildId, null],
    [third.buildId, 1],
    [second.buildId, 2],
    [fourth.buildId, 3],
  ]);
});

test("a queued build its node lost fails after hours of waiting, also while the node keeps building others", async () => {
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  const web = await app("lost", ra);
  const lost = await deploy(web);
  const hour = 60 * 60_000;
  const hours = queuedBuildTimeoutMs / hour;
  expect(hours).toBe(6);

  // il-ra no longer has it (its agent restarted while it waited), and goes on building what comes after it, every hour.
  for (let h = 1; h <= hours; h++) {
    setSystemTime(new Date(t0 + h * hour));
    const other = await deploy(await app(`other-${h}`, ra));
    await start(other.buildId);
    await end(other.buildId);
    await tick();
    expect(buildRow(lost.buildId)?.status).toBe("queued");
  }

  setSystemTime(new Date(t0 + hours * hour + 60_000));
  await tick();
  expect(buildRow(lost.buildId)?.status).toBe("failed");
  const d = await deployment(web, lost.deploymentId);
  expect(d.status).toBe("failed");
  expect(d.error).toBe("The build never started: it waited 6 hours for a build slot on il-ra.");
  expect(fleet.calls.some((c) => c.method === "cancelBuild" && (c.request as { buildId: string }).buildId === lost.buildId)).toBe(true);
});

test("after a panel restart the clone step still leaves out the wait for a slot", async () => {
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  const web = await app("web", ra);
  const { deploymentId, buildId } = await deploy(web);

  // The panel restarts while the build waits on il-ra; the new runner follows it again.
  setSystemTime(new Date(t0 + 60_000));
  await restartPanel();
  await tick();
  expect(fleet.calls.filter((c) => c.method === "build")).toHaveLength(1);
  expect(buildRow(buildId)).toMatchObject({ status: "queued", startedAt: null });

  setSystemTime(new Date(t0 + 10 * 60_000));
  await start(buildId);
  setSystemTime(new Date(t0 + 10 * 60_000 + 30_000));
  await end(buildId);
  const d = await deployment(web, deploymentId);
  expect(d.steps.find((s: { key: string }) => s.key === "clone").durationMs).toBeLessThan(60_000);
  expect(d.steps.find((s: { key: string }) => s.key === "build").detail).toBe("Dockerfile on il-ra in 30s");
});

test("the automatic build node has the most free build slots, then the fewest builds in flight, then the first name", async () => {
  const auto = defaultSpec();
  // il-ra runs 8 builds at once and has 3, il-tlv runs 1 and has 1: il-ra has 5 free slots and il-tlv none.
  panel.deps.db.update(nodes).set({ parallelBuildsAuto: false, maxParallelBuilds: 8 }).where(eq(nodes.id, ra)).run();
  for (const name of ["a", "b", "c"]) await deploy(await app(name, ra));
  await deploy(await app("d", tlv));
  expect(pickBuildNode(panel.deps, auto, [target])).toMatchObject({ id: ra, name: "il-ra" });
  // The Source tab's node list gives the web app the same numbers, so it names the same node.
  const listed = (await callOp(panel, buildOps.getSettings, { serviceId: await app("e", ra) }, { cookie })).body.nodes;
  expect(listed.find((n: { id: string }) => n.id === ra)).toMatchObject({ queued: 3, buildsAtOnce: 8 });
  expect(listed.find((n: { id: string }) => n.id === tlv)).toMatchObject({ queued: 1, buildsAtOnce: 1 });

  // One free slot each (3 of 4 and 1 of 2): the node with fewer builds in flight.
  panel.deps.db.update(nodes).set({ parallelBuildsAuto: false, maxParallelBuilds: 4 }).where(eq(nodes.id, ra)).run();
  panel.deps.db.update(nodes).set({ parallelBuildsAuto: false, maxParallelBuilds: 2 }).where(eq(nodes.id, tlv)).run();
  expect(pickBuildNode(panel.deps, auto, [target]).id).toBe(tlv);
  // Three builds on each, both full: 2 wait for il-ra's one slot and 1 for il-tlv's two, so il-tlv starts it sooner.
  await deploy(await app("f", tlv));
  await deploy(await app("g", tlv));
  panel.deps.db.update(nodes).set({ parallelBuildsAuto: false, maxParallelBuilds: 1 }).where(eq(nodes.id, ra)).run();
  expect(pickBuildNode(panel.deps, auto, [target]).id).toBe(tlv);
  // The same free slots and builds in flight: by name.
  panel.deps.db.update(nodes).set({ parallelBuildsAuto: false, maxParallelBuilds: 4 }).where(eq(nodes.id, ra)).run();
  panel.deps.db.update(nodes).set({ parallelBuildsAuto: false, maxParallelBuilds: 4 }).where(eq(nodes.id, tlv)).run();
  expect(pickBuildNode(panel.deps, auto, [target]).id).toBe(ra);
});

/** NodeFacts as the panel stores them in nodes.facts (protobuf JSON), with the cores and memory Auto reads. */
const storedFacts = (cpuCores: number, memoryGiB: number) =>
  toJson(
    NodeFactsSchema,
    create(NodeFactsSchema, { hostname: "box", cpuCores, memoryTotalBytes: BigInt(memoryGiB * 1024 ** 3) }),
  ) as Record<string, unknown>;

test("on Auto, the queue and the build node pick count the slots the node's stored facts give, as its agent gets them", async () => {
  // 8 cores and 16 GiB: Auto runs 2 builds at once on il-ra. The fixed number left in the row (1) does not apply.
  panel.deps.db
    .update(nodes)
    .set({ parallelBuildsAuto: true, maxParallelBuilds: 1, facts: storedFacts(8, 16) })
    .where(eq(nodes.id, ra))
    .run();
  const [a, b, c] = [await app("a", ra), await app("b", ra), await app("c", ra)];
  const first = await deploy(a);
  await start(first.buildId);
  const second = await deploy(b);
  const third = await deploy(c);
  // a runs, b has the second slot, c waits behind b.
  expect((await deployment(b, second.deploymentId)).buildWait).toBeNull();
  expect((await deployment(c, third.deploymentId)).buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 2 });
  const listed = (await callOp(panel, buildOps.getSettings, { serviceId: a }, { cookie })).body.nodes;
  expect(listed.find((n: { id: string }) => n.id === ra)).toMatchObject({ queued: 3, running: 2, waiting: 1, buildsAtOnce: 2 });

  // A fixed 1: b waits too, and its page hears it.
  const events: { type: string; deployment?: { buildWait: unknown } }[] = [];
  panel.deps.live.subscribe(
    { id: "tab", send: (m) => events.push((m as { event: (typeof events)[number] }).event) },
    `deployment:${second.deploymentId}`,
  );
  expect((await callOp(panel, nodeOps.updateSettings, { nodeId: ra, maxParallelBuilds: 1 }, { cookie })).status).toBe(200);
  expect((await deployment(b, second.deploymentId)).buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 1 });
  expect(events.filter((e) => e.type === "deployment").at(-1)?.deployment?.buildWait).toEqual({
    node: { id: ra, name: "il-ra" },
    position: 1,
  });
  // Auto again: 2 slots, b no longer waits, and its page hears that too.
  events.length = 0;
  expect((await callOp(panel, nodeOps.updateSettings, { nodeId: ra, parallelBuildsAuto: true }, { cookie })).status).toBe(200);
  expect((await deployment(b, second.deploymentId)).buildWait).toBeNull();
  expect(events.filter((e) => e.type === "deployment").at(-1)?.deployment?.buildWait).toBeNull();

  // 32 cores and 64 GiB: 8 slots, 5 of them free, so the automatic pick takes il-ra over il-tlv's one free slot.
  panel.deps.db
    .update(nodes)
    .set({ facts: storedFacts(32, 64) })
    .where(eq(nodes.id, ra))
    .run();
  expect(pickBuildNode(panel.deps, defaultSpec(), [target])).toMatchObject({ id: ra, name: "il-ra" });
  // Without Can build its agent runs one at a time, whatever Auto would give.
  panel.deps.db.update(nodes).set({ canBuild: false }).where(eq(nodes.id, ra)).run();
  expect((await deployment(b, second.deploymentId)).buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 1 });
});

test("a re-attached build replays its stages: the clone it finished before a panel restart keeps its time", async () => {
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  const web = await app("web", ra);
  const { deploymentId, buildId } = await deploy(web);
  const progress = (stage: BuildStage) => fleet.emit(ra, { case: "buildProgress", value: create(BuildProgressSchema, { buildId, stage }) });
  // The clone takes 20 seconds, then the build runs.
  setSystemTime(new Date(t0 + 5_000));
  progress(BuildStage.FETCHING_SOURCE);
  await fleet.settle();
  setSystemTime(new Date(t0 + 25_000));
  progress(BuildStage.BUILDING);
  await fleet.settle();
  const clone = async () => (await deployment(web, deploymentId)).steps.find((s: { key: string }) => s.key === "clone");
  expect(await clone()).toMatchObject({ status: "ok", durationMs: 20_000 });

  // The panel restarts; the new runner opens the build again and the agent sends its output from the start.
  setSystemTime(new Date(t0 + 60_000));
  await restartPanel();
  await tick();
  setSystemTime(new Date(t0 + 70_000));
  await start(buildId);
  expect(fleet.calls.filter((c) => c.method === "build")).toHaveLength(1);
  expect(await clone()).toMatchObject({ status: "ok", durationMs: 20_000 });
  expect((await deployment(web, deploymentId)).steps.find((s: { key: string }) => s.key === "build").status).toBe("running");
  await end(buildId);
});

test("a preview whose deploy waits for a build slot says so in previews.list, and the list follows it", async () => {
  const [a, pr] = [await app("a", ra), await app("web-pr-7", ra)];
  const parent = await app("web", tlv);
  panel.deps.db.insert(previews).values({ serviceId: parent, previewServiceId: pr, prNumber: 7, branch: "feature" }).run();
  const first = await deploy(a);
  await start(first.buildId);
  const preview = await deploy(pr);
  const listed = async () => (await callOp(panel, previewOps.list, { serviceId: parent }, { cookie })).body.previews[0];
  expect(await listed()).toMatchObject({ prNumber: 7, status: "building", buildWaiting: true });

  // The parent service's page (service:<parent>, the topic the Previews tab's page follows) hears that the
  // preview's deploy moved, so the tab refetches without the sidebar's project:<id>, which is not followed
  // while the project is collapsed there.
  type Heard = { type: string; ops?: string[] };
  const heard = (topic: LiveTopic) => {
    const events: Heard[] = [];
    panel.deps.live.subscribe({ id: topic, send: (m) => events.push((m as { event: Heard }).event) }, topic);
    return events;
  };
  const onParent = heard(`service:${parent}`);
  const onProject = heard(`project:${projectId}`);
  const refetches = (events: Heard[]) => events.filter((e) => e.type === "invalidate" && e.ops?.includes(previewOps.list.id)).length;
  await end(first.buildId);
  const before = refetches(onParent);
  await start(preview.buildId);
  expect(await listed()).toMatchObject({ status: "building", buildWaiting: false });
  expect(refetches(onParent)).toBeGreaterThan(before);
  // Not on the project's topic: there it refetched every open Previews tab for any deploy of the project.
  expect(refetches(onProject)).toBe(0);
  await end(preview.buildId);
});
