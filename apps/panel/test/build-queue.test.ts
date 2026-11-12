// Builds that wait for a slot of their node's Builds at once (added in
// 0.2.14). The agent queues a build it has no slot for and reports
// BUILD_STAGE_QUEUED; the build row stays queued (startedAt null) until a
// stage after the slot arrives, then runs from that moment. Waiting builds
// say so on their deployment (buildWait, the clone step), their service
// (buildWaiting), builds.queue and the build node list, with their place in
// line, and move up when a build ahead starts, ends or is cancelled.

import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import { builds as buildOps, deployments as deploymentOps, nodes as nodeOps, projects, services as serviceOps } from "@seylo/ops";
import { BuildProgressSchema, BuildStage } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { builds, nodes, services } from "../src/db/schema";
import { buildTimeoutMs, engineFor, unfinishedDeployments } from "../src/modules/deployments/engine";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let target: string;
let ra: string;
let tlv: string;

beforeEach(async () => {
  setSystemTime();
  panel = testPanel();
  fleet = new FakeFleet(panel);
  target = fleet.addNode("app-node");
  // Builds at once is 1 on both builders (the default).
  ra = fleet.addNode("il-ra", { canBuild: true, panelNode: true });
  tlv = fleet.addNode("il-tlv", { canBuild: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  // Every build waits in the agent's queue until the test gives it its slot, then runs until endBuild.
  fleet.buildScript = () => ({ queued: true, result: "held", digest: `sha256:${"b".repeat(64)}` });
});
afterEach(async () => {
  // Held streams end as if the nodes went away, before the database closes.
  fleet.online.clear();
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  setSystemTime();
  panel.close();
});

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
  // The stream drops (as after a panel restart): the runner opens the build again and the agent replays QUEUED.
  for (const drop of fleet.drops.splice(0)) drop();
  await fleet.settle();
  expect(fleet.calls.filter((c) => c.method === "build")).toHaveLength(2);
  expect(buildRow(buildId)).toMatchObject({ status: "queued", startedAt: null });
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
  const tick = async () => {
    const engine = engineFor(panel.deps);
    for (const id of unfinishedDeployments(panel.deps)) engine.kick(id);
    await fleet.settle();
  };

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
  panel.deps.db.update(nodes).set({ maxParallelBuilds: 4 }).where(eq(nodes.id, ra)).run();
  const first = await deploy(a);
  await start(first.buildId);
  const second = await deploy(b);
  expect((await deployment(b, second.deploymentId)).buildWait).toBeNull();
  // The panel sends max_parallel_builds 0 without Can build, which the agent runs as 1.
  panel.deps.db.update(nodes).set({ canBuild: false }).where(eq(nodes.id, ra)).run();
  expect((await deployment(b, second.deploymentId)).buildWait).toEqual({ node: { id: ra, name: "il-ra" }, position: 1 });
});
