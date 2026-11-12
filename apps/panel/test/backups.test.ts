import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ai as aiOps, allOps, approvals as approvalOps, backups as backupOps, databases as dbOps, OpError } from "@seylo/ops";
import { buildAiTools } from "@seylo/ops/generators";
import { EventSchema } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { authenticate } from "../src/auth/authenticate";
import { approvals, auditLog, backupDestinations, backupPolicies, backupRuns, grants, services, volumes } from "../src/db/schema";
import { setModelProvider } from "../src/modules/ai/client";
import { backupFileName } from "../src/modules/backups/ops";
import { presign } from "../src/modules/backups/presign";
import { ownObjectKey } from "../src/modules/backups/runs";
import { runDueBackups } from "../src/modules/backups/schedule";
import { expiredObjects } from "../src/modules/backups/signing";
import { storageConfig } from "../src/modules/backups/storage";
import { callTool } from "../src/modules/mcp/tools";
import { scriptedModel, settled } from "./ai-fake";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, seedService, settleDeploys } from "./seed-helpers";

const signed = "backup.signed.v1";

// A tiny path-style S3: PUT, GET and DELETE on /<bucket>/<key>, ListObjectsV2; access key "BADKEY" is refused.
// On 127.0.0.1, the address the endpoint names (see fix-backup-signing.test.ts).
const objects = new Map<string, string>();
/** Every request the bucket got, as "METHOD /path". */
const s3Requests: string[] = [];
let s3: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  s3 = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      s3Requests.push(`${req.method} ${path}`);
      if ((req.headers.get("authorization") ?? "").includes("BADKEY")) {
        return new Response("<Error><Code>InvalidAccessKeyId</Code><Message>no</Message></Error>", { status: 403 });
      }
      if (req.method === "PUT") {
        objects.set(path, await req.text());
        return new Response("");
      }
      const url = new URL(req.url);
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = `/backups/${url.searchParams.get("prefix") ?? ""}`;
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const contents = keys.map((k) => `<Contents><Key>${k.slice("/backups/".length)}</Key><Size>1</Size></Contents>`).join("");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>backups</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
      if (req.method === "GET") {
        const body = objects.get(path);
        // Like S3, a presigned GET may set the saved file's name.
        const disposition = url.searchParams.get("response-content-disposition");
        return body === undefined
          ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
          : new Response(body, disposition ? { headers: { "content-disposition": disposition } } : {});
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
let ownerId: string;
beforeEach(async () => {
  panel = testPanel();
  const owner = await createUser(panel, "owner");
  cookie = owner.cookie;
  ownerId = owner.user.id;
  objects.clear();
  s3Requests.length = 0;
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
      destination: { accessKeyId: string; secretAccessKey: string; prefix: string; signingId: string };
    }[] = [];
    const agent = fakeAgent(panel, node.id, { runBackup: (req) => void requests.push(req) }, ["restoreBackup"], [signed]);
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
      // The node cannot list or delete in the bucket: the panel prunes.
      keepLast: 0,
      subject: { serviceId: dbId, what: { case: "database" } },
      // No keys: the node asks the panel to sign each request for this run (fix-backup-signing.test.ts).
      destination: {
        accessKeyId: "",
        secretAccessKey: "",
        signingId: runIds[0] as string,
        prefix: "seylo",
        pathStyle: true,
        bucket: "backups",
      },
    });
    expect(JSON.stringify(requests)).not.toContain("super-secret-key");
    expect(JSON.stringify(requests)).not.toContain("GOODKEY");
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

  test("the panel prunes a policy's folder past keepLast, newest kept, nothing outside it", async () => {
    const { node, project, dbId, destinationId } = await setup();
    const other = seedService(panel, { projectId: project.id, name: "other", nodeIds: [node.id] });
    const policy = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: dbId, target: "database", destinationId, schedule: "0 3 * * *", keepLast: 2 },
      { cookie },
    );
    const agent = fakeAgent(panel, node.id, { runBackup: () => ({}) }, ["restoreBackup"], [signed]);
    const folder = `/backups/seylo/${dbId}/${policy.body.id}/`;
    const kept = [
      `${folder}20260102T030000Z-b.dump`,
      `${folder}notes.txt`,
      `${folder}sub/20250101T030000Z-c.dump`,
      `/backups/seylo/${other.id}/${policy.body.id}/20200101T030000Z-x.dump`,
    ];
    objects.set(`${folder}20260101T030000Z-a.dump`, "oldest");
    for (const k of kept) objects.set(k, "keep");
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, policyId: policy.body.id }, { cookie });
    const key = `seylo/${dbId}/${policy.body.id}/20260103T030000Z-${run.body.id}.dump`;
    objects.set(`/backups/${key}`, "newest");
    backupResult(node.id, run.body.id, true, key);
    await panel.runner.runDue(panel.deps);
    expect([...objects.keys()].sort()).toEqual([...kept, `/backups/${key}`].sort());

    // Lowering keepLast prunes right away.
    await callOp(panel, backupOps.updatePolicy, { serviceId: dbId, policyId: policy.body.id, keepLast: 1 }, { cookie });
    await panel.runner.runDue(panel.deps);
    expect(objects.has(`${folder}20260102T030000Z-b.dump`)).toBe(false);
    expect(objects.has(`/backups/${key}`)).toBe(true);
    agent.disconnect();
  });

  test("failures are recorded: the node offline, or the agent's error", async () => {
    const { node, dbId, destinationId } = await setup();
    const offline = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    expect(offline.status).toBe(503);
    const agent = fakeAgent(panel, node.id, { runBackup: () => ({}) }, ["restoreBackup"], [signed]);
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    backupResult(node.id, run.body.id, false);
    const runs = await callOp(panel, backupOps.listRuns, { serviceId: dbId }, { cookie });
    expect(runs.body.runs.map((r: { status: string; error: string | null }) => [r.status, r.error])).toEqual([
      ["failed", "pg_dump: connection refused"],
      ["failed", "The node is offline. Try again when it is back."],
    ]);
    agent.disconnect();
  });

  test("an agent that cannot ask the panel to sign gets no keys: backups and restores fail with what to do", async () => {
    const { node, dbId, destinationId } = await setup();
    const calls: string[] = [];
    const old = fakeAgent(panel, node.id, {
      runBackup: () => void calls.push("runBackup"),
      restoreBackup: () => {
        calls.push("restoreBackup");
        return { restoredBytes: 1n };
      },
    });
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    expect(run.status).toBe(409);
    expect(run.body.error.message).toContain("too old for backups");
    const row = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.serviceId, dbId)).get();
    expect(row).toMatchObject({ status: "failed" });
    expect(row?.error).toContain("Update the node");

    // A backup an up-to-date agent made, restored after the node went back to an old agent.
    panel.deps.db
      .update(backupRuns)
      .set({ status: "succeeded", objectKey: keyFor(row?.id as string), error: null })
      .where(eq(backupRuns.id, row?.id as string))
      .run();
    const restore = await callOp(panel, backupOps.restore, { serviceId: dbId, runId: row?.id as string, confirmName: "db" }, { cookie });
    await panel.runner.runDue(panel.deps);
    const failed = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, restore.body.id)).get();
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("too old for backups");
    expect(calls).toEqual([]);
    old.disconnect();
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
    const agent = fakeAgent(panel, node.id, { runBackup: (req) => void seen.push(req) }, ["restoreBackup"], [signed]);
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
    const agent = fakeAgent(
      panel,
      node.id,
      {
        runBackup: () => ({}),
        restoreBackup: (req) => {
          restoreCalls.push(req);
          return { restoredBytes: 999n };
        },
      },
      [],
      [signed],
    );
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

  test("a backup whose destination was deleted cannot be restored, and delete only marks it deleted without touching a bucket", async () => {
    const { node, dbId, destinationId } = await setup();
    const policy = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: dbId, target: "database", destinationId, schedule: "0 3 * * *" },
      { cookie },
    );
    const agent = fakeAgent(panel, node.id, { runBackup: () => ({}), restoreBackup: () => ({ restoredBytes: 1n }) }, [], [signed]);
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    const key = keyFor(run.body.id);
    objects.set(`/backups/${key}`, "dump bytes");
    backupResult(node.id, run.body.id, true, key);

    // A destination a schedule still writes to cannot be deleted, so no schedule is ever left without one.
    const inUse = await callOp(panel, backupOps.deleteDestination, { destinationId }, { cookie });
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.details).toMatchObject({ reason: "inUse" });
    await callOp(panel, backupOps.deletePolicy, { serviceId: dbId, policyId: policy.body.id }, { cookie });
    expect((await callOp(panel, backupOps.deleteDestination, { destinationId }, { cookie })).status).toBe(200);
    const listed = await callOp(panel, backupOps.listRuns, { serviceId: dbId }, { cookie });
    expect(listed.body.runs[0]).toMatchObject({ id: run.body.id, status: "succeeded", destinationId: null, deletedAt: null });

    // Restore is refused at once: no failed restore run is left in the list.
    const restore = await callOp(panel, backupOps.restore, { serviceId: dbId, runId: run.body.id, confirmName: "db" }, { cookie });
    expect(restore.status).toBe(409);
    expect(restore.body.error.details).toMatchObject({ reason: "noDestination" });
    expect(panel.deps.db.select().from(backupRuns).where(eq(backupRuns.kind, "restore")).all()).toEqual([]);

    s3Requests.length = 0;
    const deleted = await callOp(panel, backupOps.deleteRun, { serviceId: dbId, runId: run.body.id }, { cookie });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ id: run.body.id, destinationId: null });
    expect(deleted.body.deletedAt).not.toBeNull();
    // The panel has no keys for that bucket any more: no request, and the object stays there.
    expect(s3Requests).toEqual([]);
    expect(objects.has(`/backups/${key}`)).toBe(true);
    const after = await callOp(panel, backupOps.listRuns, { serviceId: dbId }, { cookie });
    expect(after.body.runs[0].deletedAt).toBe(deleted.body.deletedAt);
    agent.disconnect();
  });

  test("deleting a destination tells open Backups tabs of the services with backups there to refetch their runs", async () => {
    const { project, node, dbId, destinationId } = await setup();
    const db2 = await callOp(panel, dbOps.create, { projectId: project.id, name: "db2", engine: "postgres", nodeId: node.id }, { cookie });
    const otherId = db2.body.serviceId as string;
    const otherDest = await callOp(panel, backupOps.createDestination, { ...destinationInput(), name: "R2 us" }, { cookie });
    const agent = fakeAgent(panel, node.id, { runBackup: () => ({}) }, [], [signed]);
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    backupResult(node.id, run.body.id);
    const elsewhere = await callOp(
      panel,
      backupOps.runNow,
      { serviceId: otherId, target: "database", destinationId: otherDest.body.id },
      { cookie },
    );
    backupResult(node.id, elsewhere.body.id);

    const told: { topic: string; ops: string[] }[] = [];
    const socket = {
      id: "tab",
      send: (m: { type: string; topic?: string; event?: { ops?: string[] } }) => {
        if (m.type === "event" && m.topic) told.push({ topic: m.topic, ops: m.event?.ops ?? [] });
      },
    } as never;
    panel.deps.live.subscribe(socket, `service:${dbId}`);
    panel.deps.live.subscribe(socket, `service:${otherId}`);
    expect((await callOp(panel, backupOps.deleteDestination, { destinationId }, { cookie })).status).toBe(200);
    // Without it, a tab opened before the delete kept offering Restore, and a
    // Delete that promised to remove the file from the bucket, which stayed there.
    expect(told).toContainEqual({ topic: `service:${dbId}`, ops: [backupOps.listRuns.id] });
    // A service whose backups went to another destination is left alone.
    expect(told.filter((t) => t.topic === `service:${otherId}`)).toEqual([]);
    agent.disconnect();
  });

  test("a node may only report its own run's object; older rows naming another object are neither restored nor deleted", async () => {
    const { node, project, dbId, destinationId } = await setup();
    const other = seedService(panel, { projectId: project.id, name: "other", nodeIds: [node.id] });
    const restoreCalls: { objectKey: string }[] = [];
    const agent = fakeAgent(
      panel,
      node.id,
      {
        runBackup: () => ({}),
        restoreBackup: (req) => {
          restoreCalls.push(req);
          return { restoredBytes: 1n };
        },
      },
      [],
      [signed],
    );
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

/** An app with two scheduled volumes and a third whose schedule is off, like vault-warden's data and web-vault. */
async function volumeSchedules() {
  const { node, project, destinationId } = await setup();
  const app = seedService(panel, { projectId: project.id, name: "vault-warden", nodeIds: [node.id] });
  const volume = (name: string) =>
    panel.deps.db
      .insert(volumes)
      .values({ serviceId: app.id, name, mountPath: `/${name}` })
      .returning()
      .get();
  const schedule = async (volumeId: string, enabled: boolean) =>
    (
      await callOp(
        panel,
        backupOps.createPolicy,
        { serviceId: app.id, target: "volume", volumeId, destinationId, schedule: "0 3 * * *", keepLast: 1, enabled },
        { cookie },
      )
    ).body.id as string;
  const data = await schedule(volume("data").id, true);
  const webVault = await schedule(volume("web-vault").id, true);
  const cache = await schedule(volume("cache").id, false);
  return { node, app, destinationId, data, webVault, cache };
}

describe("Back up now for the whole service (runAll)", () => {
  test("starts every enabled schedule at once, each toward its own keepLast; off and running ones are skipped", async () => {
    const { node, app, data, webVault, cache } = await volumeSchedules();
    const asked: { backupId: string; subject: { what: { value: string } } }[] = [];
    const agent = fakeAgent(panel, node.id, { runBackup: (req) => void asked.push(req) }, [], [signed]);

    const first = await callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    expect(first.status).toBe(200);
    // Before, Back up now ran only the first schedule.
    expect(
      first.body.runs.map((r: { policyId: string; status: string; volumeName: string }) => [r.policyId, r.status, r.volumeName]),
    ).toEqual([
      [data, "running", "data"],
      [webVault, "running", "web-vault"],
    ]);
    expect(first.body.skipped).toEqual([{ policyId: cache, reason: "disabled" }]);
    expect(asked.map((r) => [r.backupId, r.subject.what.value])).toEqual([
      [data, "data"],
      [webVault, "web-vault"],
    ]);

    // Both still running: nothing is started twice.
    const again = await callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    expect(again.body).toEqual({
      runs: [],
      skipped: [
        { policyId: data, reason: "running" },
        { policyId: webVault, reason: "running" },
        { policyId: cache, reason: "disabled" },
      ],
    });
    expect(asked).toHaveLength(2);

    // One finished: only that one starts.
    const [dataRun, webVaultRun] = first.body.runs as { id: string }[];
    backupResult(node.id, (dataRun as { id: string }).id, true, keyFor((dataRun as { id: string }).id, ".tar.gz"));
    const third = await callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    expect(third.body.runs.map((r: { policyId: string }) => r.policyId)).toEqual([data]);
    expect(third.body.skipped).toEqual([
      { policyId: webVault, reason: "running" },
      { policyId: cache, reason: "disabled" },
    ]);
    // keepLast 1 per schedule: data's newer backup retires its older one, web-vault's is untouched.
    backupResult(node.id, third.body.runs[0].id, true, keyFor(third.body.runs[0].id, ".tar.gz"));
    backupResult(node.id, (webVaultRun as { id: string }).id, true, keyFor((webVaultRun as { id: string }).id, ".tar.gz"));
    const deleted = (id: string) => panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, id)).get()?.deletedAt !== null;
    expect(deleted((dataRun as { id: string }).id)).toBe(true);
    expect(deleted(third.body.runs[0].id)).toBe(false);
    expect(deleted((webVaultRun as { id: string }).id)).toBe(false);

    // Audited with what it started and skipped.
    const audited = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, backupOps.runAll.id)).all();
    expect(audited).toHaveLength(3);
    expect(audited[0]?.input).toMatchObject({ serviceId: app.id, runIds: first.body.runs.map((r: { id: string }) => r.id) });
    agent.disconnect();
  });

  test("every schedule off starts nothing and says so; no schedule at all is refused", async () => {
    const { node, app, data, webVault, cache } = await volumeSchedules();
    const asked: unknown[] = [];
    const agent = fakeAgent(panel, node.id, { runBackup: (req) => void asked.push(req) }, [], [signed]);
    for (const policyId of [data, webVault])
      await callOp(panel, backupOps.updatePolicy, { serviceId: app.id, policyId, enabled: false }, { cookie });
    const off = await callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({
      runs: [],
      skipped: [data, webVault, cache].map((policyId) => ({ policyId, reason: "disabled" })),
    });
    expect(asked).toEqual([]);

    const bare = seedService(panel, { projectId: app.projectId, name: "bare", nodeIds: [node.id] });
    const none = await callOp(panel, backupOps.runAll, { serviceId: bare.id }, { cookie });
    expect(none.status).toBe(400);
    expect(none.body.error.details).toMatchObject({ reason: "noSchedules" });
    agent.disconnect();
  });

  test("with the node offline it fails like a single Back up now, and records each failed start", async () => {
    const { app } = await volumeSchedules();
    const res = await callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    expect(res.status).toBe(503);
    const rows = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.serviceId, app.id)).all();
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  test("two Back up nows at once, or the scheduler meanwhile, never start a schedule twice", async () => {
    const { node, app, data, webVault, cache } = await volumeSchedules();
    const asked: string[] = [];
    let gate: Promise<void> | null = null;
    const agent = fakeAgent(
      panel,
      node.id,
      {
        runBackup: async (req) => {
          asked.push(req.subject.what.value);
          const held = gate;
          gate = null;
          if (held) await held;
          return {};
        },
      },
      [],
      [signed],
    );
    const hold = () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    };
    const running = () =>
      panel.deps.db
        .select({ policyId: backupRuns.policyId })
        .from(backupRuns)
        .where(and(eq(backupRuns.serviceId, app.id), eq(backupRuns.status, "running")))
        .all()
        .map((r) => r.policyId);
    const reached = async (n: number) => {
      while (asked.length < n) await Bun.sleep(1);
    };
    const policyIds = (body: { runs: { policyId: string }[] }) => body.runs.map((r) => r.policyId);

    // The first call waits on the node with data's run stored; a second one (another tab, the
    // Connection tab's button) starts only web-vault, and the first then leaves web-vault alone.
    let release = hold();
    const first = callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    await reached(1);
    const second = await callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    expect(policyIds(second.body)).toEqual([webVault]);
    expect(second.body.skipped).toEqual([
      { policyId: data, reason: "running" },
      { policyId: cache, reason: "disabled" },
    ]);
    release();
    const firstDone = await first;
    expect(policyIds(firstDone.body)).toEqual([data]);
    expect(firstDone.body.skipped).toEqual([
      { policyId: webVault, reason: "running" },
      { policyId: cache, reason: "disabled" },
    ]);
    expect(asked).toEqual(["data", "web-vault"]);
    expect(running().sort()).toEqual([data, webVault].sort());

    // Both done. Back up now waits on the node for data while the scheduler starts web-vault, due now.
    for (const run of [...firstDone.body.runs, ...second.body.runs]) backupResult(node.id, run.id, true, keyFor(run.id, ".tar.gz"));
    const now = new Date();
    panel.deps.db
      .update(backupPolicies)
      .set({ nextRunAt: new Date(now.getTime() + 3600_000) })
      .where(eq(backupPolicies.id, data))
      .run();
    panel.deps.db
      .update(backupPolicies)
      .set({ nextRunAt: new Date(now.getTime() - 1000) })
      .where(eq(backupPolicies.id, webVault))
      .run();
    release = hold();
    const manual = callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    await reached(3);
    expect(await runDueBackups(panel.deps, now)).toBe(1);
    release();
    const manualDone = await manual;
    expect(policyIds(manualDone.body)).toEqual([data]);
    expect(manualDone.body.skipped).toContainEqual({ policyId: webVault, reason: "running" });
    expect(asked).toEqual(["data", "web-vault", "data", "web-vault"]);
    expect(running().sort()).toEqual([data, webVault].sort());
    agent.disconnect();
  });

  test("Back up now on a schedule's menu is refused while that schedule's backup still runs (0.2.16)", async () => {
    const { node, app, data, webVault } = await volumeSchedules();
    const asked: string[] = [];
    const agent = fakeAgent(panel, node.id, { runBackup: (req) => void asked.push(req.backupId) }, [], [signed]);
    const first = await callOp(panel, backupOps.runNow, { serviceId: app.id, policyId: data }, { cookie });
    expect(first.body.status).toBe("running");
    // Started again while it runs: refused, the node is not asked twice and no second run is stored.
    const again = await callOp(panel, backupOps.runNow, { serviceId: app.id, policyId: data }, { cookie });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: "CONFLICT",
      message: "A backup of this schedule is still running. Wait for it to finish, then back up again.",
      details: { reason: "running", runId: first.body.id },
    });
    expect(asked).toEqual([data]);
    expect(panel.deps.db.select().from(backupRuns).where(eq(backupRuns.policyId, data)).all()).toHaveLength(1);
    // Another schedule of the service, and one-offs, are not held up.
    expect((await callOp(panel, backupOps.runNow, { serviceId: app.id, policyId: webVault }, { cookie })).status).toBe(200);
    // Once it finished, it runs again.
    backupResult(node.id, first.body.id, true, keyFor(first.body.id, ".tar.gz"));
    await Bun.sleep(5);
    const later = await callOp(panel, backupOps.runNow, { serviceId: app.id, policyId: data }, { cookie });
    expect(later.status).toBe(200);
    expect(asked).toEqual([data, webVault, data]);
    agent.disconnect();
  });

  test("the scheduler skips a schedule whose backup is still running, says so, and runs it at its next time", async () => {
    const { node, app, data, webVault } = await volumeSchedules();
    const asked: string[] = [];
    const agent = fakeAgent(panel, node.id, { runBackup: (req) => void asked.push(req.backupId) }, [], [signed]);
    const warnings: { meta: Record<string, unknown>; message: string }[] = [];
    const logger = Object.assign(Object.create(panel.deps.logger), {
      warn: (meta: Record<string, unknown>, message: string) => void warnings.push({ meta, message }),
    }) as typeof panel.deps.logger;
    const deps = { ...panel.deps, logger };
    const runsOf = (policyId: string) =>
      panel.deps.db
        .select()
        .from(backupRuns)
        .where(eq(backupRuns.policyId, policyId))
        .all()
        .map((r) => ({ id: r.id, status: r.status }));
    const statuses = (policyId: string) =>
      runsOf(policyId)
        .map((r) => r.status)
        .sort();
    const nextRunAt = (policyId: string) =>
      panel.deps.db.select().from(backupPolicies).where(eq(backupPolicies.id, policyId)).get()?.nextRunAt?.getTime() ?? 0;

    // Back up now on data's menu is still running when data's time comes: data is left alone,
    // web-vault starts, and data's next time moves on as usual.
    const manual = await callOp(panel, backupOps.runNow, { serviceId: app.id, policyId: data }, { cookie });
    expect(manual.body.status).toBe("running");
    const now = new Date();
    for (const policyId of [data, webVault])
      panel.deps.db
        .update(backupPolicies)
        .set({ nextRunAt: new Date(now.getTime() - 1000) })
        .where(eq(backupPolicies.id, policyId))
        .run();
    expect(await runDueBackups(deps, now)).toBe(2);
    expect(asked).toEqual([data, webVault]);
    expect(runsOf(data)).toEqual([{ id: manual.body.id, status: "running" }]);
    expect(nextRunAt(data)).toBeGreaterThan(now.getTime());
    expect(warnings).toEqual([
      {
        meta: { policyId: data, serviceId: app.id, runningRunId: manual.body.id, nextRunAt: new Date(nextRunAt(data)).toISOString() },
        message: "scheduled backup skipped: the schedule's previous backup is still running; it runs at its next time",
      },
    ]);

    // A day later: data's backup finished and it runs; web-vault's scheduled one is still running, so web-vault waits.
    backupResult(node.id, manual.body.id, true, keyFor(manual.body.id, ".tar.gz"));
    const webVaultRun = runsOf(webVault)[0] as { id: string };
    const later = new Date(now.getTime() + 86_400_000);
    expect(await runDueBackups(deps, later)).toBe(2);
    expect(asked).toEqual([data, webVault, data]);
    expect(statuses(data)).toEqual(["running", "succeeded"]);
    expect(runsOf(webVault)).toEqual([{ id: webVaultRun.id, status: "running" }]);
    expect(warnings.map((w) => w.meta.policyId)).toEqual([data, webVault]);
    expect(warnings[1]?.meta.runningRunId).toBe(webVaultRun.id);

    // Once it finished, web-vault runs at its next time (and data, still running, waits).
    backupResult(node.id, webVaultRun.id, true, keyFor(webVaultRun.id, ".tar.gz"));
    expect(await runDueBackups(deps, new Date(later.getTime() + 86_400_000))).toBe(2);
    expect(statuses(webVault)).toEqual(["running", "succeeded"]);
    expect(asked).toEqual([data, webVault, data, webVault]);
    expect(warnings.map((w) => w.meta.policyId)).toEqual([data, webVault, data]);
    agent.disconnect();
  });

  test("a schedule refused before its run is stored is named with why, not dropped", async () => {
    const { node, app, data, webVault, cache } = await volumeSchedules();
    const agent = fakeAgent(panel, node.id, { runBackup: () => ({}) }, [], [signed]);
    // web-vault's volume became a file mount after its schedule was made: checkTarget refuses it before any run row.
    const volumeId = panel.deps.db.select().from(backupPolicies).where(eq(backupPolicies.id, webVault)).get()?.volumeId as string;
    panel.deps.db.update(volumes).set({ kind: "file" }).where(eq(volumes.id, volumeId)).run();

    const res = await callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { policyId: string; status: string }) => [r.policyId, r.status])).toEqual([[data, "running"]]);
    expect(res.body.skipped).toEqual([
      { policyId: webVault, reason: "error", error: "That volume does not belong to this service." },
      { policyId: cache, reason: "disabled" },
    ]);
    expect(panel.deps.db.select().from(backupRuns).where(eq(backupRuns.policyId, webVault)).all()).toEqual([]);
    const audited = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, backupOps.runAll.id)).get();
    expect(audited?.input).toMatchObject({ skipped: res.body.skipped });

    // When it is the only one on, nothing starts: its error, as a single Back up now gets it.
    await callOp(panel, backupOps.updatePolicy, { serviceId: app.id, policyId: data, enabled: false }, { cookie });
    const alone = await callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie });
    expect(alone.status).toBe(400);
    expect(alone.body.error.message).toBe("That volume does not belong to this service.");
    agent.disconnect();
  });

  test("needs backups.run on the service", async () => {
    const { app } = await volumeSchedules();
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", app.id, ["backups.view"]);
    expect((await callOp(panel, backupOps.runAll, { serviceId: app.id }, { cookie: member.cookie })).status).toBe(403);
  });
});

describe("run labels", () => {
  test("runs carry their volume's name, and a restore when its backup was taken", async () => {
    const { node, app, data } = await volumeSchedules();
    const agent = fakeAgent(panel, node.id, { runBackup: () => ({}), restoreBackup: () => ({ restoredBytes: 1n }) }, [], [signed]);
    const run = await callOp(panel, backupOps.runNow, { serviceId: app.id, policyId: data }, { cookie });
    expect(run.body).toMatchObject({ target: "volume", volumeName: "data", sourceStartedAt: null });
    backupResult(node.id, run.body.id, true, keyFor(run.body.id, ".tar.gz"));
    const restore = await callOp(
      panel,
      backupOps.restore,
      { serviceId: app.id, runId: run.body.id, confirmName: "vault-warden" },
      { cookie },
    );
    expect(restore.body).toMatchObject({ kind: "restore", volumeName: "data", sourceStartedAt: run.body.startedAt });
    const listed = await callOp(panel, backupOps.listRuns, { serviceId: app.id }, { cookie });
    expect(
      listed.body.runs.map((r: { kind: string; volumeName: string; sourceStartedAt: string | null }) => [
        r.kind,
        r.volumeName,
        r.sourceStartedAt,
      ]),
    ).toEqual([
      ["restore", "data", run.body.startedAt],
      ["backup", "data", null],
    ]);
    await panel.runner.runDue(panel.deps);
    agent.disconnect();
  });
});

describe("download links", () => {
  /** A finished database backup with its file in the bucket. */
  async function databaseBackup() {
    const { node, project, dbId, destinationId } = await setup();
    const agent = fakeAgent(panel, node.id, { runBackup: () => ({}) }, [], [signed]);
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    const key = keyFor(run.body.id);
    objects.set(`/backups/${key}`, "dump bytes");
    backupResult(node.id, run.body.id, true, key);
    return { node, project, dbId, destinationId, agent, runId: run.body.id as string, key };
  }

  test("a link signs a GET of that run's own object only, for 5 minutes, saved under a readable name", async () => {
    const { dbId, destinationId, agent, runId, key } = await databaseBackup();
    const started = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, runId)).get()?.startedAt as Date;
    const res = await callOp(panel, backupOps.downloadUrl, { serviceId: dbId, runId }, { cookie });
    expect(res.status).toBe(200);
    const stamp = `${started.toISOString().slice(0, 10)}_${started.toISOString().slice(11, 13)}${started.toISOString().slice(14, 16)}`;
    expect(res.body.fileName).toBe(`db-database-${stamp}.dump`);
    const url = new URL(res.body.url);
    expect(url.origin).toBe(`http://127.0.0.1:${s3.port}`);
    expect(url.pathname).toBe(`/backups/${key}`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      "response-content-disposition": `attachment; filename="${res.body.fileName}"`,
      "X-Amz-Expires": "300",
      "X-Amz-SignedHeaders": "host",
    });
    expect([...url.searchParams.keys()].sort()).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
      "response-content-disposition",
    ]);
    // No key in it but the presign's access key id; the secret never.
    expect(res.body.url).not.toContain("super-secret-key");
    expect(Date.parse(res.body.expiresAt) - Date.now()).toBeGreaterThan(290_000);
    expect(Date.parse(res.body.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);

    // The signature is the panel's presign of exactly that object and that file name.
    const destination = panel.deps.db.select().from(backupDestinations).where(eq(backupDestinations.id, destinationId)).get();
    const date = url.searchParams.get("X-Amz-Date") as string;
    const now = new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    );
    const config = storageConfig(panel.deps.secrets, destination as never);
    const query = { "response-content-disposition": `attachment; filename="${res.body.fileName}"` };
    expect(res.body.url).toBe(presign(config, { method: "GET", key, query, expiresIn: 300, now }));

    // The browser fetches it from the bucket itself.
    const got = await fetch(res.body.url);
    expect(await got.text()).toBe("dump bytes");
    expect(got.headers.get("content-disposition")).toBe(`attachment; filename="${res.body.fileName}"`);

    // Audited, with the name it was saved under.
    const row = panel.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.opId, backupOps.downloadUrl.id), eq(auditLog.outcome, "ok")))
      .get();
    expect(row?.input).toEqual({ serviceId: dbId, runId, fileName: res.body.fileName, destinationId });
    expect(row).toMatchObject({ targetType: "service", targetId: dbId });
    agent.disconnect();
  });

  test("no link for anything but a kept, successful backup of this service with its destination", async () => {
    const { node, project, dbId, destinationId, agent, runId } = await databaseBackup();
    const ask = (runId: string, serviceId = dbId) => callOp(panel, backupOps.downloadUrl, { serviceId, runId }, { cookie });

    // Running, failed and restore runs.
    const running = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    expect((await ask(running.body.id)).status).toBe(400);
    const failed = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    backupResult(node.id, failed.body.id, false);
    expect((await ask(failed.body.id)).status).toBe(400);
    const restore = await callOp(panel, backupOps.restore, { serviceId: dbId, runId, confirmName: "db" }, { cookie });
    expect((await ask(restore.body.id)).status).toBe(400);
    await panel.runner.runDue(panel.deps);

    // A run of another service, asked for through this one.
    const other = await callOp(
      panel,
      dbOps.create,
      { projectId: project.id, name: "db2", engine: "postgres", nodeId: node.id },
      { cookie },
    );
    expect((await ask(runId, other.body.serviceId)).status).toBe(404);

    // A row recorded before keys were checked, naming another service's object.
    const foreign = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    const othersKey = `seylo/${other.body.serviceId}/manual/20260101T030000Z-${foreign.body.id}.dump`;
    panel.deps.db.update(backupRuns).set({ status: "succeeded", objectKey: othersKey }).where(eq(backupRuns.id, foreign.body.id)).run();
    const refused = await ask(foreign.body.id);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain("X-Amz");

    // Deleted (the file is gone from the bucket).
    const kept = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    backupResult(node.id, kept.body.id);
    await callOp(panel, backupOps.deleteRun, { serviceId: dbId, runId }, { cookie });
    expect((await ask(runId)).status).toBe(400);

    // Its destination deleted: the panel has no keys for that bucket.
    expect((await ask(kept.body.id)).status).toBe(200);
    expect((await callOp(panel, backupOps.deleteDestination, { destinationId }, { cookie })).status).toBe(200);
    const gone = await ask(kept.body.id);
    expect(gone.status).toBe(409);
    expect(gone.body.error.details).toMatchObject({ reason: "noDestination" });
    agent.disconnect();
  });

  test("needs backups.restore, and on a database databases.credentials too; a volume backup only backups.restore", async () => {
    const { dbId, agent, runId } = await databaseBackup();
    const member = await createUser(panel, "member");
    const ask = () => callOp(panel, backupOps.downloadUrl, { serviceId: dbId, runId }, { cookie: member.cookie });
    const allow = (actions: string[]) => {
      panel.deps.db.delete(grants).where(eq(grants.userId, member.user.id)).run();
      grant(panel, member.user.id, "service", dbId, actions);
    };
    allow(["backups.view", "backups.run"]);
    const view = await ask();
    expect(view.status).toBe(403);
    expect(view.body.error.details).toMatchObject({ action: "backups.restore" });
    allow(["backups.view", "backups.restore"]);
    const logins = await ask();
    expect(logins.status).toBe(403);
    expect(logins.body.error.details).toMatchObject({ action: "databases.credentials" });
    allow(["backups.view", "backups.restore", "databases.credentials"]);
    expect((await ask()).status).toBe(200);
    // Refusals are in the audit log too.
    const refusals = panel.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.opId, backupOps.downloadUrl.id), eq(auditLog.errorCode, "FORBIDDEN")))
      .all();
    expect(refusals).toHaveLength(2);
    agent.disconnect();

    const { node, app, data } = await volumeSchedules();
    const volumeAgent = fakeAgent(panel, node.id, { runBackup: () => ({}) }, [], [signed]);
    const run = await callOp(panel, backupOps.runNow, { serviceId: app.id, policyId: data }, { cookie });
    backupResult(node.id, run.body.id, true, keyFor(run.body.id, ".tar.gz"));
    const other = await createUser(panel, "member");
    grant(panel, other.user.id, "service", app.id, ["backups.restore"]);
    const volume = await callOp(panel, backupOps.downloadUrl, { serviceId: app.id, runId: run.body.id }, { cookie: other.cookie });
    expect(volume.status).toBe(200);
    expect(volume.body.fileName).toMatch(/^vault-warden-data-\d{4}-\d{2}-\d{2}_\d{4}\.tar\.gz$/);
    volumeAgent.disconnect();
  });

  test("a model (MCP, AI) gets a link only after a person approved it", async () => {
    const { dbId, agent, runId } = await databaseBackup();
    const mcp = createApiKey(panel, ownerId, { kind: "mcp" });
    const asked = await callOp(panel, backupOps.downloadUrl, { serviceId: dbId, runId }, { bearer: mcp });
    expect(asked.status).toBe(403);
    expect(asked.body.error.code).toBe("APPROVAL_REQUIRED");
    // A plain API key is a person's own script: no approval.
    const key = createApiKey(panel, ownerId);
    expect((await callOp(panel, backupOps.downloadUrl, { serviceId: dbId, runId }, { bearer: key })).status).toBe(200);
    // Back up now for every schedule is an ordinary change for MCP tokens.
    expect(allOps.find((op) => op.id === backupOps.runAll.id)?.modelApproval).toBeUndefined();
    // The assistant asks for every change.
    expect(buildAiTools(allOps).find((tool) => tool.opId === backupOps.downloadUrl.id)?.needsApproval).toBe(true);
    agent.disconnect();
  });

  test("a model's link needs databases.credentials of whoever asked, not only of the person who approves it", async () => {
    const { dbId, agent, runId } = await databaseBackup();
    const pendingApprovals = () => panel.deps.db.select().from(approvals).where(eq(approvals.opId, backupOps.downloadUrl.id)).all();
    const tool = async (token: string) => {
      const principal = authenticate(panel.deps.db, { bearerToken: token });
      if (principal.type !== "apiKey") throw new Error("not a key");
      const args = { serviceId: dbId, runId };
      return callTool(panel.deps, { name: "backups_downloadUrl", args, bearerToken: token, principal, ip: null, userAgent: null });
    };

    // An MCP token limited to backups: refused at once, nothing waits for a person to approve it.
    const narrowed = createApiKey(panel, ownerId, { kind: "mcp", actions: ["backups.*"] });
    const viaHttp = await callOp(panel, backupOps.downloadUrl, { serviceId: dbId, runId }, { bearer: narrowed });
    expect(viaHttp.status).toBe(403);
    expect(viaHttp.body.error).toMatchObject({ code: "FORBIDDEN", details: { action: "databases.credentials" } });
    const viaMcp = await tool(narrowed);
    expect(viaMcp?.isError).toBe(true);
    expect(viaMcp?.content[0]?.text).toStartWith("FORBIDDEN: A database backup holds the database's logins");
    expect(pendingApprovals()).toHaveLength(0);

    // A member's token asks while the member holds databases.credentials, and loses it before the approval:
    // approving refuses, as the owner who approves could have the link but the requester no longer may.
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", dbId, ["backups.restore", "databases.credentials"]);
    const asked = await tool(createApiKey(panel, member.user.id, { kind: "mcp" }));
    expect(asked?.content[0]?.text).toContain("needs a person's approval");
    const [approval] = pendingApprovals();
    panel.deps.db.delete(grants).where(eq(grants.userId, member.user.id)).run();
    grant(panel, member.user.id, "service", dbId, ["backups.restore"]);
    const approved = await callOp(panel, approvalOps.approve, { approvalId: approval?.id as string }, { cookie });
    expect(approved.status).toBe(403);
    expect(approved.body.error.message).toContain("The requester may not do this: A database backup holds the database's logins");
    const after = panel.deps.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval?.id as string))
      .get();
    expect(after).toMatchObject({ status: "pending", resultPreview: null });
    expect(
      panel.deps.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.opId, backupOps.downloadUrl.id), eq(auditLog.outcome, "ok")))
        .all(),
    ).toHaveLength(0);

    // The assistant, for a member with backups.restore only: the call fails, nothing is queued.
    const model = scriptedModel();
    setModelProvider(model.provider);
    try {
      const updated = await callOp(
        panel,
        aiOps.updateSettings,
        { enabled: true, anthropicApiKey: "sk-ant-test-0123456789abcd", allowMembers: true },
        { cookie },
      );
      expect(updated.status).toBe(200);
      model.script = [
        [{ type: "tool_use", id: "tu_dl", name: "backups_downloadUrl", input: { serviceId: dbId, runId } }],
        [{ type: "text", text: "I cannot." }],
      ];
      const sent = await callOp(panel, aiOps.send, { message: "download the latest backup" }, { cookie: member.cookie });
      expect(sent.status).toBe(200);
      await settled(panel, sent.body.conversationId);
      const reply = (await callOp(panel, aiOps.conversation, { conversationId: sent.body.conversationId }, { cookie: member.cookie })).body
        .messages[1];
      expect(reply.parts[0]).toMatchObject({ type: "tool_call", opId: backupOps.downloadUrl.id, status: "error", approvalId: null });
      expect(reply.parts[0].resultPreview).toStartWith("FORBIDDEN: A database backup holds the database's logins");
      // Still only the MCP request above.
      expect(pendingApprovals()).toHaveLength(1);
    } finally {
      setModelProvider(null);
    }
    agent.disconnect();
  });

  test("file names keep to safe characters", () => {
    const at = new Date("2026-11-13T03:00:41.000Z");
    expect(backupFileName("vault-warden", "web-vault", at, ".tar.gz")).toBe("vault-warden-web-vault-2026-11-13_0300.tar.gz");
    expect(backupFileName("my app", 'a"b/../c', at, ".dump")).toBe("my-app-a-b-..-c-2026-11-13_0300.dump");
    expect(backupFileName("..", "", at, ".sql.gz")).toBe("backup-backup-2026-11-13_0300.sql.gz");
  });
});

/** A BackupResult with what the node measured. */
function measuredResult(nodeId: string, runId: string, value: Record<string, unknown>) {
  panel.deps.agents.emitEvent(nodeId, create(EventSchema, { payload: { case: "backupResult", value: { runId, ...value } as never } }));
}

const shopContents = {
  wholeServer: false,
  databases: [
    {
      name: "shop",
      sizeBytes: 380_000_000n,
      approxRows: 14_200n,
      tableCount: 2,
      tables: [
        { schema: "public", name: "orders", sizeBytes: 1_200_000n, approxRows: 14_000n },
        { schema: "public", name: "items", sizeBytes: 40_000n, approxRows: -1n },
      ],
    },
  ],
};

type Subject = { subject: { what: { value: { database: string; selections: unknown[] } } } };

describe("chosen databases", () => {
  test("a schedule's selection is checked, stored and sent; the run keeps what the node measured", async () => {
    const { node, dbId, destinationId } = await setup();
    const requests: Subject[] = [];
    const agent = fakeAgent(
      panel,
      node.id,
      { runBackup: (req) => void requests.push(req as never) },
      ["restoreBackup", "inspectDatabase"],
      [signed],
    );
    const policy = (selection: unknown) =>
      callOp(
        panel,
        backupOps.createPolicy,
        { serviceId: dbId, target: "database", destinationId, schedule: "0 3 * * *", selection } as never,
        {
          cookie,
        },
      );

    for (const [bad, why] of [
      [{ databases: [{ name: "a", tables: [{ name: "t" }] }, { name: "b" }] }, "only when one database"],
      [{ databases: [{ name: "template1" }] }, "system database"],
      [{ databases: [{ name: "a" }, { name: "a" }] }, "chosen twice"],
      [{ databases: [] }, ""],
      [{ databases: [{ name: "bad\nname" }] }, ""],
    ] as const) {
      const res = await policy(bad);
      expect(res.status).toBe(400);
      if (why) expect(res.body.error.message).toContain(why);
    }
    // Tables without a schema are in public.
    const tables = await policy({ databases: [{ name: "shop", tables: [{ name: "orders" }, { schema: "billing", name: "items" }] }] });
    expect(tables.status).toBe(200);
    expect(tables.body.selection).toEqual({
      databases: [
        {
          name: "shop",
          tables: [
            { schema: "public", name: "orders" },
            { schema: "billing", name: "items" },
          ],
        },
      ],
    });
    const two = await policy({ databases: [{ name: "shop" }, { name: "crm" }] });
    expect(two.body.selection).toEqual({ databases: [{ name: "shop" }, { name: "crm" }] });
    // Back to everything, and to the two again.
    const changed = await callOp(panel, backupOps.updatePolicy, { serviceId: dbId, policyId: two.body.id, selection: null }, { cookie });
    expect(changed.body.selection).toBeNull();
    await callOp(
      panel,
      backupOps.updatePolicy,
      { serviceId: dbId, policyId: two.body.id, selection: { databases: [{ name: "shop" }, { name: "crm" }] } },
      { cookie },
    );

    // The run copies the selection and sends it: one database also as database.
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, policyId: tables.body.id }, { cookie });
    expect(run.body).toMatchObject({ scope: "tables", selection: tables.body.selection, contents: null, warnings: [] });
    expect(requests[0]?.subject.what.value).toMatchObject({
      database: "shop",
      selections: [
        {
          database: "shop",
          tables: [
            { schema: "public", name: "orders" },
            { schema: "billing", name: "items" },
          ],
        },
      ],
    });
    const many = await callOp(panel, backupOps.runNow, { serviceId: dbId, policyId: two.body.id }, { cookie });
    expect(many.body.scope).toBe("databases");
    expect(requests[1]?.subject.what.value).toMatchObject({ database: "", selections: [{ database: "shop" }, { database: "crm" }] });
    // A one-off backs up everything, as before.
    const oneOff = await callOp(panel, backupOps.runNow, { serviceId: dbId, target: "database", destinationId }, { cookie });
    expect(oneOff.body.scope).toBe("everything");
    expect(requests[2]?.subject.what.value).toMatchObject({ database: "", selections: [] });

    // What the node measured, and what it skipped.
    measuredResult(node.id, run.body.id, {
      success: true,
      sizeBytes: 96_000_000n,
      objectKey: keyFor(run.body.id),
      contents: shopContents,
      warnings: ['The table "billing.items" in "shop" no longer exists, so it was skipped.'],
    });
    measuredResult(node.id, many.body.id, {
      success: false,
      error: 'none of the chosen databases exist any more: "shop", "crm"',
      warnings: ['The database "shop" no longer exists, so it was skipped.', 'The database "crm" no longer exists, so it was skipped.'],
    });
    const runs = (await callOp(panel, backupOps.listRuns, { serviceId: dbId }, { cookie })).body.runs as Record<string, unknown>[];
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get(run.body.id)).toMatchObject({
      status: "succeeded",
      sizeBytes: 96_000_000,
      contents: {
        wholeServer: false,
        databases: [{ name: "shop", sizeBytes: 380_000_000, approxRows: 14_200, tableCount: 2, tablesTruncated: false }],
      },
      warnings: ['The table "billing.items" in "shop" no longer exists, so it was skipped.'],
    });
    // The list carries no tables; runContents does.
    const listed = byId.get(run.body.id) as { contents: { databases: object[] } };
    expect(listed.contents.databases[0]).not.toHaveProperty("tables");
    expect(byId.get(many.body.id)).toMatchObject({ status: "failed", error: 'none of the chosen databases exist any more: "shop", "crm"' });
    expect((byId.get(many.body.id) as { warnings: string[] }).warnings).toHaveLength(2);
    const full = await callOp(panel, backupOps.runContents, { serviceId: dbId, runId: run.body.id }, { cookie });
    expect(full.body).toMatchObject({
      scope: "tables",
      contents: {
        databases: [
          {
            name: "shop",
            tables: [
              { schema: "public", name: "orders", sizeBytes: 1_200_000, approxRows: 14_000 },
              { name: "items", approxRows: -1 },
            ],
          },
        ],
      },
    });
    // An older agent's result: no contents, the total only.
    backupResult(node.id, oneOff.body.id);
    const old = await callOp(panel, backupOps.runContents, { serviceId: dbId, runId: oneOff.body.id }, { cookie });
    expect(old.body).toEqual({ scope: "everything", contents: null, warnings: [] });
    agent.disconnect();
  });

  test("selections need an agent that has them; Redis has none", async () => {
    const { project, node, dbId, destinationId } = await setup();
    const requests: unknown[] = [];
    const agent = fakeAgent(panel, node.id, { runBackup: (req) => void requests.push(req) }, ["restoreBackup"], [signed]);
    const refused = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: dbId, target: "database", destinationId, schedule: "0 3 * * *", selection: { databases: [{ name: "shop" }] } },
      { cookie },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("to back up chosen databases");
    // Saved while the node had them, run after it went back: the run fails saying why, nothing is sent.
    const everything = await callOp(
      panel,
      backupOps.createPolicy,
      { serviceId: dbId, target: "database", destinationId, schedule: "0 3 * * *" },
      { cookie },
    );
    panel.deps.db
      .update(backupPolicies)
      .set({ selection: { databases: [{ name: "shop" }] } })
      .where(eq(backupPolicies.id, everything.body.id))
      .run();
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, policyId: everything.body.id }, { cookie });
    expect(run.status).toBe(409);
    const row = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.policyId, everything.body.id)).get();
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("to back up chosen databases");
    expect(requests).toEqual([]);
    agent.disconnect();

    const redis = await callOp(panel, dbOps.create, { projectId: project.id, name: "cache", engine: "redis", nodeId: node.id }, { cookie });
    const onRedis = await callOp(
      panel,
      backupOps.createPolicy,
      {
        serviceId: redis.body.serviceId,
        target: "database",
        destinationId,
        schedule: "0 3 * * *",
        selection: { databases: [{ name: "0" }] },
      },
      { cookie },
    );
    expect(onRedis.status).toBe(400);
    expect((await callOp(panel, backupOps.listDatabases, { serviceId: redis.body.serviceId }, { cookie })).status).toBe(400);
  });

  test("a restore replaces what the backup holds, backs the same up first, and needs an agent that has selections", async () => {
    const { node, dbId, destinationId } = await setup();
    const runRequests: (Subject & { runId: string })[] = [];
    const restores: Subject[] = [];
    let agent = fakeAgent(
      panel,
      node.id,
      {
        runBackup: (req) => void runRequests.push(req as never),
        restoreBackup: (req) => {
          restores.push(req as never);
          return { restoredBytes: 5n };
        },
      },
      ["inspectDatabase"],
      [signed],
    );
    const policy = await callOp(
      panel,
      backupOps.createPolicy,
      {
        serviceId: dbId,
        target: "database",
        destinationId,
        schedule: "0 3 * * *",
        selection: { databases: [{ name: "shop", tables: [{ name: "orders" }, { name: "items" }, { name: "gone" }] }] },
      },
      { cookie },
    );
    const run = await callOp(panel, backupOps.runNow, { serviceId: dbId, policyId: policy.body.id }, { cookie });
    measuredResult(node.id, run.body.id, { success: true, sizeBytes: 10n, objectKey: keyFor(run.body.id), contents: shopContents });

    const restore = await callOp(
      panel,
      backupOps.restore,
      { serviceId: dbId, runId: run.body.id, confirmName: "db", backupFirst: true },
      { cookie },
    );
    // The restore's row shows what it replaces.
    expect(restore.body).toMatchObject({ kind: "restore", scope: "tables", contents: { databases: [{ name: "shop", tableCount: 2 }] } });
    const job = panel.runner.runDue(panel.deps);
    for (let i = 0; i < 200 && runRequests.length < 2; i++) await Bun.sleep(10);
    // The safety backup takes what the backup holds (not the gone table); the restore sends the same.
    const held = [
      {
        database: "shop",
        tables: [
          { schema: "public", name: "orders" },
          { schema: "public", name: "items" },
        ],
      },
    ];
    const safety = runRequests[1];
    expect(safety?.subject.what.value).toMatchObject({ database: "shop", selections: held });
    measuredResult(node.id, safety?.runId as string, {
      success: true,
      sizeBytes: 10n,
      objectKey: keyFor(safety?.runId as string),
      contents: shopContents,
    });
    await job;
    expect(restores[0]?.subject.what.value).toMatchObject({ database: "shop", selections: held });
    expect(panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, restore.body.id)).get()?.status).toBe("succeeded");
    agent.disconnect();

    // The node went back to an agent without selections: the restore fails before the call.
    agent = fakeAgent(panel, node.id, { restoreBackup: () => ({ restoredBytes: 1n }) }, ["runBackup"], [signed]);
    const again = await callOp(panel, backupOps.restore, { serviceId: dbId, runId: run.body.id, confirmName: "db" }, { cookie });
    await panel.runner.runDue(panel.deps);
    const failed = panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, again.body.id)).get();
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("to restore this backup");
    expect(agent.calls.filter((c) => c.method === "restoreBackup")).toEqual([]);
    agent.disconnect();
  });

  test("listDatabases answers with a state the dialog shows", async () => {
    const { node, dbId } = await setup();
    const list = () => callOp(panel, backupOps.listDatabases, { serviceId: dbId }, { cookie }).then((r) => r.body);
    expect(await list()).toMatchObject({ state: "offline", message: expect.stringContaining("is not connected"), databases: [] });
    let agent = fakeAgent(panel, node.id, {}, ["runBackup"], [signed]);
    expect(await list()).toMatchObject({ state: "agentTooOld", message: expect.stringContaining("Update") });
    agent.disconnect();

    let answer: () => unknown = () => ({
      contents: {
        databases: [
          { name: "app", sizeBytes: 7_500_000n, tableCount: 3 },
          { name: "shop", sizeBytes: 9_100_000n, tableCount: 2 },
        ],
      },
    });
    const asked: { database: string }[] = [];
    agent = fakeAgent(panel, node.id, {
      inspectDatabase: (req) => {
        asked.push(req);
        return answer() as never;
      },
    });
    expect(await list()).toEqual({
      state: "ok",
      message: null,
      databases: [
        { name: "app", sizeBytes: 7_500_000, tableCount: 3 },
        { name: "shop", sizeBytes: 9_100_000, tableCount: 2 },
      ],
      tables: null,
      truncated: false,
    });
    answer = () => ({
      contents: {
        databases: [
          {
            name: "shop",
            sizeBytes: 9_100_000n,
            tableCount: 2,
            tablesTruncated: true,
            tables: [{ schema: "public", name: "orders", sizeBytes: 1_200_000n, approxRows: -1n }],
          },
        ],
      },
    });
    const tables = await callOp(panel, backupOps.listDatabases, { serviceId: dbId, database: "shop" }, { cookie });
    expect(tables.body).toMatchObject({
      state: "ok",
      tables: [{ schema: "public", name: "orders", sizeBytes: 1_200_000, approxRows: -1 }],
      truncated: true,
    });
    expect(asked.at(-1)?.database).toBe("shop");
    answer = () => {
      throw new OpError(
        "CONFLICT",
        'listing the databases exited with code 2: psql: error: FATAL:  password authentication failed for user "postgres"',
      );
    };
    expect(await list()).toMatchObject({ state: "signInFailed", message: expect.stringContaining("refused Seylo's sign-in") });
    answer = () => {
      throw new OpError("CONFLICT", "listing the databases took longer than 1m0s");
    };
    expect(await list()).toMatchObject({ state: "failed", message: expect.stringContaining("took longer") });
    panel.deps.db.update(services).set({ stopped: true }).where(eq(services.id, dbId)).run();
    expect(await list()).toMatchObject({ state: "stopped", message: "The database is stopped. Start it to choose databases." });

    // Like the Users tab: database credentials.
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", dbId, ["services.view", "backups.view", "backups.edit"]);
    expect((await callOp(panel, backupOps.listDatabases, { serviceId: dbId }, { cookie: member.cookie })).status).toBe(403);
    agent.disconnect();
  });

  test("a .bundle of several databases is one run's object, signed, kept and pruned like the others", () => {
    const run = { id: "r1", serviceId: "s1" };
    expect(ownObjectKey(run, "seylo/s1/p1/20260101T030000Z-r1.bundle")).toBe(true);
    expect(ownObjectKey(run, "seylo/s1/p1/20260101T030000Z-r2.bundle")).toBe(false);
    const folder = "seylo/s1/p1/";
    const keys = [
      `${folder}20260101T030000Z-a.bundle`,
      `${folder}20260102T030000Z-b.dump`,
      `${folder}20260103T030000Z-c.bundle`,
      `${folder}notes.bundle`,
    ];
    expect(expiredObjects(folder, keys, 2)).toEqual([`${folder}20260101T030000Z-a.bundle`]);
  });
});
