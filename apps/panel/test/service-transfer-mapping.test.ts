import { afterEach, describe, expect, test } from "bun:test";
import { databases as dbOps, services as serviceOps, serviceTransfer as transferOps } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import {
  backupDestinations,
  backupPolicies,
  gitCredentials,
  githubApps,
  githubInstallations,
  portExposures,
  registryCredentials,
  serviceDatabases,
  serviceSecrets,
  services,
  volumes,
} from "../src/db/schema";
import { engineVersion } from "../src/modules/databases/engines";
import { adminPasswordSecret } from "../src/modules/databases/info";
import { readSpec } from "../src/modules/services/spec";
import { callOp, createApiKey, createUser } from "./helpers";
import { begin, closeSides, entriesOf, exportZip, type Side, sha, side } from "./transfer-helpers";

afterEach(closeSides);

function installation(s: Side, account: string) {
  const app = s.panel.deps.db
    .insert(githubApps)
    .values({
      appId: 42,
      slug: "test",
      name: "test",
      htmlUrl: "https://github.com/apps/test",
      ownerLogin: account,
      clientId: "Iv1.test",
      clientSecretSealed: s.panel.deps.secrets.seal("cs", "github.app"),
      privateKeySealed: s.panel.deps.secrets.seal("pk", "github.app"),
      webhookSecretSealed: s.panel.deps.secrets.seal("wh", "github.app"),
    })
    .returning()
    .get();
  return s.panel.deps.db
    .insert(githubInstallations)
    .values({ githubAppId: app.id, installationId: Math.floor(Math.random() * 1e6), accountLogin: account, accountType: "Organization" })
    .returning()
    .get().id;
}

async function app(s: Side, name: string, source: Record<string, unknown>) {
  const id = (
    await callOp(
      s.panel,
      serviceOps.create,
      {
        projectId: s.projectId,
        name,
        kind: "app",
        nodeId: s.nodeId,
        source: { type: "image", image: "nginx:1.27", registryId: null },
        ports: [{ containerPort: 80, protocol: "tcp" }],
      },
      { cookie: s.cookie },
    )
  ).body.id as string;
  const row = s.panel.deps.db.select().from(services).where(eq(services.id, id)).get();
  s.panel.deps.db
    .update(services)
    .set({ spec: { ...readSpec(row?.spec), source } })
    .where(eq(services.id, id))
    .run();
  return id;
}

describe("what reads the source", () => {
  test("a GitHub App installation of the same account is picked; without one the owner picks or imports without", async () => {
    const a = await side();
    const b = await side("node-b");
    const c = await side("node-c");
    const id = await app(a, "web", {
      type: "github",
      installationId: installation(a, "acme"),
      accountId: null,
      repo: "acme/web",
      branch: "main",
      deployOnPush: true,
    });
    const file = await exportZip(a, id);
    const onB = installation(b, "acme");
    const mapped = await begin(b, file.bytes);
    expect(mapped.body.source.access.picked).toMatchObject({ kind: "githubInstallation", id: onB });
    expect(mapped.body.choices.deployOnPush).toBe(false);
    const done = await callOp(
      b.panel,
      transferOps.importService,
      { projectId: b.projectId, importId: mapped.body.importId },
      { cookie: b.cookie },
    );
    expect(done.body.service.sourceConfig).toEqual({
      type: "github",
      installationId: onB,
      accountId: null,
      repo: "acme/web",
      branch: "main",
      deployOnPush: false,
    });

    const unmapped = await begin(c, file.bytes);
    expect(unmapped.body.needs.map((n: { field: string }) => n.field)).toEqual(["sourceAccess"]);
    const ref = { projectId: c.projectId, importId: unmapped.body.importId };
    const refused = await callOp(c.panel, transferOps.importService, ref, { cookie: c.cookie });
    expect([refused.status, refused.body.error.details.reason]).toEqual([409, "needs"]);
    await callOp(c.panel, transferOps.setChoices, { ...ref, choices: { sourceAccess: { kind: "none" } } }, { cookie: c.cookie });
    const without = await callOp(c.panel, transferOps.importService, ref, { cookie: c.cookie });
    expect(without.body.service.sourceConfig).toEqual({ type: "none" });
    expect(without.body.skipped.map((s: { what: string }) => s.what)).toContain("The repository source");
  });

  test("a git credential is matched by host and user, or made from the file when it was included", async () => {
    const a = await side();
    const b = await side("node-b");
    const c = await side("node-c");
    const cred = a.panel.deps.db
      .insert(gitCredentials)
      .values({
        name: "bot",
        kind: "token",
        host: "git.example.com",
        username: "bot",
        secretSealed: a.panel.deps.secrets.seal("tok-123456", "git.credential"),
      })
      .returning()
      .get();
    const id = await app(a, "web", {
      type: "git",
      url: "https://git.example.com/team/web.git",
      branch: "main",
      credentialId: cred.id,
      deployOnPush: false,
    });
    const plainFile = await exportZip(a, id);
    const onB = b.panel.deps.db
      .insert(gitCredentials)
      .values({
        name: "other name",
        kind: "token",
        host: "git.example.com",
        username: "bot",
        secretSealed: b.panel.deps.secrets.seal("x", "git.credential"),
      })
      .returning()
      .get();
    expect((await begin(b, plainFile.bytes)).body.source.access.picked).toMatchObject({ kind: "gitCredential", id: onB.id });

    // Not included: nothing to make it from on a panel without one.
    const none = await begin(c, plainFile.bytes);
    expect(none.body.source.access.options.map((o: { kind: string }) => o.kind)).toEqual(["none"]);
    expect(none.body.needs.map((n: { field: string }) => n.field)).toEqual(["sourceAccess"]);
    const withLogin = await exportZip(a, id, { includeSourceLogin: true });
    const made = await begin(c, withLogin.bytes);
    expect(made.body.source.access.picked.kind).toBe("createFromFile");
    const done = await callOp(
      c.panel,
      transferOps.importService,
      { projectId: c.projectId, importId: made.body.importId },
      { cookie: c.cookie },
    );
    expect(done.status).toBe(200);
    const created = c.panel.deps.db.select().from(gitCredentials).get();
    expect([created?.host, created?.username, c.panel.deps.secrets.open(created?.secretSealed as string, "git.credential")]).toEqual([
      "git.example.com",
      "bot",
      "tok-123456",
    ]);
    expect(done.body.service.sourceConfig.credentialId).toBe(created?.id);
  });

  test("a registry login is only included in an encrypted file, and only with registries.manage", async () => {
    const a = await side();
    const reg = a.panel.deps.db
      .insert(registryCredentials)
      .values({
        name: "ghcr",
        server: "ghcr.io",
        username: "acme",
        passwordSealed: a.panel.deps.secrets.seal("pw-123456", "registry.credential"),
      })
      .returning()
      .get();
    const id = await app(a, "web", { type: "image", image: "ghcr.io/acme/web:1", registryId: reg.id });
    const preview = await callOp(a.panel, transferOps.exportPreview, { serviceId: id }, { cookie: a.cookie });
    expect(preview.body.sourceLogin).toEqual({ kind: "registry", name: "ghcr" });
    const omitted = await callOp(
      a.panel,
      transferOps.exportService,
      { serviceId: id, secrets: "omitted", includeSourceLogin: true },
      { cookie: a.cookie },
    );
    expect(omitted.status).toBe(400);
    const admin = await createUser(a.panel, "admin");
    // Admins hold registries.manage too; a key narrowed without it does not.
    const input = { serviceId: id, secrets: "encrypted" as const, passphrase: "correct horse battery staple", includeSourceLogin: true };
    expect((await callOp(a.panel, transferOps.exportService, input, { cookie: admin.cookie })).status).toBe(200);
    const key = createApiKey(a.panel, admin.user.id, { actions: ["services.export", "services.view", "env.view"] });
    const narrowed = await callOp(a.panel, transferOps.exportService, input, { bearer: key });
    expect([narrowed.status, narrowed.body.error.details.action]).toEqual([403, "registries.manage"]);
  });
});

describe("databases", () => {
  test("what runs is built from the engine, never taken from the file; listeners open to anyone stay closed", async () => {
    const a = await side();
    const b = await side("node-b");
    const created = await callOp(
      a.panel,
      dbOps.create,
      { projectId: a.projectId, name: "pg", engine: "postgres", nodeId: a.nodeId },
      { cookie: a.cookie },
    );
    expect(created.status).toBe(200);
    const id = created.body.serviceId ?? created.body.service?.id ?? created.body.id;
    const svcId = (a.panel.deps.db.select().from(services).where(eq(services.name, "pg")).get()?.id ?? id) as string;
    a.panel.deps.db
      .insert(portExposures)
      .values({ serviceId: svcId, nodeId: a.nodeId, kind: "database", listenPort: 15432, targetPort: 5432, allowedCidrs: [] })
      .run();
    const file = await exportZip(a, svcId, { secrets: "omitted", passphrase: undefined });
    const e = await entriesOf(file.bytes);
    const doc = JSON.parse(e.services[0]?.json as string);
    // A crafted file: another image and command for a database kind.
    doc.spec.source = { type: "image", image: "evil/image:1" };
    doc.spec.container.command = ["sh", "-c", "curl evil"];
    const json = JSON.stringify(doc);
    const manifest = JSON.parse(e.manifestText);
    Object.assign(
      manifest.entries.find((x: { path: string }) => x.path.endsWith("service.json")),
      { size: Buffer.byteLength(json), sha256: sha(json) },
    );
    const begun = await callOp(
      b.panel,
      transferOps.importBegin,
      { projectId: b.projectId, manifest: JSON.stringify(manifest), services: [{ path: `services/pg/service.json`, json }] },
      { cookie: b.cookie },
    );
    expect(begun.status).toBe(200);
    expect(begun.body.extras.exposures).toEqual([{ listenPort: 15432, allowedCidrs: [], clash: false, action: "skip" }]);
    const done = await callOp(
      b.panel,
      transferOps.importService,
      { projectId: b.projectId, importId: begun.body.importId },
      { cookie: b.cookie },
    );
    expect(done.status).toBe(200);
    const row = b.panel.deps.db.select().from(services).where(eq(services.id, done.body.service.id)).get();
    const spec = readSpec(row?.spec);
    const version = engineVersion("postgres", doc.database.version);
    expect(spec.source).toEqual({ type: "image", image: version?.image as string, registryId: null });
    expect(spec.container.command.join(" ")).not.toContain("evil");
    expect(
      b.panel.deps.db
        .select()
        .from(volumes)
        .where(eq(volumes.serviceId, row?.id as string))
        .all()
        .map((v) => [v.name, v.mountPath]),
    ).toEqual([["data", version?.dataPath as string]]);
    expect(
      b.panel.deps.db
        .select()
        .from(serviceDatabases)
        .where(eq(serviceDatabases.serviceId, row?.id as string))
        .get()?.engine,
    ).toBe("postgres");
    // Logins were left out of the file: new ones.
    const pw = b.panel.deps.db
      .select()
      .from(serviceSecrets)
      .where(and(eq(serviceSecrets.serviceId, row?.id as string), eq(serviceSecrets.name, adminPasswordSecret)))
      .get();
    expect(pw).toBeDefined();
    expect(
      b.panel.deps.db
        .select()
        .from(portExposures)
        .where(eq(portExposures.serviceId, row?.id as string))
        .all(),
    ).toEqual([]);
  });

  test("a version this panel does not offer blocks the import", async () => {
    const a = await side();
    const b = await side("node-b");
    await callOp(a.panel, dbOps.create, { projectId: a.projectId, name: "pg", engine: "postgres", nodeId: a.nodeId }, { cookie: a.cookie });
    const svcId = a.panel.deps.db.select().from(services).where(eq(services.name, "pg")).get()?.id as string;
    a.panel.deps.db.update(serviceDatabases).set({ version: "9" }).where(eq(serviceDatabases.serviceId, svcId)).run();
    const begun = await begin(b, (await exportZip(a, svcId)).bytes);
    expect(begun.body.blockers.map((x: { reason: string }) => x.reason)).toEqual(["engineVersion"]);
  });
});

describe("backups", () => {
  test("a destination of the same name is mapped when asked; another panel's are skipped by default", async () => {
    const a = await side();
    const b = await side("node-b");
    const dest = (s: Side) =>
      s.panel.deps.db
        .insert(backupDestinations)
        .values({
          name: "s3-main",
          provider: "s3",
          endpoint: "https://s3.example.com",
          bucket: "bk",
          accessKeyId: "AK",
          secretAccessKeySealed: s.panel.deps.secrets.seal("SK", "backup.destination"),
        })
        .returning()
        .get().id;
    const id = await app(a, "web", { type: "image", image: "nginx:1.27", registryId: null });
    await callOp(
      a.panel,
      serviceOps.setVolumes,
      { serviceId: id, volumes: [{ name: "files", mountPath: "/files" }] },
      { cookie: a.cookie },
    );
    const volumeId = a.panel.deps.db.select().from(volumes).where(eq(volumes.serviceId, id)).get()?.id as string;
    a.panel.deps.db
      .insert(backupPolicies)
      .values({ serviceId: id, destinationId: dest(a), target: "volume", volumeId, schedule: "0 4 * * *" })
      .run();
    const onB = dest(b);
    const begun = await begin(b, (await exportZip(a, id)).bytes);
    expect(begun.body.choices.backups).toBe("skip");
    expect(begun.body.extras.backups).toEqual([{ target: "volume", volume: "files", destination: "s3-main", mapped: true }]);
    const ref = { projectId: b.projectId, importId: begun.body.importId };
    await callOp(b.panel, transferOps.setChoices, { ...ref, choices: { backups: "mapByName" } }, { cookie: b.cookie });
    const done = await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    const policy = b.panel.deps.db.select().from(backupPolicies).where(eq(backupPolicies.serviceId, done.body.service.id)).get();
    const newVolume = b.panel.deps.db.select().from(volumes).where(eq(volumes.serviceId, done.body.service.id)).get();
    expect([policy?.destinationId, policy?.volumeId, policy?.enabled]).toEqual([onB, newVolume?.id, true]);
  });
});
