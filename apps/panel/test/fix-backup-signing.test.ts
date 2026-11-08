// Nodes never get a backup destination's keys: RunBackup and RestoreBackup
// carry the destination without them, and the node asks
// PanelService.SignBackupRequests for each S3 step. The panel serves only
// what the run needs: for its own object presigned PUT, UploadPart and
// DELETE URLs plus the multipart create, complete and abort steps (made by
// the panel itself), and for a restore the GET of the restored backup.
// Anything else, another node, or a finished run is PERMISSION_DENIED, so a
// compromised node cannot read or delete other services' backups.
// Retention is the panel's (backups.prune).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { backups as backupOps } from "@seylo/ops";
import {
  BackupStorageOp,
  type BackupStorageRequestSchema,
  SignBackupRequestsRequestSchema,
  SignBackupRequestsResponseSchema,
  StatusCode,
} from "@seylo/proto";
import { eq } from "drizzle-orm";
import { panelCapabilities } from "../src/agent-hub/panel-service";
import { backupPolicies, backupRuns } from "../src/db/schema";
import { type FakeAgent, FakeStatus } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen, seedProject, seedService } from "./hub-helpers";

// A path-style bucket that keeps what a presigned PUT sends and answers GETs.
const objects = new Map<string, string>();
const steps: string[] = [];
const completed: string[] = [];
let failComplete = false;
let s3: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  s3 = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const presigned = url.searchParams.get("X-Amz-Credential")?.startsWith("GOODKEY/") && url.searchParams.get("X-Amz-Signature");
      const headerSigned = req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=GOODKEY/");
      if (!presigned && !headerSigned) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      steps.push(
        `${req.method} ${headerSigned ? "panel" : "node"} ${[...url.searchParams.keys()].filter((k) => !k.startsWith("X-Amz-")).join(",")}`,
      );
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>up-1&amp;x</UploadId></InitiateMultipartUploadResult>");
      }
      if (req.method === "POST" && url.searchParams.get("uploadId") === "up-1&x") {
        completed.push(await req.text());
        return new Response(failComplete ? "<Error><Code>InvalidPart</Code></Error>" : "<CompleteMultipartUploadResult/>");
      }
      if (req.method === "PUT") objects.set(url.pathname, await req.text());
      if (req.method === "GET") return new Response(objects.get(url.pathname) ?? "", { status: objects.has(url.pathname) ? 200 : 404 });
      return new Response("");
    },
  });
});
afterAll(() => s3.stop(true));

let panel: TestPanel;
let url: string;
const agents: FakeAgent[] = [];
beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
  objects.clear();
  steps.length = 0;
  completed.length = 0;
  failComplete = false;
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

type Req = MessageInitShape<typeof BackupStorageRequestSchema>;

const sign = (agent: FakeAgent, signingId: string, requests: Req[]) =>
  agent
    .callPanel("SignBackupRequests", SignBackupRequestsRequestSchema, SignBackupRequestsResponseSchema, { signingId, requests })
    .then((r) => r.requests);

async function refused(agent: FakeAgent, signingId: string, requests: Req[], code = StatusCode.PERMISSION_DENIED) {
  const error = await sign(agent, signingId, requests).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FakeStatus);
  expect((error as FakeStatus).code).toBe(code);
  return (error as FakeStatus).message;
}

async function setup(keepLast = 2) {
  const { cookie } = await createUser(panel, "owner");
  const agent = await joinAgent(panel, url);
  const other = await joinAgent(panel, url);
  agents.push(agent, other);
  const project = seedProject(panel);
  const svc = seedService(panel, project.id, agent.nodeId, { name: "db" });
  const neighbour = seedService(panel, project.id, other.nodeId, { name: "other" });
  const dest = await callOp(
    panel,
    backupOps.createDestination,
    {
      name: "bucket",
      provider: "minio",
      endpoint: `http://127.0.0.1:${s3.port}`,
      region: "us-east-1",
      bucket: "backups",
      pathPrefix: "seylo/",
      pathStyle: true,
      accessKeyId: "GOODKEY",
      secretAccessKey: "super-secret-key",
    },
    { cookie },
  );
  const destinationId = dest.body.id as string;
  const policy = panel.deps.db
    .insert(backupPolicies)
    .values({ serviceId: svc.id, destinationId, target: "volume", schedule: "0 3 * * *", keepLast })
    .returning()
    .get();
  const run = (values: Partial<typeof backupRuns.$inferInsert> = {}) =>
    panel.deps.db
      .insert(backupRuns)
      .values({
        kind: "backup",
        target: "volume",
        serviceId: svc.id,
        destinationId,
        policyId: policy.id,
        nodeId: agent.nodeId,
        status: "running",
        startedAt: new Date(),
        ...values,
      })
      .returning()
      .get();
  const folder = `seylo/${svc.id}/${policy.id}/`;
  return { agent, other, svc, neighbour, destinationId, policy, run, folder };
}

test("the panel advertises the capability", () => {
  expect(panelCapabilities).toContain("panel.backup-sign.v1");
});

describe("a running backup", () => {
  test("gets its own object signed, without the secret, and the URL works against the bucket", async () => {
    const { agent, run, folder } = await setup();
    const r = run();
    const key = `${folder}20260101T030000Z-${r.id}.tar.gz`;
    const [put] = await sign(agent, r.id, [{ op: BackupStorageOp.PUT, key }]);
    expect(put?.method).toBe("PUT");
    const signed = new URL(put?.url ?? "");
    expect(signed.origin).toBe(`http://127.0.0.1:${s3.port}`);
    expect(signed.pathname).toBe(`/backups/${key}`);
    expect(signed.searchParams.get("X-Amz-Credential")).toStartWith("GOODKEY/");
    expect(Number(signed.searchParams.get("X-Amz-Expires"))).toBe(3600);
    expect(put?.url).not.toContain("super-secret-key");
    expect((await fetch(put?.url ?? "", { method: "PUT", body: "archive bytes" })).status).toBe(200);
    expect(objects.get(`/backups/${key}`)).toBe("archive bytes");

    // Multipart: the node gets a URL per part; the panel starts, finishes and aborts the upload itself.
    const [created] = await sign(agent, r.id, [{ op: BackupStorageOp.CREATE_MULTIPART, key }]);
    expect(created).toMatchObject({ uploadId: "up-1&x", url: "" });
    const [part] = await sign(agent, r.id, [{ op: BackupStorageOp.UPLOAD_PART, key, uploadId: "up-1&x", partNumber: 3 }]);
    const partUrl = new URL(part?.url ?? "");
    expect([part?.method, partUrl.searchParams.get("partNumber"), partUrl.searchParams.get("uploadId")]).toEqual(["PUT", "3", "up-1&x"]);
    const parts = [
      { partNumber: 1, etag: '"e1"' },
      { partNumber: 2, etag: '"e<2>"' },
    ];
    expect(await sign(agent, r.id, [{ op: BackupStorageOp.COMPLETE_MULTIPART, key, uploadId: "up-1&x", parts }])).toEqual([
      expect.objectContaining({ url: "", uploadId: "" }),
    ]);
    expect(completed).toEqual([
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;e&lt;2&gt;&quot;</ETag></Part></CompleteMultipartUpload>",
    ]);
    // A completion the bucket refuses in a 200 body is an error for the node.
    failComplete = true;
    expect(
      await refused(agent, r.id, [{ op: BackupStorageOp.COMPLETE_MULTIPART, key, uploadId: "up-1&x", parts }], StatusCode.UNAVAILABLE),
    ).toContain("InvalidPart");
    await sign(agent, r.id, [{ op: BackupStorageOp.ABORT_MULTIPART, key, uploadId: "up-1&x" }]);
    const [del] = await sign(agent, r.id, [{ op: BackupStorageOp.DELETE, key }]);
    expect(del?.method).toBe("DELETE");
    expect(steps).toEqual(["PUT node ", "POST panel uploads", "POST panel uploadId", "POST panel uploadId", "DELETE panel uploadId"]);
  });

  test("anything else is refused: other services' objects, other runs, downloads, other nodes, finished runs", async () => {
    const { agent, other, run, folder, neighbour, policy } = await setup();
    const r = run();
    const own = `${folder}20260101T030000Z-${r.id}.tar.gz`;
    const neighbours = `seylo/${neighbour.id}/${policy.id}/20260101T030000Z-${r.id}.tar.gz`;
    for (const request of [
      { op: BackupStorageOp.PUT, key: neighbours },
      { op: BackupStorageOp.DELETE, key: neighbours },
      { op: BackupStorageOp.PUT, key: `${folder}20260101T030000Z-${crypto.randomUUID()}.tar.gz` },
      { op: BackupStorageOp.PUT, key: `${folder}../../${neighbour.id}/x/20260101T030000Z-${r.id}.tar.gz` },
      { op: BackupStorageOp.PUT, key: `${folder}20260101T030000Z-${r.id}.exe` },
      { op: BackupStorageOp.GET, key: own },
      { op: BackupStorageOp.DELETE, key: `${folder}20251231T030000Z-${crypto.randomUUID()}.tar.gz` },
      { op: BackupStorageOp.UPLOAD_PART, key: own, uploadId: "u", partNumber: 0 },
      { op: BackupStorageOp.UPLOAD_PART, key: own, uploadId: "u", partNumber: 10001 },
      { op: BackupStorageOp.COMPLETE_MULTIPART, key: own },
      { op: BackupStorageOp.COMPLETE_MULTIPART, key: own, uploadId: "u", parts: [{ partNumber: 2, etag: "x" }] },
      { op: BackupStorageOp.COMPLETE_MULTIPART, key: own, uploadId: "u", parts: [] },
      { op: BackupStorageOp.UNSPECIFIED, key: own },
    ]) {
      await refused(agent, r.id, [{ op: BackupStorageOp.PUT, key: own }, request]);
    }
    // Another node, an unknown id, a finished run.
    await refused(other, r.id, [{ op: BackupStorageOp.PUT, key: own }]);
    await refused(agent, crypto.randomUUID(), [{ op: BackupStorageOp.PUT, key: own }]);
    panel.deps.db.update(backupRuns).set({ status: "succeeded" }).where(eq(backupRuns.id, r.id)).run();
    await refused(agent, r.id, [{ op: BackupStorageOp.DELETE, key: own }]);
    // Too many at once.
    const many = Array.from({ length: 33 }, () => ({ op: BackupStorageOp.PUT, key: own }));
    await refused(agent, run().id, many, StatusCode.INVALID_ARGUMENT);
  });
});

describe("a running restore", () => {
  test("gets only the download of the restored backup, on the service's node", async () => {
    const { agent, other, run, folder, neighbour, policy } = await setup();
    const source = run({ status: "succeeded" });
    const key = `${folder}20260101T030000Z-${source.id}.tar.gz`;
    panel.deps.db.update(backupRuns).set({ objectKey: key }).where(eq(backupRuns.id, source.id)).run();
    objects.set(`/backups/${key}`, "the archive");
    const restore = run({ kind: "restore", sourceRunId: source.id });

    const [get] = await sign(agent, restore.id, [{ op: BackupStorageOp.GET, key }]);
    expect(get?.method).toBe("GET");
    expect(await (await fetch(get?.url ?? "")).text()).toBe("the archive");

    const neighbours = `seylo/${neighbour.id}/${policy.id}/20260101T030000Z-${source.id}.tar.gz`;
    await refused(agent, restore.id, [{ op: BackupStorageOp.GET, key: neighbours }]);
    await refused(agent, restore.id, [{ op: BackupStorageOp.PUT, key }]);
    await refused(agent, restore.id, [{ op: BackupStorageOp.DELETE, key }]);
    await refused(other, restore.id, [{ op: BackupStorageOp.GET, key }]);
    panel.deps.db.update(backupRuns).set({ status: "failed" }).where(eq(backupRuns.id, restore.id)).run();
    await refused(agent, restore.id, [{ op: BackupStorageOp.GET, key }]);
  });
});
