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
