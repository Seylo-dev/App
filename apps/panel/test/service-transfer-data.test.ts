// Volume data in service exports and imports, on two panels in one process
// (transfer-helpers.ts side()): the download reads each volume from its
// node into the zip and stops the service around it; the import sends a
// volume's parts straight to its node with the manifest's limits.

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  backups as backupOps,
  databases as dbOps,
  deployments as deploymentOps,
  OpError,
  projects,
  services as serviceOps,
  serviceTransfer as transferOps,
} from "@seylo/ops";
import { eq } from "drizzle-orm";
import { auditLog, backupRuns, nodes, serviceExports, serviceImports, serviceSecrets, services } from "../src/db/schema";
import { adminPasswordSecret } from "../src/modules/databases/info";
import { workInFlight } from "../src/modules/panelMove/preflight";
import { transfersInFlight } from "../src/modules/services/copies";
import { exportWatch, recoverExports } from "../src/modules/serviceTransfer/export-stream";
import { uploadWatch } from "../src/modules/serviceTransfer/import-data";
import { callOp } from "./helpers";
import { begin, closeSides, craft, entriesOf, exportZip, makeApp, passphrase, type Side, secretValue, sha, side } from "./transfer-helpers";

const watch = { ...exportWatch };
const idle = uploadWatch.idleMs;
afterEach(() => {
  Object.assign(exportWatch, watch);
  uploadWatch.idleMs = idle;
  closeSides();
});

/** A volume's contents on the side's node, as ExportVolume streams them. */
function putVolume(s: Side, serviceId: string, volume: string, bytes: Uint8Array) {
  const store = s.fleet.volumes.get(s.nodeId) ?? new Map<string, Uint8Array>();
  store.set(`${serviceId}/${volume}`, bytes);
  s.fleet.volumes.set(s.nodeId, store);
}

function volumeOf(s: Side, serviceId: string, volume: string) {
  return s.fleet.volumes.get(s.nodeId)?.get(`${serviceId}/${volume}`);
}

const stoppedNow = (s: Side, id: string) => s.panel.deps.db.select().from(services).where(eq(services.id, id)).get()?.stopped;
const exportRow = (s: Side, id: string) => s.panel.deps.db.select().from(serviceExports).where(eq(serviceExports.id, id)).get();

async function appWithData(s: Side, bytes = 200_000) {
  const id = await makeApp(s);
  const data = new Uint8Array(gzipSync(randomBytes(bytes)));
  putVolume(s, id, "uploads", data);
  return { id, data };
}

/** Starts a download without reading it to the end. */
async function openDownload(s: Side, url: string) {
  const response = await s.panel.app.handle(new Request(`http://panel.test${url}`, { headers: { host: "panel.test" } }));
  return { response, reader: response.body?.getReader() };
}

async function exportOp(s: Side, serviceId: string, input: Record<string, unknown> = {}) {
  return callOp(s.panel, transferOps.exportService, { serviceId, secrets: "encrypted", passphrase, ...input } as never, {
    cookie: s.cookie,
  });
}

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("export with volume data", () => {
  test("each volume goes in stored, with its sha256 and counts in the manifest; the service is stopped while it is read", async () => {
    const a = await side();
    const { id, data } = await appWithData(a);
    const seen: (boolean | undefined)[] = [];
    a.fleet.onExportChunk = () => seen.push(stoppedNow(a, id));
    const preview = await callOp(a.panel, transferOps.exportPreview, { serviceId: id }, { cookie: a.cookie });
    expect(preview.body.data).toMatchObject({ blocker: null, database: false, node: { id: a.nodeId, name: "node-a" } });
    const file = await exportZip(a, id, { volumes: ["uploads"] });
    const e = await entriesOf(file.bytes);
    const entry = e.opened.entries.find((x) => x.name === "services/web/volumes/uploads.tar.gz");
    expect(entry?.method).toBe("store");
    expect(file.bytes.subarray(entry?.dataOffset, (entry?.dataOffset ?? 0) + data.length)).toEqual(data);
    expect(e.manifest.entries.find((x) => x.path === "services/web/volumes/uploads.tar.gz")).toEqual({
      path: "services/web/volumes/uploads.tar.gz",
      size: data.length,
      sha256: sha(data),
      unpackedBytes: data.length,
      files: 3,
    });
    // The README says how to read it; the volume's data is listed in the document.
    expect(await e.text("README.txt")).toContain("services/web/volumes/uploads.tar.gz");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((stopped) => stopped === true)).toBe(true);
    expect(stoppedNow(a, id)).toBe(false);
    const row = exportRow(a, file.exportId);
    expect(row).toMatchObject({ status: "done", volumes: ["uploads"], stopService: true, sourceStopped: false });
    const audit = a.panel.deps.db
      .select()
      .from(auditLog)
      .all()
      .find((r) => r.opId === "serviceTransfer.exportFinished");
    expect(JSON.stringify(audit?.input)).toContain('"volumes":["uploads"]');
    // The page shows the finished download with the zip's sha256.
    const detail = await callOp(a.panel, serviceOps.get, { serviceId: id }, { cookie: a.cookie });
    expect(detail.body.transfer).toMatchObject({ kind: "export", status: "done", sha256: sha(file.bytes), stopped: false });
  });

  test("with stopService off the service keeps running; volumes not picked are listed as left out", async () => {
    const a = await side();
    const { id } = await appWithData(a);
    const seen: (boolean | undefined)[] = [];
    a.fleet.onExportChunk = () => seen.push(stoppedNow(a, id));
    const off = await exportZip(a, id, { volumes: ["uploads"], stopService: false });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((stopped) => stopped === false)).toBe(true);
    expect(exportRow(a, off.exportId)?.stopService).toBe(false);
    const none = await exportOp(a, id);
    expect(none.body.stopsService).toBe(false);
    expect(exportRow(a, none.body.exportId)?.volumes).toEqual([]);
    const bad = await exportOp(a, id, { volumes: ["nope"] });
    expect([bad.status, bad.body.error.details.field]).toEqual([400, "volumes"]);
  });

  test("a database goes whole, with a passphrase, always stopped", async () => {
    const a = await side();
    const created = await callOp(
      a.panel,
      dbOps.create,
      { projectId: a.projectId, name: "pg", engine: "postgres", nodeId: a.nodeId },
      { cookie: a.cookie },
    );
    expect(created.status).toBe(200);
    const pg = a.panel.deps.db.select().from(services).where(eq(services.name, "pg")).get()?.id as string;
    putVolume(a, pg, "data", new Uint8Array(gzipSync(Buffer.from("rows"))));
    const preview = await callOp(a.panel, transferOps.exportPreview, { serviceId: pg }, { cookie: a.cookie });
    expect(preview.body.data.database).toBe(true);
    const omitted = await exportOp(a, pg, { secrets: "omitted", passphrase: undefined, volumes: ["data"] });
    expect([omitted.status, omitted.body.error.details.reason]).toEqual([400, "databaseLogins"]);
    const seen: (boolean | undefined)[] = [];
    a.fleet.onExportChunk = () => seen.push(stoppedNow(a, pg));
    const file = await exportZip(a, pg, { volumes: ["data"], stopService: false });
    expect(exportRow(a, file.exportId)?.stopService).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((stopped) => stopped === true)).toBe(true);
  });

  test("no data from a node that is offline or too old", async () => {
    const a = await side();
    const { id } = await appWithData(a);
    a.fleet.unsupported.set(a.nodeId, new Set(["exportVolume"]));
    let preview = await callOp(a.panel, transferOps.exportPreview, { serviceId: id }, { cookie: a.cookie });
    expect(preview.body.data.blocker.reason).toBe("agentTooOld");
    const old = await exportOp(a, id, { volumes: ["uploads"] });
    expect([old.status, old.body.error.details.reason]).toEqual([501, "agentTooOld"]);
    a.fleet.unsupported.clear();
    a.fleet.online.delete(a.nodeId);
    preview = await callOp(a.panel, transferOps.exportPreview, { serviceId: id }, { cookie: a.cookie });
    expect(preview.body.data.blocker.reason).toBe("offline");
    // Settings still go.
    expect((await exportOp(a, id)).status).toBe(200);
  });

  test("while a download reads its data, nothing starts, deploys, moves, deletes or restores it; updates and panel moves wait", async () => {
    const a = await side();
    const { id } = await appWithData(a);
    const other = a.fleet.addNode("node-c");
    a.fleet.volumeScript = () => ({ hang: true });
    const res = await exportOp(a, id, { volumes: ["uploads"] });
    const { reader } = await openDownload(a, res.body.download.url);
    const reading = (async () => {
      for (;;) if ((await reader?.read())?.done) return;
    })().catch(() => undefined);
    await until(() => a.fleet.calls.some((c) => c.method === "exportVolume"));
    const refusals = [
      await callOp(a.panel, serviceOps.start, { serviceId: id }, { cookie: a.cookie }),
      await callOp(a.panel, deploymentOps.deploy, { serviceId: id }, { cookie: a.cookie }),
      await callOp(a.panel, serviceOps.setVolumes, { serviceId: id, volumes: [] }, { cookie: a.cookie }),
      await callOp(a.panel, serviceOps.remove, { serviceId: id, confirmName: "web" }, { cookie: a.cookie }),
      await callOp(a.panel, serviceOps.move, { serviceId: id, toNodeId: other }, { cookie: a.cookie }),
      await callOp(
        a.panel,
        serviceOps.clone,
        { serviceId: id, projectId: a.projectId, nodeId: a.nodeId, data: "copy" },
        { cookie: a.cookie },
      ),
    ];
    const backup = a.panel.deps.db
      .insert(backupRuns)
      .values({ kind: "backup", target: "volume", serviceId: id, status: "succeeded", objectKey: `${id}/x.tar.gz`, startedAt: new Date() })
      .returning()
      .get();
    refusals.push(await callOp(a.panel, backupOps.restore, { serviceId: id, runId: backup.id, confirmName: "web" }, { cookie: a.cookie }));
    expect(refusals.map((r) => [r.status, r.body.error?.details?.reason])).toEqual(
      Array.from({ length: refusals.length }, () => [409, "exporting"]),
    );
    const otherProject = (await callOp(a.panel, projects.create, { name: "other" }, { cookie: a.cookie })).body.id as string;
    const impact = await callOp(a.panel, serviceOps.moveProjectImpact, { serviceId: id, projectId: otherProject }, { cookie: a.cookie });
    expect(impact.body.blockers.map((x: { reason: string }) => x.reason)).toContain("exporting");
    expect(transfersInFlight(a.panel.deps.db)).toBe("1 service export download");
    expect(workInFlight(a.panel.deps)).toContain("1 service export download");
    // A second download of its data waits for this one.
    const second = await exportOp(a, id, { volumes: ["uploads"] });
    expect([second.status, second.body.error.details.reason]).toEqual([409, "exporting"]);
    // Stop it: the service runs again.
    const cancelled = await callOp(a.panel, transferOps.cancelExport, { serviceId: id, exportId: res.body.exportId }, { cookie: a.cookie });
    expect(cancelled.body).toEqual({ cancelled: true });
    await reading;
    expect(exportRow(a, res.body.exportId)).toMatchObject({ status: "cancelled", sourceStopped: false });
    expect(stoppedNow(a, id)).toBe(false);
    expect(a.fleet.cancelled).toContain(`exportVolume ${id}/uploads`);
    expect(transfersInFlight(a.panel.deps.db)).toBeNull();
    expect((await callOp(a.panel, serviceOps.setVolumes, { serviceId: id, volumes: [] }, { cookie: a.cookie })).status).toBe(200);
  });

  test("a download nobody reads stops, and the service starts again", async () => {
    const a = await side();
    const { id } = await appWithData(a);
    Object.assign(exportWatch, { idleMs: 40, tickMs: 10 });
    const res = await exportOp(a, id, { volumes: ["uploads"] });
    await openDownload(a, res.body.download.url);
    expect(stoppedNow(a, id)).toBe(true);
    await until(() => exportRow(a, res.body.exportId)?.status === "failed");
    expect(exportRow(a, res.body.exportId)?.error).toContain("Nothing was read");
    expect(stoppedNow(a, id)).toBe(false);
  });

  test("a download never keeps its service stopped past the cap", async () => {
    const a = await side();
    const { id } = await appWithData(a);
    a.fleet.volumeScript = () => ({ hang: true });
    Object.assign(exportWatch, { maxStoppedMs: 60, tickMs: 10 });
    const res = await exportOp(a, id, { volumes: ["uploads"] });
    const { reader } = await openDownload(a, res.body.download.url);
    const reading = (async () => {
      for (;;) if ((await reader?.read())?.done) return;
    })().catch(() => undefined);
    await until(() => exportRow(a, res.body.exportId)?.status === "failed");
    await reading;
    expect(exportRow(a, res.body.exportId)?.error).toContain("stopped for 12 hours");
    expect(stoppedNow(a, id)).toBe(false);
  });

  test("the browser stopping the download starts the service again; so does a panel restart", async () => {
    const a = await side();
    const { id } = await appWithData(a);
    const res = await exportOp(a, id, { volumes: ["uploads"] });
    const { reader } = await openDownload(a, res.body.download.url);
    await reader?.read();
    await reader?.cancel();
    await until(() => exportRow(a, res.body.exportId)?.status === "cancelled");
    expect(stoppedNow(a, id)).toBe(false);

    // A row the panel was streaming when it stopped.
    const db = a.panel.deps.db;
    db.update(services).set({ stopped: true }).where(eq(services.id, id)).run();
    const stuck = db
      .insert(serviceExports)
      .values({
        serviceId: id,
        secrets: "encrypted",
        fileName: "web.zip",
        status: "streaming",
        volumes: ["uploads"],
        stopService: true,
        sourceStopped: true,
        startedAt: new Date(),
      })
      .returning()
      .get();
    recoverExports(a.panel.deps);
    expect(exportRow(a, stuck.id)).toMatchObject({
      status: "failed",
      sourceStopped: false,
      error: "The panel restarted during the download.",
    });
    expect(stoppedNow(a, id)).toBe(false);
  });

  test("an agent failure mid-volume fails the download and starts the service", async () => {
    const a = await side();
    const { id } = await appWithData(a);
    a.fleet.volumeScript = () => ({ fail: new OpError("INTERNAL", "disk read error") });
    const res = await exportOp(a, id, { volumes: ["uploads"] });
    const { reader } = await openDownload(a, res.body.download.url);
    await expect(
      (async () => {
        for (;;) if ((await reader?.read())?.done) return;
      })(),
    ).rejects.toBeDefined();
    await until(() => exportRow(a, res.body.exportId)?.status === "failed");
    expect(stoppedNow(a, id)).toBe(false);
  });
});

/** PUTs one part of an entry; length may differ from the body to send a part cut short. */
async function put(
  s: Side,
  ref: { projectId: string; importId: string },
  entry: string,
  offset: number,
  body: Uint8Array,
  length = body.length,
) {
  const ticket = await callOp(s.panel, transferOps.uploadTicket, { ...ref, entry, offset }, { cookie: s.cookie });
  if (ticket.status !== 200) return { status: ticket.status, body: ticket.body };
  const response = await s.panel.app.handle(
    new Request(`http://panel.test${ticket.body.url}`, {
      method: "PUT",
      headers: { host: "panel.test", "content-length": String(length) },
      body,
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
}

const entryName = "services/web/volumes/uploads.tar.gz";

async function imported(b: Side, zip: Uint8Array, choices: Record<string, unknown> = {}) {
  const begun = await begin(b, zip);
  expect(begun.status).toBe(200);
  const ref = { projectId: b.projectId, importId: begun.body.importId as string };
  const set = await callOp(b.panel, transferOps.setChoices, { ...ref, choices } as never, { cookie: b.cookie });
  return { ref, preview: set.body, begun: begun.body };
}

describe("import with volume data", () => {
  test("round trip: the volume goes up in parts straight to the node, with the manifest's hash and limits, then it deploys", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id, data } = await appWithData(a);
    const file = await exportZip(a, id, { volumes: ["uploads"] });
    const { ref, preview } = await imported(b, file.bytes, { deployWhenReady: true });
    expect(preview.data.volumes).toEqual([
      { name: "uploads", mountPath: "/data", inFile: true, sizeBytes: data.length, unpackedBytes: data.length, include: true },
    ]);
    expect(preview.warnings.map((w: { reason: string }) => w.reason)).toContain("owners");
    expect(preview.blockers).toEqual([]);
    const made = await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    expect(made.status).toBe(200);
    const newId = made.body.service.id as string;
    expect(made.body.pending).toEqual([{ entry: entryName, sizeBytes: data.length, kind: "volume", volume: "uploads" }]);
    const early = await callOp(b.panel, deploymentOps.deploy, { serviceId: newId }, { cookie: b.cookie });
    expect([early.status, early.body.error.details.reason]).toEqual([409, "importing"]);
    const half = 70_000;
    expect(await put(b, ref, entryName, 0, data.subarray(0, half))).toEqual({ status: 200, body: { received: half, done: false } });
    const state = await callOp(b.panel, transferOps.getImport, ref, { cookie: b.cookie });
    expect(state.body.entries[0]).toMatchObject({ kind: "volume", volume: "uploads", received: half, status: "pending" });
    expect(transfersInFlight(b.panel.deps.db)).toBe("1 service import upload");
    const detail = await callOp(b.panel, serviceOps.get, { serviceId: newId }, { cookie: b.cookie });
    expect(detail.body.transfer).toMatchObject({ kind: "import", bytes: half, totalBytes: data.length });
    expect(await put(b, ref, entryName, half, data.subarray(half))).toEqual({ status: 200, body: { received: data.length, done: true } });
    expect(volumeOf(b, newId, "uploads")).toEqual(data);
    const call = b.fleet.calls.find((c) => c.method === "importVolume") as { request: Record<string, unknown> };
    const limits = transferOps.volumeImportLimits({ unpackedBytes: data.length, files: 3 });
    expect(call.request).toMatchObject({
      serviceId: newId,
      volume: "uploads",
      replace: true,
      sha256: sha(data),
      maxBytes: BigInt(limits.maxBytes),
      maxEntries: BigInt(limits.maxEntries),
    });
    expect(limits).toEqual({ maxBytes: Math.ceil(data.length * 1.01) + 16 * 1024 * 1024, maxEntries: 1004 });
    expect(b.panel.deps.db.select().from(serviceImports).where(eq(serviceImports.id, ref.importId)).get()?.status).toBe("done");
    const list = await callOp(b.panel, deploymentOps.list, { serviceId: newId }, { cookie: b.cookie });
    expect(list.body.deployments.length).toBe(1);
    const audit = b.panel.deps.db
      .select()
      .from(auditLog)
      .all()
      .filter((r) => r.opId === "serviceTransfer.importData");
    expect(audit.map((r) => (r.input as { ok?: boolean }).ok)).toEqual([true]);
  });

  test("one flipped byte: the panel's hash refuses it before the end, the node's stream is cancelled and the volume stays empty", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id, data } = await appWithData(a);
    const file = await exportZip(a, id, { volumes: ["uploads"] });
    const { ref } = await imported(b, file.bytes);
    const newId = (await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie })).body.service.id as string;
    const flipped = new Uint8Array(data);
    flipped[1000] = (flipped[1000] ?? 0) ^ 1;
    const bad = await put(b, ref, entryName, 0, flipped);
    expect([bad.status, bad.body.error.details.reason]).toEqual([400, "checksum"]);
    expect(b.fleet.cancelled).toContain(`importVolume ${newId}/uploads`);
    expect(volumeOf(b, newId, "uploads")).toBeUndefined();
    const state = await callOp(b.panel, transferOps.getImport, ref, { cookie: b.cookie });
    expect(state.body.entries[0]).toMatchObject({ status: "failed", received: 0 });
    // Retry from 0 with the right bytes works.
    expect((await put(b, ref, entryName, 0, data)).body).toEqual({ received: data.length, done: true });
    expect(volumeOf(b, newId, "uploads")).toEqual(data);
  });

  test("lengths: none is 411, past the entry 413, a part cut short keeps what arrived", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id, data } = await appWithData(a);
    const { ref } = await imported(b, (await exportZip(a, id, { volumes: ["uploads"] })).bytes);
    const newId = (await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie })).body.service.id as string;
    const ticket = await callOp(b.panel, transferOps.uploadTicket, { ...ref, entry: entryName, offset: 0 }, { cookie: b.cookie });
    const noLength = await b.panel.app.handle(
      new Request(`http://panel.test${ticket.body.url}`, {
        method: "PUT",
        headers: { host: "panel.test" },
        body: new ReadableStream({ start: (c) => c.close() }),
      }),
    );
    expect(noLength.status).toBe(411);
    expect((await put(b, ref, entryName, 0, new Uint8Array(data.length + 1))).status).toBe(413);
    // 50,000 bytes of a part that said 80,000: the panel keeps them and says where to go on.
    const cut = await put(b, ref, entryName, 0, data.subarray(0, 50_000), 80_000);
    expect(cut.status).toBe(400);
    expect((await callOp(b.panel, transferOps.getImport, ref, { cookie: b.cookie })).body.entries[0].received).toBe(50_000);
    const wrongOffset = await put(b, ref, entryName, 60_000, data.subarray(60_000));
    expect([wrongOffset.status, wrongOffset.body.error.details.reason]).toEqual([409, "offset"]);
    expect((await put(b, ref, entryName, 50_000, data.subarray(50_000))).body).toEqual({ received: data.length, done: true });
    expect(volumeOf(b, newId, "uploads")).toEqual(data);
  });

  test("no part for a while ends the node's stream; the volume starts over", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id, data } = await appWithData(a);
    const { ref } = await imported(b, (await exportZip(a, id, { volumes: ["uploads"] })).bytes);
    const newId = (await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie })).body.service.id as string;
    uploadWatch.idleMs = 30;
    await put(b, ref, entryName, 0, data.subarray(0, 10_000));
    await until(() => b.fleet.cancelled.includes(`importVolume ${newId}/uploads`));
    const state = await callOp(b.panel, transferOps.getImport, ref, { cookie: b.cookie });
    expect(state.body.entries[0]).toMatchObject({ status: "failed", received: 0 });
    const late = await put(b, ref, entryName, 10_000, data.subarray(10_000));
    expect([late.status, late.body.error.details.reason]).toEqual([409, "offset"]);
  });

  test("a node without volume.import-limits.v1 takes no data from a file; leaving the data out imports the rest", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id } = await appWithData(a);
    const caps = new Set(["state.sync.v1", "volume.transfer.v1"]);
    b.fleet.caps.set(b.nodeId, caps);
    const zip = (await exportZip(a, id, { volumes: ["uploads"] })).bytes;
    const { ref, preview } = await imported(b, zip);
    expect(preview.blockers.map((x: { reason: string }) => x.reason)).toEqual(["agentTooOld"]);
    const refused = await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    expect([refused.status, refused.body.error.details.reason]).toEqual([409, "agentTooOld"]);
    const without = await callOp(b.panel, transferOps.setChoices, { ...ref, choices: { volumes: [] } }, { cookie: b.cookie });
    expect(without.body.blockers).toEqual([]);
    expect(without.body.skipped.map((x: { what: string }) => x.what)).toContain("The data of volume uploads");
    const made = await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    expect(made.body.pending).toEqual([]);

    // An agent that lost the capability after the import: the part is refused, the data never sent.
    const again = await imported(b, zip, { name: "web-3" });
    b.fleet.caps.delete(b.nodeId);
    const second = await callOp(b.panel, transferOps.importService, again.ref, { cookie: b.cookie });
    expect(second.status).toBe(200);
    b.fleet.caps.set(b.nodeId, caps);
    const part = await put(b, again.ref, entryName, 0, new Uint8Array(100));
    expect([part.status, part.body.error.details.reason]).toEqual([501, "agentTooOld"]);
    expect(b.fleet.calls.some((c) => c.method === "importVolume")).toBe(false);
  });

  test("discarding, or deleting the service, while a volume's stream is open ends it", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id, data } = await appWithData(a);
    const zip = (await exportZip(a, id, { volumes: ["uploads"] })).bytes;
    const first = await imported(b, zip);
    const firstId = (await callOp(b.panel, transferOps.importService, first.ref, { cookie: b.cookie })).body.service.id as string;
    await put(b, first.ref, entryName, 0, data.subarray(0, 10_000));
    expect((await callOp(b.panel, transferOps.discardImport, first.ref, { cookie: b.cookie })).body).toEqual({ deletedService: true });
    expect(b.fleet.cancelled).toContain(`importVolume ${firstId}/uploads`);
    expect(transfersInFlight(b.panel.deps.db)).toBeNull();

    const second = await imported(b, zip);
    const secondId = (await callOp(b.panel, transferOps.importService, second.ref, { cookie: b.cookie })).body.service.id as string;
    await put(b, second.ref, entryName, 0, data.subarray(0, 10_000));
    const removed = await callOp(b.panel, serviceOps.remove, { serviceId: secondId, confirmName: "web" }, { cookie: b.cookie });
    expect(removed.status).toBe(200);
    expect(b.fleet.cancelled).toContain(`importVolume ${secondId}/uploads`);
  });

  test("a file's manifest cannot hide data: unnamed archives, missing counts and impossible sizes are refused", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id } = await appWithData(a);
    const zip = (await exportZip(a, id, { volumes: ["uploads"], secrets: "omitted", passphrase: undefined })).bytes;
    const edits: [string, (m: transferOps.PortableManifestV1) => void][] = [
      ["badManifest", (m) => delete (m.entries.find((x) => x.path === entryName) as { unpackedBytes?: number }).unpackedBytes],
      [
        "badManifest",
        (m) => {
          const entry = m.entries.find((x) => x.path === entryName) as { size: number; unpackedBytes?: number };
          entry.unpackedBytes = entry.size * 2000;
        },
      ],
      [
        "tampered",
        (m) => m.entries.push({ path: "services/web/volumes/other.tar.gz", size: 10, sha256: "0".repeat(64), unpackedBytes: 10 }),
      ],
    ];
    for (const [reason, edit] of edits) {
      const res = await begin(b, zip, {
        edit: (e) => {
          const m = JSON.parse(e.manifestText) as transferOps.PortableManifestV1;
          edit(m);
          e.manifestText = JSON.stringify(m);
        },
      });
      expect([res.status, res.body.error.details.reason]).toEqual([400, reason]);
    }
  });

  test("data much smaller than it unpacks, or large for the node, needs a confirmation", async () => {
    const a = await side();
    const b = await side("node-b");
    const id = await makeApp(a);
    // Zeros pack well: the agent counts 500 times the archive's size.
    const zeros = new Uint8Array(gzipSync(Buffer.alloc(200_000)));
    putVolume(a, id, "uploads", zeros);
    a.fleet.volumeScript = () => ({ unpackedBytes: zeros.length * 500 });
    const zip = (await exportZip(a, id, { volumes: ["uploads"] })).bytes;
    const counted = (await entriesOf(zip)).manifest.entries.find((x) => x.path === entryName);
    expect(counted?.unpackedBytes).toBe(zeros.length * 500);
    const { ref, preview } = await imported(b, zip);
    expect(preview.needs.map((n: { reason: string }) => n.reason)).toEqual(["dataRatio"]);
    const confirmed = await callOp(b.panel, transferOps.setChoices, { ...ref, choices: { confirmData: true } }, { cookie: b.cookie });
    expect(confirmed.body.needs).toEqual([]);
    // A node that reports little free space.
    b.panel.deps.db
      .update(nodes)
      .set({ facts: { diskTotalBytes: String(20 * 1024 ** 3), diskFreeBytes: String(20 * 1024 ** 2) } as never })
      .where(eq(nodes.id, b.nodeId))
      .run();
    const small = await callOp(b.panel, transferOps.setChoices, { ...ref, choices: { confirmData: false } }, { cookie: b.cookie });
    expect(small.body.needs.map((n: { reason: string }) => n.reason)).toContain("dataSpace");
    expect(small.body.warnings.map((w: { reason: string }) => w.reason)).toContain("space");
  });

  test("a database's data comes with the file's logins, and needs them", async () => {
    const a = await side();
    const b = await side("node-b");
    await callOp(a.panel, dbOps.create, { projectId: a.projectId, name: "pg", engine: "postgres", nodeId: a.nodeId }, { cookie: a.cookie });
    const pg = a.panel.deps.db.select().from(services).where(eq(services.name, "pg")).get()?.id as string;
    const rows = new Uint8Array(gzipSync(Buffer.from("table rows")));
    putVolume(a, pg, "data", rows);
    const old = a.panel.deps.secrets.open(
      a.panel.deps.db
        .select()
        .from(serviceSecrets)
        .where(eq(serviceSecrets.serviceId, pg))
        .all()
        .find((r) => r.name === adminPasswordSecret)?.valueSealed as string,
      "service.secret",
    );
    const zip = (await exportZip(a, pg, { volumes: ["data"] })).bytes;
    const { ref, preview } = await imported(b, zip);
    expect(preview.data.volumes).toMatchObject([{ name: "data", inFile: true, include: true }]);
    expect(preview.blockers).toEqual([]);
    const made = await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    const newId = made.body.service.id as string;
    expect((await put(b, ref, "services/pg/volumes/data.tar.gz", 0, rows)).body.done).toBe(true);
    expect(volumeOf(b, newId, "data")).toEqual(rows);
    const login = b.panel.deps.db
      .select()
      .from(serviceSecrets)
      .where(eq(serviceSecrets.serviceId, newId))
      .all()
      .find((r) => r.name === adminPasswordSecret);
    expect(b.panel.deps.secrets.open(login?.valueSealed as string, "service.secret")).toBe(old);

    // Logins this panel would not take: new ones would not open the data, so the data needs leaving out.
    const crafted = await craft(zip, b.projectId, (plain) => {
      plain.services.pg.databaseSecrets[adminPasswordSecret] = "not; a password";
    });
    const refused = await callOp(b.panel, transferOps.importBegin, crafted, { cookie: b.cookie });
    expect(refused.body.blockers.map((x: { reason: string }) => x.reason)).toContain("databaseLogins");
    const ref2 = { projectId: b.projectId, importId: refused.body.importId as string };
    const without = await callOp(b.panel, transferOps.setChoices, { ...ref2, choices: { volumes: [] } }, { cookie: b.cookie });
    expect(without.body.blockers.map((x: { reason: string }) => x.reason)).not.toContain("databaseLogins");
  });
});

describe("secrets and data never reach logs or the audit log", () => {
  test("a round trip with volume data keeps the passphrase and values out", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id, data } = await appWithData(a);
    const file = await exportZip(a, id, { volumes: ["uploads"] });
    const { ref } = await imported(b, file.bytes);
    await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    await put(b, ref, entryName, 0, data);
    for (const s of [a, b]) {
      const audit = JSON.stringify(s.panel.deps.db.select().from(auditLog).all());
      const logs = s.logs.join("\n");
      for (const needle of [passphrase, secretValue]) {
        expect(audit).not.toContain(needle);
        expect(logs).not.toContain(needle);
      }
    }
  });
});
