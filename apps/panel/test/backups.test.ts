import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { backups as backupOps, databases as dbOps } from "@seylo/ops";
import { EventSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { backupDestinations, backupPolicies, backupRuns, volumes } from "../src/db/schema";
import { ownObjectKey } from "../src/modules/backups/runs";
import { runDueBackups } from "../src/modules/backups/schedule";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, seedService, settleDeploys } from "./seed-helpers";

// A tiny path-style S3: PUT, GET and DELETE on /<bucket>/<key>; access key "BADKEY" is refused.
const objects = new Map<string, string>();
let s3: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  s3 = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if ((req.headers.get("authorization") ?? "").includes("BADKEY")) {
        return new Response("<Error><Code>InvalidAccessKeyId</Code><Message>no</Message></Error>", { status: 403 });
      }
      if (req.method === "PUT") {
        objects.set(path, await req.text());
        return new Response("");
      }
      if (req.method === "GET") {
        const body = objects.get(path);
        return body === undefined ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }) : new Response(body);
      }
      if (req.method === "DELETE") {
        objects.delete(path);
        return new Response(null, { status: 204 });
      }
      return new Response("", { status: 405 });
    },
  });
});
afterAll(() => s3.stop(true));

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
  objects.clear();
});
afterEach(async () => {
  await settleDeploys(panel);
  panel.close();
});

const destinationInput = () => ({
  name: "R2 eu",
  provider: "minio" as const,
  endpoint: `http://127.0.0.1:${s3.port}`,
  region: "auto",
  bucket: "backups",
  pathPrefix: "seylo/",
  pathStyle: true,
  accessKeyId: "GOODKEY",
  secretAccessKey: "super-secret-key",
});

async function setup() {
  const project = seedProject(panel);
  const node = seedNode(panel);
  const db = await callOp(panel, dbOps.create, { projectId: project.id, name: "db", engine: "postgres", nodeId: node.id }, { cookie });
  const dest = await callOp(panel, backupOps.createDestination, destinationInput(), { cookie });
  return { project, node, dbId: db.body.serviceId as string, destinationId: dest.body.id as string };
}

/** The key the agent writes for a run (go/internal/backup/keys.go). */
function keyFor(runId: string, ext = ".dump") {
  const run = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, runId)).get();
  return `seylo/${run?.serviceId}/${run?.policyId ?? "manual"}/20260101T030000Z-${runId}${ext}`;
}

function backupResult(nodeId: string, runId: string, ok = true, key = keyFor(runId)) {
  panel.deps.agents.emitEvent(
    nodeId,
    create(EventSchema, {
      payload: {
        case: "backupResult",
        value: { runId, success: ok, error: ok ? "" : "pg_dump: connection refused", sizeBytes: 1234n, objectKey: ok ? key : "" },
      },
    }),
  );
}

describe("destinations", () => {
  test("secret keys are sealed; members with a grant only get choices", async () => {
    const created = await callOp(panel, backupOps.createDestination, destinationInput(), { cookie });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: "R2 eu", bucket: "backups", pathPrefix: "seylo", policyCount: 0 });
    expect(JSON.stringify(created.body)).not.toContain("super-secret-key");
    const row = panel.deps.db.select().from(backupDestinations).get();
    expect(row?.secretAccessKeySealed).not.toContain("super-secret-key");

    const member = await createUser(panel, "member");
    // An account with no grant gets nothing to pick from (picker-lists.test.ts).
    grant(panel, member.user.id, "project", seedProject(panel).id, ["services.view"]);
    const list = await callOp(panel, backupOps.listDestinations, {}, { cookie: member.cookie });
    expect(list.body).toEqual({
      destinations: [],
      choices: [{ id: created.body.id, name: "R2 eu", provider: "minio", bucket: "backups" }],
    });
    expect((await callOp(panel, backupOps.createDestination, destinationInput(), { cookie: member.cookie })).status).toBe(403);
  });

  test("the connection test writes, reads and deletes, and names the failing step", async () => {
    const created = await callOp(panel, backupOps.createDestination, destinationInput(), { cookie });
    const saved = await callOp(panel, backupOps.testDestination, { destinationId: created.body.id }, { cookie });
    expect(saved.body).toMatchObject({ ok: true, failedStep: null });
    expect(saved.body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(objects.size).toBe(0);

    // A draft without a secret reuses the saved one; a bad key fails at auth.
    const draft = await callOp(
      panel,
      backupOps.testDestination,
      { destinationId: created.body.id, draft: { ...destinationInput(), secretAccessKey: undefined } },
      { cookie },
    );
    expect(draft.body.ok).toBe(true);
    const bad = await callOp(panel, backupOps.testDestination, { draft: { ...destinationInput(), accessKeyId: "BADKEY" } }, { cookie });
    expect(bad.body).toMatchObject({ ok: false, failedStep: "auth" });
    const dead = await callOp(
      panel,
      backupOps.testDestination,
      { draft: { ...destinationInput(), endpoint: "http://127.0.0.1:1" } },
      { cookie },
    );
    expect(dead.body).toMatchObject({ ok: false, failedStep: "connect" });
    const noSecret = await callOp(
      panel,
      backupOps.testDestination,
      { draft: { ...destinationInput(), secretAccessKey: undefined } },
      { cookie },
    );
    expect(noSecret.status).toBe(400);
  });
});

describe("schedules and runs", () => {
  test("a database schedule runs on its node and keeps the newest keepLast", async () => {
    const { node, dbId, destinationId } = await setup();
    const bad = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: dbId, target: "database", destinationId, schedule: "61 * * * *" },
      { cookie },
    );
    expect(bad.status).toBe(400);
    const policy = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: dbId, target: "database", destinationId, schedule: "0 3 * * *", keepLast: 2 },
      { cookie },
    );
    expect(policy.status).toBe(200);
    expect(new Date(policy.body.nextRunAt).getUTCHours()).toBe(3);
    expect(policy.body).toMatchObject({ destinationName: "R2 eu", keepLast: 2, enabled: true, lastRun: null });

    const requests: {
      backupId: string;
      runId: string;
      keepLast: number;
      subject: { what: { case: string } };
      destination: { secretAccessKey: string; prefix: string };
    }[] = [];
    const agent = fakeAgent(panel, node.id, { runBackup: (req) => void requests.push(req) }, ["restoreBackup"]);
    const runIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, policyId: policy.body.id }, { cookie });
      expect(run.body).toMatchObject({ status: "running", kind: "backup", target: "database", policyId: policy.body.id });
      runIds.push(run.body.id);
      backupResult(node.id, run.body.id);
      await Bun.sleep(5);
    }
    expect(requests[0]).toMatchObject({
      backupId: policy.body.id,
      keepLast: 2,
      subject: { serviceId: dbId, what: { case: "database" } },
      destination: { secretAccessKey: "super-secret-key", prefix: "seylo", pathStyle: true, bucket: "backups" },
    });
    // A redelivered result changes nothing.
    backupResult(node.id, runIds[2] as string, false);

    const runs = await callOp(panel, backupOps.listRuns, { serviceId: dbId }, { cookie });
    expect(runs.body.runs.map((r: { status: string; deletedAt: string | null }) => [r.status, r.deletedAt !== null])).toEqual([
      ["succeeded", false],
      ["succeeded", false],
      ["succeeded", true],
    ]);
    expect(runs.body.runs[0]).toMatchObject({ sizeBytes: 1234, objectKey: keyFor(runIds[2] as string) });
    const policies = await callOp(panel, backupOps.listPolicies, { serviceId: dbId }, { cookie });
    expect(policies.body.policies[0].lastRun).toMatchObject({ id: runIds[2], status: "succeeded" });

    // In use: the destination cannot be deleted.
    expect((await callOp(panel, backupOps.deleteDestination, { destinationId }, { cookie })).status).toBe(409);
    agent.disconnect();
  });

  test("failures are recorded: the node offline, or the agent's error", async () => {
    const { node, dbId, destinationId } = await setup();
    const offline = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    expect(offline.status).toBe(503);
    const agent = fakeAgent(panel, node.id, { runBackup: () => ({}) }, ["restoreBackup"]);
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    backupResult(node.id, run.body.id, false);
    const runs = await callOp(panel, backupOps.listRuns, { serviceId: dbId }, { cookie });
    expect(runs.body.runs.map((r: { status: string; error: string | null }) => [r.status, r.error])).toEqual([
      ["failed", "pg_dump: connection refused"],
      ["failed", "The node is offline. Try again when it is back."],
    ]);
    agent.disconnect();
  });

  test("volume backups need one of the service's volumes; the scheduler starts due ones and moves on", async () => {
    const { node, project, destinationId } = await setup();
    const app = seedService(panel, { projectId: project.id, name: "files", nodeIds: [node.id] });
    const volume = panel.deps.db.insert(volumes).values({ serviceId: app.id, name: "uploads", mountPath: "/data" }).returning().get();
    const noVolume = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: app.id, target: "volume", destinationId, schedule: "*/5 * * * *" },
      { cookie },
    );
    expect(noVolume.status).toBe(400);
    const notDb = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: app.id, target: "database", destinationId, schedule: "*/5 * * * *" },
      { cookie },
    );
    expect(notDb.status).toBe(400);
    const policy = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: app.id, target: "volume", volumeId: volume.id, destinationId, schedule: "*/5 * * * *", stopService: true },
      { cookie },
    );
    expect(policy.body).toMatchObject({ volumeName: "uploads", stopService: true });

    const seen: { subject: { what: { case: string; value: string } }; stopService: boolean }[] = [];
    const agent = fakeAgent(panel, node.id, { runBackup: (req) => void seen.push(req) }, ["restoreBackup"]);
    const past = new Date(Date.now() - 60_000);
    panel.deps.db.update(backupPolicies).set({ nextRunAt: past }).where(eq(backupPolicies.id, policy.body.id)).run();
    expect(await runDueBackups(panel.deps)).toBe(1);
    expect(seen[0]).toMatchObject({ subject: { what: { case: "volume", value: "uploads" } }, stopService: true });
    const moved = panel.deps.db.select().from(backupPolicies).where(eq(backupPolicies.id, policy.body.id)).get();
    expect(moved?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(await runDueBackups(panel.deps)).toBe(0);
    agent.disconnect();
  });

  test("restore runs as a job on the node; delete removes the object", async () => {
    const { node, dbId, destinationId } = await setup();
    const restoreCalls: { objectKey: string }[] = [];
    const agent = fakeAgent(panel, node.id, {
      runBackup: () => ({}),
      restoreBackup: (req) => {
        restoreCalls.push(req);
        return { restoredBytes: 999n };
      },
    });
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    const key = keyFor(run.body.id);
    objects.set(`/backups/${key}`, "dump bytes");
    backupResult(node.id, run.body.id, true, key);

    const wrong = await callOp(panel, backupOps.restore, { serviceId: dbId, runId: run.body.id, confirmName: "nope" }, { cookie });
    expect(wrong.status).toBe(400);
    const restore = await callOp(panel, backupOps.restore, { serviceId: dbId, runId: run.body.id, confirmName: "db" }, { cookie });
    expect(restore.body).toMatchObject({ kind: "restore", status: "running", sourceRunId: run.body.id });
    const twice = await callOp(panel, backupOps.restore, { serviceId: dbId, runId: run.body.id, confirmName: "db" }, { cookie });
    expect(twice.status).toBe(409);

    await panel.runner.runDue(panel.deps);
    expect(restoreCalls).toEqual([expect.objectContaining({ objectKey: key })]);
    const done = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, restore.body.id)).get();
    expect(done).toMatchObject({ status: "succeeded", sizeBytes: 999 });

    const deleted = await callOp(panel, backupOps.deleteRun, { serviceId: dbId, runId: run.body.id }, { cookie });
    expect(deleted.body.deletedAt).not.toBeNull();
    expect(objects.has(`/backups/${key}`)).toBe(false);
    const gone = await callOp(panel, backupOps.restore, { serviceId: dbId, runId: run.body.id, confirmName: "db" }, { cookie });
    expect(gone.status).toBe(400);
    agent.disconnect();
  });

  test("a node may only report its own run's object; older rows naming another object are neither restored nor deleted", async () => {
    const { node, project, dbId, destinationId } = await setup();
    const other = seedService(panel, { projectId: project.id, name: "other", nodeIds: [node.id] });
    const restoreCalls: { objectKey: string }[] = [];
    const agent = fakeAgent(panel, node.id, {
      runBackup: () => ({}),
      restoreBackup: (req) => {
        restoreCalls.push(req);
        return { restoredBytes: 1n };
      },
    });
    const othersKey = `seylo/${other.id}/manual/20260101T030000Z-${crypto.randomUUID()}.tar.gz`;
    objects.set(`/backups/${othersKey}`, "someone else's volume");

    // Another service's object, a key without this run's id, a path trick: all refused.
    for (const key of [othersKey, `seylo/${dbId}/manual/20260101T030000Z-x.dump`, `seylo/../${dbId}/manual/20260101T030000Z-RUN.dump`]) {
      const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
      backupResult(node.id, run.body.id, true, key.replace("RUN", run.body.id));
      const row = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, run.body.id)).get();
      expect(row).toMatchObject({ status: "failed", objectKey: null });
      expect(row?.error).toContain("outside this backup's folder");
    }
    // Its own key is kept.
    const good = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    backupResult(node.id, good.body.id);
    expect(panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, good.body.id)).get()).toMatchObject({
      status: "succeeded",
      objectKey: keyFor(good.body.id),
    });

    // A row recorded before the check, naming the other service's object.
    const old = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    panel.deps.db.update(backupRuns).set({ status: "succeeded", objectKey: othersKey }).where(eq(backupRuns.id, old.body.id)).run();
    const restore = await callOp(panel, backupOps.restore, { serviceId: dbId, runId: old.body.id, confirmName: "db" }, { cookie });
    await panel.runner.runDue(panel.deps);
    expect(restoreCalls).toEqual([]);
    const failed = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, restore.body.id)).get();
    expect(failed?.status).toBe("failed");
    const deleted = await callOp(panel, backupOps.deleteRun, { serviceId: dbId, runId: old.body.id }, { cookie });
    expect(deleted.body.deletedAt).not.toBeNull();
    expect(objects.has(`/backups/${othersKey}`)).toBe(true);
    agent.disconnect();
  });

  test("ownObjectKey follows the agent's key layout", () => {
    const run = { id: "r1", serviceId: "s1" };
    for (const key of [
      "s1/manual/20260101T030000Z-r1.dump",
      "seylo/s1/p1/20260101T030000Z-r1.tar.gz",
      "a/b/s1/manual/20260101T030000Z-r1.clickhouse.zip",
    ])
      expect(ownObjectKey(run, key)).toBe(true);
    for (const key of [
      "",
      "s2/manual/20260101T030000Z-r1.dump",
      "s1/manual/20260101T030000Z-r2.dump",
      "s1/manual/20260101T030000Z-r1.exe",
      "s1/manual/2026-01-01-r1.dump",
      "/s1/manual/20260101T030000Z-r1.dump",
      "a//s1/manual/20260101T030000Z-r1.dump",
      "../s1/manual/20260101T030000Z-r1.dump",
      "s1/man.ual/20260101T030000Z-r1.dump",
      "s1/20260101T030000Z-r1.dump",
    ])
      expect(ownObjectKey(run, key)).toBe(false);
  });
});
