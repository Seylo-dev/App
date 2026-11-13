// Moving a database to another node (services.move, services.moveImpact,
// 0.2.16) on a fake fleet: the data volume is copied while it is stopped,
// it starts on the new node with the same logins, its exposed port and
// timed exposes follow to the new node's address with their allowed IPs,
// TLS and allowPlain (on another port only when the new node has that one
// taken), backups run there, the old copy goes once the new one is live,
// and a backup never runs into the move. The impact lists all of that,
// and why a node cannot take it, before anyone moves.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseEnv } from "@seylo/env-analyzer";
import { backups as backupOps, databases as dbOps, deployments as deploymentOps, env, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage, ServicePhase } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { backupDestinations, backupPolicies, backupRuns, deployments, nodes, portExposures, servicePlacements } from "../src/db/schema";
import { runDueBackups } from "../src/modules/backups/schedule";
import { signedBackupsCapability } from "../src/modules/backups/signing";
import { databaseRuntime } from "../src/modules/databases/desired";
import { enginesCapability, exposureCapability, plainExposureCapability } from "../src/modules/databases/engines";
import { serviceNetworking } from "../src/modules/domains/desired";
import { followPlacements } from "../src/modules/services/access-move";
import { serviceSpecFor } from "../src/modules/services/desired";
import { addressUsers } from "../src/modules/services/move-impact";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

const baseCapabilities = [
  "state.sync.v1",
  "build.run.v1",
  "compose.parse.v1",
  "volume.transfer.v1",
  "volume.import-limits.v1",
  "exec.run.v1",
];
const current = [...baseCapabilities, enginesCapability, exposureCapability, plainExposureCapability, signedBackupsCapability];
const password = "Zq8vN3pXr7Lm2Kd9";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;
let nodeB: string;

/** The node's agent advertises these, live and in its stored facts (what the desired state reads). */
function capable(nodeId: string, capabilities: string[] = current) {
  fleet.caps.set(nodeId, new Set(capabilities));
  panel.deps.db.update(nodes).set({ facts: { capabilities } }).where(eq(nodes.id, nodeId)).run();
}

function addNode(name: string, ipv4: string, options: { online?: boolean; capabilities?: string[] } = {}) {
  const id = fleet.addNode(name, { online: options.online ?? true });
  panel.deps.db.update(nodes).set({ publicIpv4: ipv4 }).where(eq(nodes.id, id)).run();
  capable(id, options.capabilities);
  return id;
}

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = addNode("node-a", "203.0.113.10");
  nodeB = addNode("node-b", "203.0.113.20");
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
});
afterEach(() => panel.close());

const generationOf = (serviceId: string) =>
  Math.max(
    ...panel.deps.db
      .select({ generation: deployments.generation })
      .from(deployments)
      .where(eq(deployments.serviceId, serviceId))
      .all()
      .map((d) => d.generation),
  );

/** A Postgres on node A, live, exposed on 41000 to one network with clients without TLS allowed. */
async function liveDb(options: { exposed?: boolean } = {}) {
  const created = await callOp(
    panel,
    dbOps.create,
    { projectId, name: "db", engine: "postgres", nodeId: nodeA, user: "app", password, database: "shop" },
    { cookie },
  );
  expect(created.status).toBe(200);
  const id = created.body.serviceId as string;
  await fleet.settle();
  fleet.deployProgress(nodeA, id, generationOf(id), DeployStage.SUCCEEDED);
  await fleet.settle();
  if (options.exposed ?? true) {
    const exposed = await callOp(
      panel,
      dbOps.setExposure,
      { serviceId: id, enabled: true, port: 41000, allowedCidrs: ["198.51.100.0/24"], allowPlain: true },
      { cookie },
    );
    expect(exposed.status).toBe(200);
  }
  return id;
}

const rowsOf = (serviceId: string) =>
  panel.deps.db
    .select()
    .from(portExposures)
    .where(eq(portExposures.serviceId, serviceId))
    .all()
    .sort((a, b) => a.kind.localeCompare(b.kind));

const placed = (serviceId: string) =>
  panel.deps.db
    .select({ nodeId: servicePlacements.nodeId })
    .from(servicePlacements)
    .where(eq(servicePlacements.serviceId, serviceId))
    .all()
    .map((p) => p.nodeId)
    .sort();

/** A timed expose the node reported open on port 42000 for an hour. */
function timedExpose(serviceId: string, nodeId: string, expiresAt = new Date(Date.now() + 60 * 60_000)) {
  return panel.deps.db
    .insert(portExposures)
    .values({ serviceId, nodeId, kind: "timed", listenPort: 42000, targetPort: 5432, allowedCidrs: ["192.0.2.7/32"], expiresAt })
    .returning()
    .get();
}

/** Runs the move: the old copy reports stopped, the volume is copied, the new node reports the generation healthy. */
async function moveLive(serviceId: string, to = nodeB) {
  fleet.volumes.set(nodeA, new Map([[`${serviceId}/data`, new TextEncoder().encode("pgdata with the rows and the roles")]]));
  fleet.reportRunning(nodeA, serviceId, generationOf(serviceId), "", ServicePhase.STOPPED);
  const res = await callOp(panel, serviceOps.move, { serviceId, toNodeId: to }, { cookie });
  expect(res.status).toBe(200);
  await panel.runner.runDue(panel.deps);
  await fleet.settle();
  return res.body.deploymentId as string;
}

async function finishMove(serviceId: string, deploymentId: string, to = nodeB) {
  const d = panel.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
  expect(d?.status).toBe("deploying");
  fleet.deployProgress(to, serviceId, d?.generation ?? 0, DeployStage.SUCCEEDED);
  await fleet.settle();
  expect(panel.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get()?.status).toBe("live");
}

function destination() {
  return panel.deps.db
    .insert(backupDestinations)
    .values({
      name: "minio",
      provider: "minio",
      endpoint: "http://127.0.0.1:9",
      bucket: "backups",
      accessKeyId: "e2e-access",
      secretAccessKeySealed: panel.deps.secrets.seal("e2e-secret", "backup.destination"),
    })
    .returning()
    .get().id;
}

describe("moving a database", () => {
  test("its data, logins, exposed port and timed expose follow to the new node; backups run there; the old copy goes", async () => {
    const id = await liveDb();
    // The node reported the timed expose it opened; the exposed port is the one asked for.
    const timed = timedExpose(id, nodeA);
    const before = (await callOp(panel, dbOps.connection, { serviceId: id }, { cookie })).body;
    expect(before.exposed).toMatchObject({ host: "203.0.113.10", port: 41000, password });

    const deploymentId = await moveLive(id);
    expect(new TextDecoder().decode(fleet.volumes.get(nodeB)?.get(`${id}/data`))).toBe("pgdata with the rows and the roles");
    // Started on the new node with the same credentials; the old one keeps its stopped copy until it is live.
    expect(placed(id)).toEqual([nodeA, nodeB].sort());
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.stopped).toBe(true);
    expect(databaseRuntime(panel.deps, id, nodeB)?.database.credentials).toEqual({
      adminUser: "app",
      adminPassword: password,
      database: "shop",
    });
    // A backup waits for the move.
    const destinationId = destination();
    const early = await callOp(panel, backupOps.runNow, { serviceId: id, target: "database", destinationId }, { cookie });
    expect(early.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "moving" } });

    await finishMove(id, deploymentId);
    expect(placed(id)).toEqual([nodeB]);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)).toBeNull();
    // Every IP:port row is on the new node now, with its port, allowed IPs, TLS, allowPlain and end.
    expect(
      rowsOf(id).map(({ kind, nodeId, listenPort, allowedCidrs, tls, allowPlain, expiresAt }) => ({
        kind,
        nodeId,
        listenPort,
        allowedCidrs,
        tls,
        allowPlain,
        expiresAt,
      })),
    ).toEqual([
      {
        kind: "database",
        nodeId: nodeB,
        listenPort: 41000,
        allowedCidrs: ["198.51.100.0/24"],
        tls: true,
        allowPlain: true,
        expiresAt: null,
      },
      {
        kind: "timed",
        nodeId: nodeB,
        listenPort: 42000,
        allowedCidrs: ["192.0.2.7/32"],
        tls: false,
        allowPlain: false,
        expiresAt: timed.expiresAt,
      },
    ]);
    expect(databaseRuntime(panel.deps, id, nodeB)?.database.exposure).toMatchObject({
      enabled: true,
      hostPort: 41000,
      allowedSourceCidrs: ["198.51.100.0/24"],
      allowPlain: true,
    });
    expect(serviceNetworking(panel.deps, id, nodeB).devAccess.timedExposes).toMatchObject([{ id: timed.id, hostPort: 42000 }]);
    // The same logins inside; the exposed address and the timed one are the new node's.
    const after = (await callOp(panel, dbOps.connection, { serviceId: id }, { cookie })).body;
    expect(after.internal).toEqual(before.internal);
    expect(after.exposed).toMatchObject({ host: "203.0.113.20", port: 41000, user: "app", password, allowPlain: true });
    expect(after.timed).toMatchObject([{ exposureId: timed.id, host: "203.0.113.20", port: 42000 }]);
    expect((await callOp(panel, dbOps.get, { serviceId: id }, { cookie })).body.exposure).toMatchObject({
      enabled: true,
      state: "open",
      host: "203.0.113.20",
      port: 41000,
    });

    // Backups run on the new node.
    fleet.calls.length = 0;
    const run = await callOp(panel, backupOps.runNow, { serviceId: id, target: "database", destinationId }, { cookie });
    expect(run.status).toBe(200);
    expect(panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, run.body.id)).get()?.nodeId).toBe(nodeB);
    expect(fleet.calls.filter((c) => c.method === "runBackup").map((c) => c.nodeId)).toEqual([nodeB]);
  });

  test("the exposed port moves to another one when the new node has it taken: the agent picks one", async () => {
    const id = await liveDb();
    const other = await callOp(panel, dbOps.create, { projectId, name: "other", engine: "postgres", nodeId: nodeB }, { cookie });
    panel.deps.db
      .insert(portExposures)
      .values({ serviceId: other.body.serviceId, nodeId: nodeB, kind: "database", listenPort: 41000, targetPort: 5432, tls: true })
      .run();
    await finishMove(id, await moveLive(id));
    expect(rowsOf(id).map((r) => [r.kind, r.nodeId, r.listenPort])).toEqual([["database", nodeB, 0]]);
    expect(databaseRuntime(panel.deps, id, nodeB)?.database.exposure).toMatchObject({ enabled: true, hostPort: 0 });
    // Until the node reports the port it picked, there is no exposed URL.
    expect((await callOp(panel, dbOps.connection, { serviceId: id }, { cookie })).body.exposed).toBeNull();
  });

  test("a failed move leaves the exposed port and the timed expose on the old node", async () => {
    const id = await liveDb();
    timedExpose(id, nodeA);
    const deploymentId = await moveLive(id);
    const d = panel.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
    fleet.deployProgress(nodeB, id, d?.generation ?? 0, DeployStage.FAILED, "database system is shut down");
    await fleet.settle();
    expect(placed(id)).toEqual([nodeA]);
    expect(rowsOf(id).map((r) => [r.kind, r.nodeId, r.listenPort])).toEqual([
      ["database", nodeA, 41000],
      ["timed", nodeA, 42000],
    ]);
  });

  test("refused while a backup or restore of it runs, to a node that cannot keep its exposure, or offline", async () => {
    const id = await liveDb();
    const destinationId = destination();
    const running = panel.deps.db
      .insert(backupRuns)
      .values({ kind: "backup", target: "database", serviceId: id, destinationId, nodeId: nodeA, status: "running", startedAt: new Date() })
      .returning()
      .get();
    const move = (to = nodeB) => callOp(panel, serviceOps.move, { serviceId: id, toNodeId: to }, { cookie });
    expect((await move()).body.error).toMatchObject({ code: "CONFLICT", details: { reason: "backupRunning" } });
    panel.deps.db.update(backupRuns).set({ kind: "restore" }).where(eq(backupRuns.id, running.id)).run();
    expect((await move()).body.error).toMatchObject({ code: "CONFLICT", details: { reason: "restoreRunning" } });
    panel.deps.db.update(backupRuns).set({ status: "succeeded" }).where(eq(backupRuns.id, running.id)).run();

    // Its exposed port would close on an agent that cannot keep it TLS only.
    const old = addNode("node-old", "203.0.113.30", { capabilities: [...baseCapabilities, enginesCapability] });
    const refused = await move(old);
    expect(refused.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "agentTooOld", field: "toNodeId" } });
    expect(refused.body.error.message).toContain("the port would close there");
    // Clients without TLS would be refused on one from before 0.2.16.
    const noPlain = addNode("node-noplain", "203.0.113.31", { capabilities: [...baseCapabilities, enginesCapability, exposureCapability] });
    const plain = await move(noPlain);
    expect(plain.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "agentTooOld" } });
    expect(plain.body.error.message).toContain("0.2.16");
    // The volume is copied between online agents that can copy volumes.
    const offline = addNode("node-off", "203.0.113.32", { online: false });
    expect((await move(offline)).body.error).toMatchObject({ code: "UNAVAILABLE", details: { reason: "offline" } });
    const tooOld = addNode("node-noimport", "203.0.113.33");
    fleet.unsupported.set(tooOld, new Set(["importVolume"]));
    expect((await move(tooOld)).body.error).toMatchObject({ code: "NOT_IMPLEMENTED", details: { reason: "agentTooOld" } });
    // With exposure off the older agents can take it (it runs the engine).
    expect((await callOp(panel, dbOps.setExposure, { serviceId: id, enabled: false }, { cookie })).status).toBe(200);
    expect((await move(old)).status).toBe(200);
  });

  test("what does not work where it runs now is no reason to refuse a node", async () => {
    const id = await liveDb();
    const old = addNode("node-old", "203.0.113.30", { capabilities: [...baseCapabilities, enginesCapability] });
    const noPlain = addNode("node-noplain", "203.0.113.31", { capabilities: [...baseCapabilities, enginesCapability, exposureCapability] });
    const impact = async () => (await callOp(panel, serviceOps.moveImpact, { serviceId: id }, { cookie })).body;
    // Its node's agent went back to one without plain clients: they are refused there already.
    capable(nodeA, [...baseCapabilities, enginesCapability, exposureCapability]);
    const plainGone = (await impact()).targets;
    expect(plainGone.find((t: { id: string }) => t.id === noPlain)?.refusal).toBeNull();
    expect(plainGone.find((t: { id: string }) => t.id === old)?.refusal).toMatchObject({ reason: "agentTooOld" });
    // And to one that cannot keep the port TLS only: it is closed until that node updates, wherever it goes.
    capable(nodeA, [...baseCapabilities, enginesCapability]);
    expect((await callOp(panel, dbOps.get, { serviceId: id }, { cookie })).body.exposure.state).toBe("waitingForNodeUpdate");
    expect((await impact()).targets.find((t: { id: string }) => t.id === old)?.refusal).toBeNull();
  });

  test("a schedule due during the move waits for it, then runs on the new node; a restore is refused meanwhile", async () => {
    const id = await liveDb({ exposed: false });
    const destinationId = destination();
    const policy = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: id, target: "database", destinationId, schedule: "0 3 * * *" },
      { cookie },
    );
    expect(policy.status).toBe(200);
    const due = new Date(Date.now() - 60_000);
    panel.deps.db.update(backupPolicies).set({ nextRunAt: due }).where(eq(backupPolicies.id, policy.body.id)).run();
    const backup = panel.deps.db
      .insert(backupRuns)
      .values({
        kind: "backup",
        target: "database",
        serviceId: id,
        destinationId,
        nodeId: nodeA,
        status: "succeeded",
        objectKey: `${id}/manual/20260101T030000Z-x.dump`,
        startedAt: new Date(Date.now() - 3_600_000),
      })
      .returning()
      .get();
    const deploymentId = await moveLive(id);

    fleet.calls.length = 0;
    await runDueBackups(panel.deps);
    expect(fleet.calls.filter((c) => c.method === "runBackup")).toEqual([]);
    expect(panel.deps.db.select().from(backupPolicies).where(eq(backupPolicies.id, policy.body.id)).get()?.nextRunAt).toEqual(due);
    const restore = await callOp(panel, backupOps.restore, { serviceId: id, runId: backup.id, confirmName: "db" }, { cookie });
    expect(restore.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "moving" } });

    await finishMove(id, deploymentId);
    await runDueBackups(panel.deps);
    expect(fleet.calls.filter((c) => c.method === "runBackup").map((c) => c.nodeId)).toEqual([nodeB]);
    expect(
      panel.deps.db.select().from(backupPolicies).where(eq(backupPolicies.id, policy.body.id)).get()?.nextRunAt?.getTime(),
    ).toBeGreaterThan(Date.now());
  });

  test("rows a move before 0.2.16 left on the old node follow the node the service runs on, at start", async () => {
    const id = await liveDb();
    timedExpose(id, nodeA);
    // As an older panel left it: the placement moved, the rows did not.
    panel.deps.db.update(servicePlacements).set({ nodeId: nodeB }).where(eq(servicePlacements.serviceId, id)).run();
    const other = await callOp(panel, dbOps.create, { projectId, name: "other", engine: "postgres", nodeId: nodeB }, { cookie });
    panel.deps.db
      .insert(portExposures)
      .values({
        serviceId: other.body.serviceId,
        nodeId: nodeB,
        kind: "timed",
        listenPort: 42000,
        targetPort: 5432,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .run();
    expect(followPlacements(panel.deps.db)).toEqual([id]);
    expect(rowsOf(id).map((r) => [r.kind, r.nodeId, r.listenPort])).toEqual([
      ["database", nodeB, 41000],
      ["timed", nodeB, 0],
    ]);
    // Nothing left to move.
    expect(followPlacements(panel.deps.db)).toEqual([]);
  });
});

// The web's Advanced tab of a database: its crash policy applies at once, its limits with the deploy
// its Save and restart starts (a database has no Deploy button).
test("a database takes the crash policy at once and resource limits with its next deploy", async () => {
  const id = await liveDb({ exposed: false });
  const crash = await callOp(panel, serviceOps.setCrashPolicy, { serviceId: id, restart: true, stopAfterCrashes: 4 }, { cookie });
  expect(crash.status).toBe(200);
  expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.crashPolicy).toMatchObject({ restart: true, stopAfterCrashes: 4 });
  const limits = { memoryLimitBytes: 512_000_000, memoryReservationBytes: null, cpuWeight: 200, pidsLimit: 256 };
  expect((await callOp(panel, serviceOps.setResources, { serviceId: id, ...limits }, { cookie })).body).toEqual(limits);
  // The running generation keeps what it was deployed with.
  expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.resources?.memoryLimitBytes).toBeUndefined();
  const dep = await callOp(panel, deploymentOps.deploy, { serviceId: id }, { cookie });
  expect(dep.status).toBe(200);
  await fleet.settle();
  expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.resources).toMatchObject({
    memoryLimitBytes: 512_000_000n,
    cpuWeight: 200,
    pidsLimit: 256,
  });
});

describe("services.moveImpact", () => {
  test("downtime, size, backups, what moves to the new address, who uses it, and why each node can or cannot take it", async () => {
    const id = await liveDb();
    timedExpose(id, nodeA);
    const destinationId = destination();
    await callOp(panel, backupOps.createPolicy, { serviceId: id, target: "database", destinationId, schedule: "0 3 * * *" }, { cookie });
    const measuredAt = new Date(Date.now() - 2 * 3_600_000);
    const contents = (bytes: number[], wholeServer = true) => ({
      wholeServer,
      databases: bytes.map((sizeBytes, i) => ({
        name: `db${i}`,
        sizeBytes,
        approxRows: 10,
        tableCount: 1,
        tables: [],
        tablesTruncated: false,
      })),
    });
    const runRow = (startedAt: Date, extra: Partial<typeof backupRuns.$inferInsert>) =>
      panel.deps.db
        .insert(backupRuns)
        .values({
          kind: "backup",
          target: "database",
          serviceId: id,
          destinationId,
          nodeId: nodeA,
          status: "succeeded",
          startedAt,
          finishedAt: startedAt,
          ...extra,
        })
        .run();
    runRow(measuredAt, { contents: contents([1_000_000, 500_000]) });
    // The newest is of some tables only: it says when, not how big the whole server is.
    const newest = new Date(Date.now() - 3_600_000);
    runRow(newest, { contents: contents([10], false) });

    // Apps on node A use its internal address; one on node B its exposed URL; one you cannot see its host.
    const app = async (name: string, nodeId: string, text: string) => {
      const created = await callOp(panel, serviceOps.create, { projectId, name, kind: "app", nodeId }, { cookie });
      expect((await callOp(panel, env.set, { serviceId: created.body.id, text }, { cookie })).status).toBe(200);
      return created.body.id as string;
    };
    const api = await app("api", nodeA, "DATABASE_URL=${{db.INTERNAL_URL}}\nDB_USER=${{db.USER}}\n");
    const reports = await app("reports", nodeB, "PG_URL=${{db.EXPOSED_URL}}\nPG_HOST=${{db.EXPOSED_HOST}}\n");
    const worker = await app("worker", nodeA, "PGHOST=db\n");
    const old = addNode("node-old", "203.0.113.30", { capabilities: [...baseCapabilities, enginesCapability] });
    const offline = addNode("node-off", "203.0.113.32", { online: false });
    const disabled = addNode("node-disabled", "203.0.113.34");
    panel.deps.db.update(nodes).set({ disabledAt: new Date() }).where(eq(nodes.id, disabled)).run();

    const impact = await callOp(panel, serviceOps.moveImpact, { serviceId: id }, { cookie });
    expect(impact.status).toBe(200);
    expect(impact.body).toMatchObject({
      blocker: null,
      volumes: [{ name: "data", mountPath: "/var/lib/postgresql" }],
      dataSize: { bytes: 1_500_000, measuredAt: measuredAt.toISOString() },
      lastBackupAt: newest.toISOString(),
      backupSchedules: 1,
      exposure: { database: { port: 41000, tlsHostname: null, allowPlain: true }, timed: 1, firstRun: false },
      exposedReferrers: [{ serviceId: reports, name: "reports", keys: ["PG_URL", "PG_HOST"], nodeIds: [nodeB] }],
      hiddenReferrers: 0,
    });
    expect(impact.body.internalReferrers).toEqual([
      { serviceId: api, name: "api", keys: ["DATABASE_URL"], nodeIds: [nodeA] },
      { serviceId: worker, name: "worker", keys: ["PGHOST"], nodeIds: [nodeA] },
    ]);
    const target = (nodeId: string) => impact.body.targets.find((t: { id: string }) => t.id === nodeId);
    expect(impact.body.targets.map((t: { id: string }) => t.id)).not.toContain(nodeA);
    expect(target(nodeB)).toEqual({ id: nodeB, name: "node-b", online: true, address: "203.0.113.20", refusal: null });
    expect(target(old)?.refusal).toMatchObject({ reason: "agentTooOld" });
    expect(target(offline)).toMatchObject({ online: false, refusal: { reason: "offline" } });
    expect(target(disabled)?.refusal).toMatchObject({ reason: "disabled", message: "node-disabled is disabled." });

    // Names and keys only where the caller may see them.
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view"]);
    grant(panel, member.user.id, "service", api, ["services.view"]);
    const limited = await callOp(panel, serviceOps.moveImpact, { serviceId: id }, { cookie: member.cookie });
    expect(limited.status).toBe(200);
    expect(limited.body.exposedReferrers).toEqual([]);
    expect(limited.body.internalReferrers).toEqual([{ serviceId: api, name: "api", keys: [], nodeIds: [nodeA] }]);
    expect(limited.body.hiddenReferrers).toBe(2);

    // A running backup blocks every target.
    panel.deps.db
      .insert(backupRuns)
      .values({ kind: "backup", target: "database", serviceId: id, destinationId, nodeId: nodeA, status: "running", startedAt: new Date() })
      .run();
    const busy = await callOp(panel, serviceOps.moveImpact, { serviceId: id }, { cookie });
    expect(busy.body.blocker).toEqual({ reason: "backupRunning", message: "A backup of db is running. Move it once the backup ends." });
  });

  test("an app without volumes moves without downtime; a stack member is blocked", async () => {
    const created = await callOp(
      panel,
      serviceOps.create,
      { projectId, name: "web", kind: "app", nodeId: nodeA, source: { type: "image", image: "nginx:1.27", registryId: null } },
      { cookie },
    );
    const impact = (await callOp(panel, serviceOps.moveImpact, { serviceId: created.body.id }, { cookie })).body;
    expect(impact).toMatchObject({
      blocker: { reason: "notDeployed" },
      volumes: [],
      dataSize: null,
      lastBackupAt: null,
      backupSchedules: 0,
    });
    expect(impact.exposure).toEqual({ database: null, timed: 0, firstRun: false });
  });
});

describe("who uses the address", () => {
  const user = (id: string, name: string, text: string) => ({ id, name, parsed: parseEnv(text) });
  test("EXPOSED_* is the exposed address; internal built-ins and its name as a host the internal one; the rest neither", () => {
    const found = addressUsers(
      "db",
      "postgres",
      [
        user("a", "api", "URL=${{db.INTERNAL_URL}}\nHOST=${{DB.INTERNAL_HOST}}\nPORT=${{db.INTERNAL_PORT}}\nPASS=${{db.PASSWORD}}\n"),
        user("b", "web", "PUBLIC_DB=${{db.EXPOSED_URL}}\nDSN=postgres://app@db:5432/shop\nOTHER=${{cache.INTERNAL_URL}}\n"),
        // Its user name reaches nothing; a value that is only its name may be a host (PGHOST=db), so it counts.
        user("c", "jobs", "X=${{db.USER}}\nPGHOST=db\n"),
        user("e", "mail", "Y=${{db.DATABASE}}\nSMTP=smtp.example.com:587\n"),
        user("d", "db", "SELF=db:5432\n"),
      ],
      "d",
    );
    expect(found.exposed.map((f) => [f.user.name, f.keys])).toEqual([["web", ["PUBLIC_DB"]]]);
    expect(found.internal.map((f) => [f.user.name, f.keys])).toEqual([
      ["api", ["URL", "HOST"]],
      ["web", ["DSN"]],
      ["jobs", ["PGHOST"]],
    ]);
  });
});
