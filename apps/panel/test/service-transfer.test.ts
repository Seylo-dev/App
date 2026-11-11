import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { deployments as deploymentOps, env, projects, services as serviceOps, serviceTransfer as transferOps } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import {
  alertRules,
  auditLog,
  cronJobs,
  deployTriggers,
  domains,
  maintenancePages,
  notificationChannels,
  serviceExports,
  serviceImports,
  services,
  sessions,
  sourceUploads,
  uptimeChecks,
  volumes,
} from "../src/db/schema";
import { readProjectEnv, readServiceEnv, writeProjectEnv } from "../src/modules/env/store";
import { materializeService } from "../src/modules/services/portable";
import { defaultSpec } from "../src/modules/services/spec";
import { sweepTransfers } from "../src/modules/serviceTransfer";
import { scryptLimits } from "../src/modules/serviceTransfer/crypto";
import { mergeSharedLines } from "../src/modules/serviceTransfer/plan";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { callOp, createApiKey, createUser, grant } from "./helpers";
import {
  begin,
  closeSides,
  craft,
  download,
  entriesOf,
  exportZip,
  makeApp,
  passphrase,
  type Side,
  secretValue,
  sha,
  side,
} from "./transfer-helpers";

afterEach(closeSides);

describe("export", () => {
  test("writes a valid zip whose manifest hashes every entry, and keeps secret values out of the clear", async () => {
    const a = await side();
    const id = await makeApp(a);
    const file = await exportZip(a, id);
    expect(file.headers.get("content-type")).toBe("application/zip");
    expect(file.headers.get("content-disposition")).toContain(file.fileName);
    expect(file.fileName).toMatch(/^web-\d{8}-\d{4}\.seylo\.zip$/);
    const e = await entriesOf(file.bytes);
    expect(e.opened.entries.map((x) => x.name).sort()).toEqual(["README.txt", "manifest.json", "manifest.sig", "secrets.enc"]);
    for (const entry of e.manifest.entries) expect(sha(new TextEncoder().encode((await e.text(entry.path)) as string))).toBe(entry.sha256);
    // With a passphrase even the settings are inside secrets.enc.
    const all = Buffer.from(file.bytes).toString("latin1");
    for (const needle of [secretValue, "shop.example.org", "echo cleanup", "SENTRY_DSN", "nginx-conf"])
      expect(all.includes(needle)).toBe(false);
    for (const entry of e.opened.entries) expect((await e.text(entry.name))?.includes(secretValue)).toBe(false);
    const row = a.panel.deps.db.select().from(serviceExports).where(eq(serviceExports.id, file.exportId)).get();
    expect(row?.status).toBe("done");
    expect(row?.payloadSealed).toBeNull();
    expect(row?.zipSha256).toBe(sha(file.bytes));
  });

  test("with secret values left out, service.json is in clear and holds no value", async () => {
    const a = await side();
    const id = await makeApp(a);
    const file = await exportZip(a, id, { secrets: "omitted", passphrase: undefined });
    const e = await entriesOf(file.bytes);
    expect(e.secretsEnc).toBeUndefined();
    expect(e.signature).toBeUndefined();
    const doc = JSON.parse(e.services[0]?.json as string) as transferOps.PortableServiceV1;
    expect(doc.env.keys).toEqual(["PLAIN", "SECRET", "SELF", "OWN", "SENTRY"]);
    expect(doc.env.shared).toEqual(["SENTRY_DSN"]);
    expect(doc.domains.find((d) => !d.auto)?.middlewares.basicAuthUsers).toEqual(["admin"]);
    expect(Buffer.from(file.bytes).includes(Buffer.from(secretValue))).toBe(false);
    expect(Buffer.from(file.bytes).includes(Buffer.from("$2y$10$"))).toBe(false);
  });

  test("the link works once, and only for a ready export", async () => {
    const a = await side();
    const id = await makeApp(a);
    const res = await callOp(a.panel, transferOps.exportService, { serviceId: id, secrets: "omitted" }, { cookie: a.cookie });
    expect((await download(a, res.body.download.url)).status).toBe(200);
    expect((await download(a, res.body.download.url)).status).toBe(401);
    const again = await callOp(a.panel, transferOps.exportLink, { serviceId: id, exportId: res.body.exportId }, { cookie: a.cookie });
    expect(again.status).toBe(404);
  });

  test("a new link for an export whose download has not started, then the sweep wipes it", async () => {
    const a = await side();
    const id = await makeApp(a);
    const res = await callOp(a.panel, transferOps.exportService, { serviceId: id, secrets: "omitted" }, { cookie: a.cookie });
    const link = await callOp(a.panel, transferOps.exportLink, { serviceId: id, exportId: res.body.exportId }, { cookie: a.cookie });
    expect(link.status).toBe(200);
    await sweepTransfers(a.panel.deps, new Date(Date.now() + 3 * 60_000));
    const row = a.panel.deps.db.select().from(serviceExports).where(eq(serviceExports.id, res.body.exportId)).get();
    expect(row?.status).toBe("failed");
    expect(row?.payloadSealed).toBeNull();
    expect((await download(a, link.body.download.url)).status).toBe(410);
  });

  test("blockers: compose members, protected services, the panel, previews", async () => {
    const a = await side();
    const id = await makeApp(a);
    a.panel.deps.db.update(services).set({ protected: true }).where(eq(services.id, id)).run();
    const preview = await callOp(a.panel, transferOps.exportPreview, { serviceId: id }, { cookie: a.cookie });
    expect(preview.body.blockers.map((b: { reason: string }) => b.reason)).toEqual(["protected"]);
    const refused = await callOp(a.panel, transferOps.exportService, { serviceId: id, secrets: "omitted" }, { cookie: a.cookie });
    expect([refused.status, refused.body.error.details.reason]).toEqual([409, "protected"]);
    a.panel.deps.db.update(services).set({ protected: false, parentId: id }).where(eq(services.id, id)).run();
    expect((await callOp(a.panel, transferOps.exportPreview, { serviceId: id }, { cookie: a.cookie })).body.blockers[0].reason).toBe(
      "compose",
    );
  });

  test("owners and admins only: a member with every action on the project is refused", async () => {
    const a = await side();
    const id = await makeApp(a);
    const member = await createUser(a.panel, "member");
    grant(a.panel, member.user.id, "project", a.projectId, ["*"]);
    const res = await callOp(a.panel, transferOps.exportPreview, { serviceId: id }, { cookie: member.cookie });
    expect(res.status).toBe(403);
    const begun = await callOp(a.panel, transferOps.importBegin, { projectId: a.projectId, manifest: "{}" }, { cookie: member.cookie });
    expect(begun.status).toBe(403);
  });

  test("a stale session must sign in again; a key narrowed to services.export leaves the env out", async () => {
    const a = await side();
    const id = await makeApp(a);
    a.panel.deps.db
      .update(sessions)
      .set({ reauthAt: null, createdAt: new Date(Date.now() - 3600_000) })
      .where(eq(sessions.userId, a.userId))
      .run();
    const stale = await callOp(a.panel, transferOps.exportService, { serviceId: id, secrets: "omitted" }, { cookie: a.cookie });
    expect([stale.status, stale.body.error.details.reason]).toEqual([403, "reauth"]);
    const key = createApiKey(a.panel, a.userId, { actions: ["services.export", "services.view"] });
    const preview = await callOp(a.panel, transferOps.exportPreview, { serviceId: id }, { bearer: key });
    expect(preview.status).toBe(200);
    expect(preview.body.includes.envKeys).toBe(0);
    expect(preview.body.leftOut.map((l: { what: string }) => l.what)).toContain("Environment variables and file mounts");
    // A key limited to another project cannot.
    const other = (await callOp(a.panel, projects.create, { name: "other" }, { cookie: a.cookie })).body.id as string;
    const limited = createApiKey(a.panel, a.userId, { projectIds: [other] });
    expect((await callOp(a.panel, transferOps.exportPreview, { serviceId: id }, { bearer: limited })).status).toBe(403);
  });
});

describe("import on another panel", () => {
  test("round trip: the env, file mounts, domains, schedules and alerts come along; ids and secrets are this panel's", async () => {
    const a = await side("node-a");
    const b = await side("node-b");
    const id = await makeApp(a);
    a.panel.deps.db.insert(notificationChannels).values({ name: "ops", kind: "webhook", configSealed: "x" }).run();
    b.panel.deps.db
      .insert(notificationChannels)
      .values({ name: "ops", kind: "webhook", configSealed: b.panel.deps.secrets.seal("{}", "notification.channel") })
      .run();
    const file = await exportZip(a, id);
    const begun = await begin(b, file.bytes);
    expect(begun.status).toBe(200);
    const preview = begun.body as transferOps.PortableManifestV1 & Record<string, any>;
    expect(preview.blockers).toEqual([]);
    expect(preview.file.samePanel).toBe(false);
    expect(preview.service.name).toBe("web");
    expect(preview.choices.nodeId).toBe(b.nodeId);
    expect(preview.choices.cronJobs).toBe("asInFile");
    // Channels from another panel are skipped unless mapped by choice.
    expect(preview.choices.alerts).toBe("skip");
    expect(preview.domains.find((d: { host: string }) => d.host === "shop.example.org")).toMatchObject({
      status: "free",
      action: "add",
      primary: true,
    });
    expect(preview.domains.find((d: { status: string }) => d.status === "auto")?.action).toBe("skip");
    expect(preview.env.shared).toEqual([{ name: "SENTRY_DSN", state: "missing" }]);
    const chosen = await callOp(
      b.panel,
      transferOps.setChoices,
      { projectId: b.projectId, importId: preview.importId, choices: { alerts: "mapByName", autoDomain: true, deployWhenReady: false } },
      { cookie: b.cookie },
    );
    expect(chosen.status).toBe(200);
    const done = await callOp(
      b.panel,
      transferOps.importService,
      { projectId: b.projectId, importId: preview.importId },
      { cookie: b.cookie },
    );
    expect(done.status).toBe(200);
    expect(done.body.pending).toEqual([]);
    expect(done.body.deployTrigger.url).toContain("/api/hooks/deploy/");
    const newId = done.body.service.id as string;
    expect(newId).not.toBe(id);
    const db = b.panel.deps.db;
    const row = db.select().from(services).where(eq(services.id, newId)).get();
    expect(row?.stopped).toBe(true);
    expect(row?.targetDeploymentId).toBeNull();
    expect(readServiceEnv(db, b.panel.deps.secrets, newId).text).toBe(readServiceEnv(a.panel.deps.db, a.panel.deps.secrets, id).text);
    expect(readProjectEnv(db, b.panel.deps.secrets, b.projectId).text).toContain("SENTRY_DSN=https://key@sentry.example/1");
    const file1 = db
      .select()
      .from(volumes)
      .where(and(eq(volumes.serviceId, newId), eq(volumes.kind, "file")))
      .get();
    expect(b.panel.deps.secrets.open(file1?.contentSealed as string, "volume.file")).toBe(`# ${secretValue}\n`);
    expect(
      db
        .select()
        .from(volumes)
        .where(and(eq(volumes.serviceId, newId), eq(volumes.kind, "volume")))
        .all()
        .map((v) => v.name),
    ).toEqual(["uploads"]);
    const doms = db.select().from(domains).where(eq(domains.serviceId, newId)).all();
    const custom = doms.find((d) => d.host === "shop.example.org");
    expect(custom?.isPrimary).toBe(true);
    expect(custom?.middlewares).toEqual({
      basicAuth: { users: [{ username: "admin", hash: `$2y$10$${"a".repeat(53)}` }] },
      ipAllowList: ["10.0.0.0/8"],
      redirects: [{ from: "^http://old/(.*)", to: "https://shop.example.org/$1", permanent: true }],
    });
    expect(doms.find((d) => d.auto)?.host).toBe("web.node-b.example.com");
    expect(
      db
        .select()
        .from(cronJobs)
        .where(eq(cronJobs.serviceId, newId))
        .all()
        .map((j) => [j.name, j.enabled]),
    ).toEqual([["cleanup", true]]);
    expect(db.select().from(uptimeChecks).where(eq(uptimeChecks.serviceId, newId)).all().length).toBe(1);
    expect(db.select().from(maintenancePages).where(eq(maintenancePages.serviceId, newId)).get()?.message).toBe("Back soon");
    expect(
      db
        .select()
        .from(alertRules)
        .where(eq(alertRules.scopeId, newId))
        .all()
        .map((r) => r.event),
    ).toEqual(["deploy_failed"]);
    const trigger = db.select().from(deployTriggers).where(eq(deployTriggers.serviceId, newId)).get();
    expect(trigger?.tokenHash).not.toBe(sha(id));
    const imp = db.select().from(serviceImports).where(eq(serviceImports.id, preview.importId)).get();
    expect([imp?.status, imp?.docSealed]).toEqual(["done", null]);
  });

  test("a wrong passphrase is FORBIDDEN; an edited manifest or secrets.enc is tampered", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a));
    const wrong = await begin(b, file.bytes, { passphrase: "not the passphrase" });
    expect([wrong.status, wrong.body.error.details.reason]).toEqual([403, "passphrase"]);
    const edited = await begin(b, file.bytes, { edit: (e) => (e.manifestText = e.manifestText.replace('"panel": {', '"panel": { ')) });
    expect([edited.status, edited.body.error.details.reason]).toEqual([400, "tampered"]);
    const noSig = await begin(b, file.bytes, { edit: (e) => (e.signature = undefined) });
    expect([noSig.status, noSig.body.error.details.reason]).toEqual([400, "tampered"]);
    const swapped = await begin(b, file.bytes, { edit: (e) => (e.secretsEnc = `${e.secretsEnc} `) });
    expect([swapped.status, swapped.body.error.details.reason]).toEqual([400, "tampered"]);
  });

  test("an edited service.json fails its manifest hash", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a), { secrets: "omitted", passphrase: undefined });
    const res = await begin(b, file.bytes, {
      edit: (e) =>
        ((e.services[0] as { json: string }).json = (e.services[0] as { json: string }).json.replace('"notes": ""', '"notes": "x"')),
    });
    expect([res.status, res.body.error.details.reason]).toEqual([400, "tampered"]);
  });

  test("refuses a newer format, unknown features, bad paths, duplicates and a mismatched secrets mode", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a), { secrets: "omitted", passphrase: undefined });
    const e = await entriesOf(file.bytes);
    const cases: [string, (m: any) => void, string][] = [
      ["newer", (m) => (m.formatVersion = 2), "newerFormat"],
      ["requires", (m) => (m.requires = ["volumes.encrypted"]), "requires"],
      ["slip", (m) => m.entries.push({ path: "../etc/passwd", size: 1, sha256: "0".repeat(64) }), "badPath"],
      ["absolute", (m) => m.entries.push({ path: "/services/web/service.json", size: 1, sha256: "0".repeat(64) }), "badPath"],
      ["unknown name", (m) => m.entries.push({ path: "services/web/run.sh", size: 1, sha256: "0".repeat(64) }), "badPath"],
      ["duplicate", (m) => m.entries.push({ ...m.entries[0] }), "duplicate"],
      ["secrets.enc while omitted", (m) => m.entries.push({ path: "secrets.enc", size: 1, sha256: "0".repeat(64) }), "badManifest"],
      ["other service", (m) => m.entries.push({ path: "services/db/service.json", size: 1, sha256: "0".repeat(64) }), "badPath"],
      ["not an export", (m) => (m.format = "something-else"), "notExport"],
    ];
    for (const [name, change, reason] of cases) {
      const manifest = JSON.parse(e.manifestText);
      change(manifest);
      const res = await callOp(
        b.panel,
        transferOps.importBegin,
        { projectId: b.projectId, manifest: JSON.stringify(manifest), services: e.services },
        { cookie: b.cookie },
      );
      expect(`${name}: ${res.status} ${res.body.error?.details?.reason}`).toBe(`${name}: 400 ${reason}`);
    }
  });

  test("a domain with a middleware this panel does not know is skipped, never imported weaker; unknown settings are listed", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a), { secrets: "omitted", passphrase: undefined });
    const e = await entriesOf(file.bytes);
    const doc = JSON.parse(e.services[0]?.json as string);
    doc.domains[0].middlewares.oauth = { provider: "x" };
    doc.futureSetting = true;
    const json = JSON.stringify(doc);
    const manifest = JSON.parse(e.manifestText);
    const entry = manifest.entries.find((x: { path: string }) => x.path.endsWith("service.json"));
    entry.size = Buffer.byteLength(json);
    entry.sha256 = sha(json);
    const res = await callOp(
      b.panel,
      transferOps.importBegin,
      { projectId: b.projectId, manifest: JSON.stringify(manifest), services: [{ path: entry.path, json }] },
      { cookie: b.cookie },
    );
    expect(res.status).toBe(200);
    expect(res.body.domains.some((d: { host: string }) => d.host === "shop.example.org")).toBe(false);
    expect(res.body.skipped.map((s: { what: string }) => s.what)).toContain("Domain shop.example.org");
    expect(res.body.file.unknownSettings).toContain("/futureSetting");
  });

  test("secret values left out: basic auth needs a new password, variables arrive empty", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a), { secrets: "omitted", passphrase: undefined });
    const begun = await begin(b, file.bytes);
    expect(begun.body.domains.find((d: { host: string }) => d.host === "shop.example.org").status).toBe("needsPassword");
    expect(begun.body.warnings.map((w: { reason: string }) => w.reason)).toEqual(
      expect.arrayContaining(["envEmpty", "fileMountsEmpty", "unsigned"]),
    );
    const ref = { projectId: b.projectId, importId: begun.body.importId };
    const refused = await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    expect([refused.status, refused.body.error.details.reason]).toEqual([400, "password"]);
    const ok = await callOp(
      b.panel,
      transferOps.importService,
      { ...ref, passwords: [{ host: "shop.example.org", pathPrefix: "/", username: "admin", password: "a new password" }] },
      { cookie: b.cookie },
    );
    expect(ok.status).toBe(200);
    const d = b.panel.deps.db
      .select()
      .from(domains)
      .where(and(eq(domains.serviceId, ok.body.service.id), eq(domains.host, "shop.example.org")))
      .get();
    const hash = d?.middlewares.basicAuth?.users[0]?.hash as string;
    expect(await Bun.password.verify("a new password", hash.replace(/^\$2y\$/, "$2b$"))).toBe(true);
    expect(readServiceEnv(b.panel.deps.db, b.panel.deps.secrets, ok.body.service.id).text).toBe("PLAIN=\nSECRET=\nSELF=\nOWN=\nSENTRY=");
    // The audit entry has neither the password nor the hash.
    const audit = b.panel.deps.db.select().from(auditLog).all();
    expect(JSON.stringify(audit).includes("a new password")).toBe(false);
  });
});

describe("import on the same panel", () => {
  test("names the copy <name>-2, skips domains in use, keeps schedules and backups off", async () => {
    const a = await side();
    const id = await makeApp(a);
    const file = await exportZip(a, id);
    const begun = await begin(a, file.bytes);
    expect(begun.status).toBe(200);
    expect(begun.body.file.samePanel).toBe(true);
    expect(begun.body.choices.name).toBe("web-2");
    expect(begun.body.choices.cronJobs).toBe("disabled");
    expect(begun.body.choices.uptimeChecks).toBe("disabled");
    expect(begun.body.domains.find((d: { host: string }) => d.host === "shop.example.org")).toMatchObject({
      status: "usedHere",
      action: "skip",
    });
    // The original name is taken: a blocker until another one is picked.
    const clash = await callOp(
      a.panel,
      transferOps.setChoices,
      { projectId: a.projectId, importId: begun.body.importId, choices: { name: "web" } },
      { cookie: a.cookie },
    );
    expect(clash.body.blockers.map((x: { reason: string }) => x.reason)).toContain("nameTaken");
    await callOp(
      a.panel,
      transferOps.setChoices,
      { projectId: a.projectId, importId: begun.body.importId, choices: { name: "web-2" } },
      { cookie: a.cookie },
    );
    const done = await callOp(
      a.panel,
      transferOps.importService,
      { projectId: a.projectId, importId: begun.body.importId },
      { cookie: a.cookie },
    );
    expect(done.status).toBe(200);
    const newId = done.body.service.id;
    // Its own name follows the rename.
    expect(readServiceEnv(a.panel.deps.db, a.panel.deps.secrets, newId).text).toContain("OWN=${{web-2.PLAIN}}");
    expect(a.panel.deps.db.select().from(cronJobs).where(eq(cronJobs.serviceId, newId)).get()?.enabled).toBe(false);
  });

  test("a failure inside the transaction leaves nothing behind", async () => {
    const a = await side();
    const db = a.panel.deps.db;
    const before = db.select().from(services).all().length;
    const domain = { host: "twice.example.org", pathPrefix: "/", targetPort: 80 };
    expect(() =>
      db.transaction((tx) =>
        materializeService({ db, access: { can: () => true }, secrets: a.panel.deps.secrets }, tx, {
          projectId: a.projectId,
          name: "half",
          kind: "app",
          nodeId: a.nodeId,
          replicas: 1,
          spec: defaultSpec(),
          templateSlug: null,
          notes: "",
          createdBy: null,
          volumes: [{ name: "data", mountPath: "/data", readOnly: false }],
          fileMounts: [{ name: "f", mountPath: "/f", readOnly: false, content: "x" }],
          env: "A=1",
          database: null,
          box: null,
          // The second insert of the same host and path fails after everything else was written.
          domains: [domain, domain],
          cronJobs: [{ name: "c", schedule: "0 3 * * *", command: "true" }],
        }),
      ),
    ).toThrow("already in use");
    expect(db.select().from(services).all().length).toBe(before);
    expect(db.select().from(volumes).where(eq(volumes.name, "f")).all()).toEqual([]);
    expect(db.select().from(cronJobs).all()).toEqual([]);
  });

  test("discardImport deletes the service while the import is not done", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a));
    const begun = await begin(b, file.bytes);
    const ref = { projectId: b.projectId, importId: begun.body.importId };
    expect((await callOp(b.panel, transferOps.discardImport, ref, { cookie: b.cookie })).body).toEqual({ deletedService: false });
    expect(b.panel.deps.db.select().from(serviceImports).all()).toEqual([]);
  });
});

describe("shared variables from the file", () => {
  test("only one KEY=value line of that variable, without references, is taken; anything else is left out", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a));
    const real = "DATABASE_URL=postgres://real/db\n";
    expect((await callOp(b.panel, env.setShared, { projectId: b.projectId, text: real }, { cookie: b.cookie })).status).toBe(200);
    const crafted = await craft(file.bytes, b.projectId, (plain) => {
      const web = plain.services.web;
      web.doc.env.shared = ["MULTI", "REF", "COMMENT", "OTHER", "QUOTED", "SENTRY_DSN"];
      web.shared = {
        // Shown as one variable, but a second line would override the project's DATABASE_URL.
        MULTI: "MULTI=1\nDATABASE_URL=postgres://attacker/db",
        REF: "REF=${{web.SECRET}}",
        COMMENT: "COMMENT=1 # DATABASE_URL",
        OTHER: "SOMETHING_ELSE=1",
        QUOTED: 'QUOTED="one\ntwo"',
        SENTRY_DSN: "SENTRY_DSN=https://key@sentry.example/1",
      };
    });
    const begun = await callOp(b.panel, transferOps.importBegin, crafted, { cookie: b.cookie });
    expect(begun.status).toBe(200);
    expect(begun.body.env.shared).toEqual([
      { name: "MULTI", state: "noValue" },
      { name: "REF", state: "noValue" },
      { name: "COMMENT", state: "noValue" },
      { name: "OTHER", state: "noValue" },
      { name: "QUOTED", state: "missing" },
      { name: "SENTRY_DSN", state: "missing" },
    ]);
    const warning = begun.body.warnings.find((w: { reason: string }) => w.reason === "sharedRefused");
    expect(warning?.message).toContain("MULTI, REF, COMMENT, OTHER");
    expect(JSON.stringify(begun.body).includes("attacker")).toBe(false);
    // Overwrite takes only what was shown, too.
    await callOp(
      b.panel,
      transferOps.setChoices,
      { projectId: b.projectId, importId: begun.body.importId, choices: { sharedVariables: "overwrite" } },
      { cookie: b.cookie },
    );
    const done = await callOp(
      b.panel,
      transferOps.importService,
      { projectId: b.projectId, importId: begun.body.importId },
      { cookie: b.cookie },
    );
    expect(done.status).toBe(200);
    expect(readProjectEnv(b.panel.deps.db, b.panel.deps.secrets, b.projectId).text).toBe(
      `${real}QUOTED="one\ntwo"\nSENTRY_DSN=https://key@sentry.example/1\n`,
    );
  });

  test("they are merged into the text stored when the import writes, so a save in between stays", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a));
    const db = b.panel.deps.db;
    writeProjectEnv(db, b.panel.deps.secrets, b.projectId, "KEEP=1\n", null);
    const begun = await begin(b, file.bytes);
    let saved = false;
    // Someone saves the shared variables while the import checks its uptime targets: after its plan, before its transaction.
    setTargetResolver(async () => {
      if (!saved) writeProjectEnv(db, b.panel.deps.secrets, b.projectId, "KEEP=1\nEDITED=2\n", null);
      saved = true;
      return ["93.184.216.34"];
    });
    try {
      const done = await callOp(
        b.panel,
        transferOps.importService,
        { projectId: b.projectId, importId: begun.body.importId },
        { cookie: b.cookie },
      );
      expect(done.status).toBe(200);
    } finally {
      setTargetResolver(null);
    }
    expect(saved).toBe(true);
    expect(readProjectEnv(db, b.panel.deps.secrets, b.projectId).text).toBe("KEEP=1\nEDITED=2\nSENTRY_DSN=https://key@sentry.example/1\n");
  });

  test("mergeSharedLines adds, overwrites only when asked, and keeps what appeared since the preview", () => {
    const add = { key: "B", line: "B=2", overwrite: false };
    expect(mergeSharedLines("A=1\n", [add])).toBe("A=1\nB=2\n");
    expect(mergeSharedLines("", [add])).toBe("B=2\n");
    // B was added by someone else since the preview: theirs stays.
    expect(mergeSharedLines("A=1\nB=mine\n", [add])).toBeNull();
    expect(mergeSharedLines('A=1\nexport B="old"\nC=3\n', [{ key: "B", line: "B=new", overwrite: true }])).toBe("A=1\nB=new\nC=3\n");
    expect(() => mergeSharedLines("A=1\n", [{ key: "B", line: `B=${"x".repeat(262_144)}`, overwrite: false }])).toThrow("256 KiB");
  });
});

describe("upload apps: the archive goes up in parts", () => {
  async function uploadApp(s: Side) {
    const id = (
      await callOp(
        s.panel,
        serviceOps.create,
        {
          projectId: s.projectId,
          name: "site",
          kind: "app",
          nodeId: s.nodeId,
          source: { type: "upload", fileName: null },
          ports: [{ containerPort: 80, protocol: "tcp" }],
        },
        { cookie: s.cookie },
      )
    ).body.id as string;
    const archive = gzipSync(Buffer.alloc(300_000, 7));
    await mkdir(join(s.dataDir, "uploads"), { recursive: true });
    const row = s.panel.deps.db
      .insert(sourceUploads)
      .values({ serviceId: id, fileName: "site.tar.gz", sizeBytes: archive.length, sha256: sha(archive) })
      .returning()
      .get();
    writeFileSync(join(s.dataDir, "uploads", `${row.id}.tar.gz`), archive);
    s.panel.deps.db
      .update(services)
      .set({
        spec: {
          ...(s.panel.deps.db.select().from(services).where(eq(services.id, id)).get()?.spec as object),
          source: { type: "upload", fileName: "site.tar.gz" },
        },
      })
      .where(eq(services.id, id))
      .run();
    return { id, archive };
  }

  async function put(
    s: Side,
    ref: { projectId: string; importId: string },
    entry: string,
    offset: number,
    body: Uint8Array,
    length = body.length,
  ) {
    const ticket = await callOp(s.panel, transferOps.uploadTicket, { ...ref, entry, offset }, { cookie: s.cookie });
    expect(ticket.status).toBe(200);
    const response = await s.panel.app.handle(
      new Request(`http://panel.test${ticket.body.url}`, {
        method: "PUT",
        headers: { host: "panel.test", "content-length": String(length) },
        body,
      }),
    );
    return { status: response.status, body: (await response.json()) as any };
  }

  test("the archive is in the export, goes up in two parts, is checked, and the service deploys", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id, archive } = await uploadApp(a);
    const file = await exportZip(a, id);
    const e = await entriesOf(file.bytes);
    const entry = e.opened.entries.find((x) => x.name === "services/site/source/upload.tar.gz");
    expect(entry?.method).toBe("store");
    expect(file.bytes.subarray(entry?.dataOffset, (entry?.dataOffset ?? 0) + archive.length)).toEqual(new Uint8Array(archive));
    const begun = await begin(b, file.bytes);
    expect(begun.body.data.upload).toEqual({ fileName: "site.tar.gz", sizeBytes: archive.length });
    const ref = { projectId: b.projectId, importId: begun.body.importId };
    await callOp(b.panel, transferOps.setChoices, { ...ref, choices: { deployWhenReady: true } }, { cookie: b.cookie });
    const made = await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    expect(made.body.pending).toEqual([{ entry: "services/site/source/upload.tar.gz", sizeBytes: archive.length }]);
    const serviceId = made.body.service.id as string;
    // Deploys wait for the archive.
    const early = await callOp(b.panel, deploymentOps.deploy, { serviceId }, { cookie: b.cookie });
    expect([early.status, early.body.error.details.reason]).toEqual([409, "importing"]);
    const bytes = new Uint8Array(archive);
    const half = Math.floor(bytes.length / 2);
    const first = await put(b, ref, "services/site/source/upload.tar.gz", 0, bytes.subarray(0, half));
    expect(first).toEqual({ status: 200, body: { received: half, done: false } });
    const state = await callOp(b.panel, transferOps.getImport, ref, { cookie: b.cookie });
    expect(state.body.entries[0].received).toBe(half);
    const second = await put(b, ref, "services/site/source/upload.tar.gz", half, bytes.subarray(half));
    expect(second.body).toEqual({ received: bytes.length, done: true });
    const imp = b.panel.deps.db.select().from(serviceImports).where(eq(serviceImports.id, ref.importId)).get();
    expect(imp?.status).toBe("done");
    expect(b.panel.deps.db.select().from(sourceUploads).where(eq(sourceUploads.serviceId, serviceId)).get()?.sha256).toBe(sha(archive));
    const deps = await callOp(b.panel, deploymentOps.list, { serviceId }, { cookie: b.cookie });
    expect(deps.body.deployments.length).toBe(1);
  });

  test("lengths and hashes that do not match the manifest are refused", async () => {
    const a = await side();
    const b = await side("node-b");
    const { id, archive } = await uploadApp(a);
    const begun = await begin(b, (await exportZip(a, id)).bytes);
    const ref = { projectId: b.projectId, importId: begun.body.importId };
    await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    const name = "services/site/source/upload.tar.gz";
    const ticket = await callOp(b.panel, transferOps.uploadTicket, { ...ref, entry: name, offset: 0 }, { cookie: b.cookie });
    const noLength = await b.panel.app.handle(
      new Request(`http://panel.test${ticket.body.url}`, {
        method: "PUT",
        headers: { host: "panel.test" },
        body: new ReadableStream({ start: (c) => c.close() }),
      }),
    );
    expect(noLength.status).toBe(411);
    expect((await put(b, ref, name, 0, new Uint8Array(archive.length + 1))).status).toBe(413);
    // One flipped byte: the whole archive fails its sha256 and nothing is kept.
    const flipped = new Uint8Array(archive);
    flipped[100] = (flipped[100] ?? 0) ^ 1;
    const bad = await put(b, ref, name, 0, flipped);
    expect([bad.status, bad.body.error.details.reason]).toEqual([400, "sha256"]);
    const state = await callOp(b.panel, transferOps.getImport, ref, { cookie: b.cookie });
    expect(state.body.entries[0]).toMatchObject({ status: "failed", received: 0 });
    expect(
      b.panel.deps.db
        .select()
        .from(sourceUploads)
        .all()
        .filter((u) => u.serviceId !== id),
    ).toEqual([]);
    // Discarding now deletes the service it created.
    expect((await callOp(b.panel, transferOps.discardImport, ref, { cookie: b.cookie })).body).toEqual({ deletedService: true });
  });
});

describe("secrets never reach logs or the audit log", () => {
  test("passphrase, values and documents stay out, also when a document is refused", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a));
    await begin(b, file.bytes, { passphrase: "wrong passphrase here" });
    const ok = await begin(b, file.bytes);
    await callOp(b.panel, transferOps.importService, { projectId: b.projectId, importId: ok.body.importId }, { cookie: b.cookie });
    // A refused document with a marker in it.
    const omitted = await exportZip(a, await makeApp(a, "api"), { secrets: "omitted", passphrase: undefined });
    const e = await entriesOf(omitted.bytes);
    const doc = JSON.parse(e.services[0]?.json as string);
    doc.notes = 42;
    doc.spec.container.command = [secretValue];
    const json = JSON.stringify(doc);
    const manifest = JSON.parse(e.manifestText);
    const entry = manifest.entries.find((x: { path: string }) => x.path.endsWith("service.json"));
    Object.assign(entry, { size: Buffer.byteLength(json), sha256: sha(json) });
    const refused = await callOp(
      b.panel,
      transferOps.importBegin,
      { projectId: b.projectId, manifest: JSON.stringify(manifest), services: [{ path: entry.path, json }] },
      { cookie: b.cookie },
    );
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body).includes(secretValue)).toBe(false);
    for (const s of [a, b]) {
      const audit = JSON.stringify(s.panel.deps.db.select().from(auditLog).all());
      const logs = s.logs.join("\n");
      for (const needle of [secretValue, passphrase, "wrong passphrase here", "SENTRY_DSN=https"]) {
        expect(`audit has ${needle}: ${audit.includes(needle)}`).toBe(`audit has ${needle}: false`);
        expect(`logs have ${needle}: ${logs.includes(needle)}`).toBe(`logs have ${needle}: false`);
      }
    }
    expect(
      a.panel.deps.db
        .select()
        .from(auditLog)
        .all()
        .some((r) => r.opId === "serviceTransfer.exportFinished"),
    ).toBe(true);
  });
});

describe("the KDF is bounded before it runs", () => {
  test("a file asking for gigabytes of scrypt is refused as tampered", async () => {
    const a = await side();
    const b = await side("node-b");
    const file = await exportZip(a, await makeApp(a));
    const e = await entriesOf(file.bytes);
    const envelope = JSON.parse(e.secretsEnc as string);
    envelope.kdf.N = 2 ** 22;
    const secretsEnc = JSON.stringify(envelope);
    const manifest = JSON.parse(e.manifestText);
    Object.assign(
      manifest.entries.find((x: { path: string }) => x.path === "secrets.enc"),
      { size: Buffer.byteLength(secretsEnc), sha256: sha(secretsEnc) },
    );
    const saved = { ...scryptLimits };
    const res = await callOp(
      b.panel,
      transferOps.importBegin,
      { projectId: b.projectId, manifest: JSON.stringify(manifest), signature: e.signature, secretsEnc, passphrase },
      { cookie: b.cookie },
    );
    Object.assign(scryptLimits, saved);
    expect([res.status, res.body.error.details.reason]).toEqual([400, "tampered"]);
  });
});
