import { afterEach, describe, expect, test } from "bun:test";
import { databases as dbOps, services as serviceOps, serviceTransfer as transferOps } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import {
  backupDestinations,
  backupPolicies,
  type DatabaseEngine,
  gitCredentials,
  githubApps,
  githubInstallations,
  gitInternalHosts,
  portExposures,
  registryCredentials,
  serviceDatabases,
  serviceSecrets,
  services,
  volumes,
} from "../src/db/schema";
import { type EngineVersion, engineVersion, exposureCapability } from "../src/modules/databases/engines";
import { adminPasswordSecret, retiredExposedPasswordSecret } from "../src/modules/databases/info";
import { generateDeployKey } from "../src/modules/git/remote";
import { readSpec } from "../src/modules/services/spec";
import { importedDatabaseImage } from "../src/modules/serviceTransfer/plan";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { callOp, createApiKey, createUser } from "./helpers";
import { begin, closeSides, craft, entriesOf, exportZip, type Side, sha, side } from "./transfer-helpers";

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

  test("a credential made from the file goes through git.createCredential's checks; the key gives its fingerprint", async () => {
    const a = await side();
    const c = await side("node-c");
    const key = generateDeployKey("deploy");
    const knownHosts = "git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    const cred = a.panel.deps.db
      .insert(gitCredentials)
      .values({
        name: "deploy",
        kind: "ssh_key",
        host: "git.example.com",
        secretSealed: a.panel.deps.secrets.seal(key.privateKey, "git.credential"),
        knownHosts,
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
      })
      .returning()
      .get();
    const id = await app(a, "web", {
      type: "git",
      url: "ssh://git@git.example.com/team/web.git",
      branch: "main",
      credentialId: cred.id,
      deployOnPush: false,
    });
    const file = await exportZip(a, id, { includeSourceLogin: true });
    const made = () => c.panel.deps.db.select().from(gitCredentials).all();

    // Refused before anything is made: known_hosts for another host, a key that cannot be read, a host that is no host.
    const refusals: [(p: any) => void, string][] = [
      [
        (p) => (p.services.web.sourceCredential.knownHosts = "evil.example ssh-ed25519 AAAAC3Nza"),
        "None of these lines are for git.example.com",
      ],
      [
        (p) =>
          (p.services.web.sourceCredential.secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a key\n-----END OPENSSH PRIVATE KEY-----\n"),
        "This private key cannot be read",
      ],
      [(p) => (p.services.web.doc.sourceAccess.host = "git.example.com/../../x"), "does not pass this panel's checks"],
    ];
    for (const [edit, text] of refusals) {
      const begun = await callOp(c.panel, transferOps.importBegin, await craft(file.bytes, c.projectId, edit), { cookie: c.cookie });
      expect(begun.status).toBe(200);
      expect(begun.body.blockers.find((x: { reason: string }) => x.reason === "sourceAccess")?.message).toContain(text);
      const refused = await callOp(
        c.panel,
        transferOps.importService,
        { projectId: c.projectId, importId: begun.body.importId },
        { cookie: c.cookie },
      );
      expect(refused.status).toBe(409);
      expect(made()).toEqual([]);
    }

    // Another key's public key and fingerprint, the host in capitals: what is stored comes from the key itself.
    const other = generateDeployKey("other");
    const forged = await craft(file.bytes, c.projectId, (p) => {
      p.services.web.doc.sourceAccess.fingerprint = other.fingerprint;
      p.services.web.doc.sourceAccess.host = "GIT.Example.com";
      p.services.web.sourceCredential.publicKey = other.publicKey;
    });
    const begun = await callOp(c.panel, transferOps.importBegin, forged, { cookie: c.cookie });
    expect(begun.body.source.access.picked.kind).toBe("createFromFile");
    const done = await callOp(
      c.panel,
      transferOps.importService,
      { projectId: c.projectId, importId: begun.body.importId },
      { cookie: c.cookie },
    );
    expect(done.status).toBe(200);
    const [row] = made();
    expect([row?.host, row?.fingerprint, row?.publicKey?.split(" ").slice(0, 2), row?.origin, row?.username]).toEqual([
      "git.example.com",
      key.fingerprint,
      key.publicKey.split(" ").slice(0, 2),
      "manual",
      null,
    ]);
    expect(c.panel.deps.secrets.open(row?.secretSealed as string, "git.credential")).toBe(`${key.privateKey.trim()}\n`);
    expect(row?.knownHosts).toBe(knownHosts);
  });

  test("an admin's import with a credential from the file records an internal git host, as saving the source does", async () => {
    setTargetResolver(async (host) => {
      if (host === "gitea.lan") return ["10.1.2.3"];
      throw Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" });
    });
    try {
      const a = await side();
      const c = await side("node-c");
      const cred = a.panel.deps.db
        .insert(gitCredentials)
        .values({
          name: "bot",
          kind: "token",
          host: "gitea.lan",
          username: "bot",
          secretSealed: a.panel.deps.secrets.seal("tok-123456", "git.credential"),
        })
        .returning()
        .get();
      const id = await app(a, "web", {
        type: "git",
        url: "https://gitea.lan/team/web.git",
        branch: "main",
        credentialId: cred.id,
        deployOnPush: false,
      });
      const begun = await begin(c, (await exportZip(a, id, { includeSourceLogin: true })).bytes);
      expect(begun.body.source.access.picked.kind).toBe("createFromFile");
      const done = await callOp(
        c.panel,
        transferOps.importService,
        { projectId: c.projectId, importId: begun.body.importId },
        { cookie: c.cookie },
      );
      expect(done.status).toBe(200);
      expect(
        c.panel.deps.db
          .select()
          .from(gitInternalHosts)
          .all()
          .map((h) => [h.projectId, h.host]),
      ).toEqual([[c.projectId, "gitea.lan"]]);
    } finally {
      setTargetResolver(null);
    }
  });

  test("a registry login made from the file goes through registries.create's input rules", async () => {
    const a = await side();
    const c = await side("node-c");
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
    const file = await exportZip(a, id, { includeSourceLogin: true });
    const begin = async (edit: (p: any) => void) =>
      callOp(c.panel, transferOps.importBegin, await craft(file.bytes, c.projectId, edit), { cookie: c.cookie });
    for (const edit of [
      (p: any) => (p.services.web.doc.sourceAccess.server = "ghcr.io/../evil"),
      (p: any) => (p.services.web.sourceCredential.password = "x".repeat(5001)),
      (p: any) => (p.services.web.doc.sourceAccess.username = ""),
    ]) {
      const refused = await begin(edit);
      expect(refused.status).toBe(200);
      expect(refused.body.blockers.find((x: { reason: string }) => x.reason === "sourceAccess")?.message).toContain(
        "The registry login in the file does not pass this panel's checks.",
      );
    }
    const begun = await begin((p) => {
      p.services.web.doc.sourceAccess.server = "GHCR.io";
      p.services.web.doc.sourceAccess.username = " acme ";
    });
    expect(begun.body.source.access.picked.kind).toBe("createFromFile");
    const done = await callOp(
      c.panel,
      transferOps.importService,
      { projectId: c.projectId, importId: begun.body.importId },
      { cookie: c.cookie },
    );
    expect(done.status).toBe(200);
    const rows = c.panel.deps.db.select().from(registryCredentials).all();
    expect(rows.map((r) => [r.name, r.server, r.username, c.panel.deps.secrets.open(r.passwordSealed, "registry.credential")])).toEqual([
      ["ghcr", "ghcr.io", "acme", "pw-123456"],
    ]);
    expect(done.body.service.sourceConfig.registryId).toBe(rows[0]?.id);
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

/** The side's node runs an agent that keeps exposed Postgres, MySQL and MariaDB ports TLS only (0.2.9). */
function exposingNode(s: Side) {
  s.fleet.caps.set(s.nodeId, new Set([...(s.fleet.hub.capabilities(s.nodeId) ?? []), exposureCapability]));
}

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
    exposingNode(b);
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
    expect(begun.body.extras.exposures).toEqual([{ listenPort: 15432, allowedCidrs: [], clash: false, action: "skip", refusal: null }]);
    // It runs this panel's image of its version, and says it ran another.
    expect(begun.body.warnings.find((w: { reason: string }) => w.reason === "databaseImage")?.message).toContain("evil/image:1");
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

  test("an imported MySQL 8.4 keeps --mysql-native-password=ON from its file, and nothing else of the file's command", async () => {
    const flag = "--mysql-native-password=ON";
    const a = await side();
    const b = await side("node-b");
    const created = await callOp(
      a.panel,
      dbOps.create,
      { projectId: a.projectId, name: "my", engine: "mysql", nodeId: a.nodeId, version: "8.4" },
      { cookie: a.cookie },
    );
    expect(created.status).toBe(200);
    const id = created.body.serviceId as string;
    // As databases.setVersion keepNativePassword leaves it.
    const spec = readSpec(a.panel.deps.db.select().from(services).where(eq(services.id, id)).get()?.spec);
    a.panel.deps.db
      .update(services)
      .set({ spec: { ...spec, container: { ...spec.container, command: ["mysqld", flag] } } })
      .where(eq(services.id, id))
      .run();
    const zip = (await exportZip(a, id)).bytes;
    /** The container command of the database an import of the file (edited) makes. */
    const imported = async (edit: (doc: Record<string, any>) => void = () => {}) => {
      const begun = await callOp(b.panel, transferOps.importBegin, await craft(zip, b.projectId, (p) => edit(p.services.my.doc)), {
        cookie: b.cookie,
      });
      expect(begun.status).toBe(200);
      expect(begun.body.blockers).toEqual([]);
      const done = await callOp(
        b.panel,
        transferOps.importService,
        { projectId: b.projectId, importId: begun.body.importId },
        { cookie: b.cookie },
      );
      expect(done.status).toBe(200);
      return readSpec(b.panel.deps.db.select().from(services).where(eq(services.id, done.body.service.id)).get()?.spec).container.command;
    };

    // Its accounts made with mysql_native_password keep signing in after the move.
    expect(await imported()).toEqual(["mysqld", flag]);
    // Other options of the file's command stay behind, and so does anything that is not the option itself.
    expect(
      await imported((doc) => {
        doc.spec.container.command = ["mysqld", "--max-connections=5", "--init-file=/tmp/x.sql", flag];
      }),
    ).toEqual(["mysqld", flag]);
    expect(
      await imported((doc) => {
        doc.spec.container.command = ["sh", "-c", `curl evil; exec mysqld ${flag}`];
      }),
    ).toEqual([]);
    expect(
      await imported((doc) => {
        doc.spec.container.command = [];
      }),
    ).toEqual([]);
    // MySQL 8.0 has the plugin on by itself: the option is not for it.
    expect(
      await imported((doc) => {
        doc.database.version = "8.0";
        doc.spec.source.image = "mysql:8.0.43";
      }),
    ).toEqual([]);
  });

  test("the login from the file only when databases.create would take it; else a new one is made", async () => {
    const a = await side();
    const b = await side("node-b");
    await callOp(a.panel, dbOps.create, { projectId: a.projectId, name: "pg", engine: "postgres", nodeId: a.nodeId }, { cookie: a.cookie });
    const svcId = a.panel.deps.db.select().from(services).where(eq(services.name, "pg")).get()?.id as string;
    const injected = "x'; ALTER USER postgres SUPERUSER; --";
    const zip = (await exportZip(a, svcId)).bytes;
    const fits = await craft(zip, b.projectId, (p) => {
      p.services.pg.databaseSecrets[adminPasswordSecret] = "Admin.pass_12345";
      // A file from before 0.2.9's exposure carries the separate user's password too: never stored, never checked.
      p.services.pg.doc.database.exposedUser = "external";
      p.services.pg.databaseSecrets[retiredExposedPasswordSecret] = injected;
    });
    const kept = await callOp(b.panel, transferOps.importBegin, fits, { cookie: b.cookie });
    expect(kept.status).toBe(200);
    expect(kept.body.warnings.map((w: { reason: string }) => w.reason)).not.toContain("databasePassword");
    const refused = await callOp(
      b.panel,
      transferOps.importBegin,
      await craft(zip, b.projectId, (p) => {
        p.services.pg.databaseSecrets[adminPasswordSecret] = injected;
      }),
      { cookie: b.cookie },
    );
    expect(refused.body.warnings.find((w: { reason: string }) => w.reason === "databasePassword")?.message).toContain(
      "admin password does not fit",
    );
    const begun = kept;
    const done = await callOp(
      b.panel,
      transferOps.importService,
      { projectId: b.projectId, importId: begun.body.importId },
      { cookie: b.cookie },
    );
    expect(done.status).toBe(200);
    const secret = (name: string) => {
      const row = b.panel.deps.db
        .select()
        .from(serviceSecrets)
        .where(and(eq(serviceSecrets.serviceId, done.body.service.id), eq(serviceSecrets.name, name)))
        .get();
      return b.panel.deps.secrets.open(row?.valueSealed as string, "service.secret");
    };
    expect(secret(adminPasswordSecret)).toBe("Admin.pass_12345");
    expect(
      b.panel.deps.db
        .select()
        .from(serviceSecrets)
        .where(eq(serviceSecrets.serviceId, done.body.service.id))
        .all()
        .map((r) => r.name),
    ).toEqual([adminPasswordSecret]);
    expect(
      b.panel.deps.db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, done.body.service.id)).get()?.exposedUser,
    ).toBe("");
  });

  test("an old image in the file: the import runs this panel's image of the version", async () => {
    const a = await side();
    const b = await side("node-b");
    await callOp(
      a.panel,
      dbOps.create,
      { projectId: a.projectId, name: "mongo", engine: "mongo", nodeId: a.nodeId, version: "8.0" },
      {
        cookie: a.cookie,
      },
    );
    const svcId = a.panel.deps.db.select().from(services).where(eq(services.name, "mongo")).get()?.id as string;
    // As a panel from before 0.2.9 left it: its catalog's 8.0 then.
    const row = a.panel.deps.db.select().from(services).where(eq(services.id, svcId)).get();
    a.panel.deps.db
      .update(services)
      .set({ spec: { ...readSpec(row?.spec), source: { type: "image", image: "mongo:8.0.12", registryId: null } } })
      .where(eq(services.id, svcId))
      .run();
    const begun = await begin(b, (await exportZip(a, svcId)).bytes);
    expect(begun.status).toBe(200);
    const catalog = engineVersion("mongo", "8.0")?.image as string;
    expect(catalog).not.toBe("mongo:8.0.12");
    expect(begun.body.warnings.find((w: { reason: string }) => w.reason === "databaseImage")?.message).toBe(
      `It ran mongo:8.0.12; it starts here on ${catalog}, this panel's image of MongoDB 8.0.`,
    );
    const done = await callOp(
      b.panel,
      transferOps.importService,
      { projectId: b.projectId, importId: begun.body.importId },
      { cookie: b.cookie },
    );
    expect(done.status).toBe(200);
    const spec = readSpec(b.panel.deps.db.select().from(services).where(eq(services.id, done.body.service.id)).get()?.spec);
    expect(spec.source).toEqual({ type: "image", image: catalog, registryId: null });
    const fresh = await begin(b, (await exportZip(b, done.body.service.id)).bytes);
    expect(fresh.body.warnings.map((w: { reason: string }) => w.reason)).not.toContain("databaseImage");
  });

  test("importedDatabaseImage: data keeps the image it ran when this panel's could read it differently", () => {
    const pick = (engine: DatabaseEngine, variant: string | null, line: string, ran: string | null, withData = true) =>
      importedDatabaseImage(engine, variant, engineVersion(engine, line, variant) as EngineVersion, ran, withData);
    // Same image, or none named: the catalog's, nothing to say.
    expect(pick("postgres", null, "17", "postgres:17.6-alpine")).toEqual({ image: "postgres:17.6-alpine", warning: null, blocker: null });
    expect(pick("postgres", null, "17", null)).toEqual({ image: "postgres:17.6-alpine", warning: null, blocker: null });
    // A newer patch on the catalog's base system is kept, normalized like setVersion stores it.
    expect(pick("postgres", null, "17", "docker.io/library/postgres:17.7-alpine")).toMatchObject({
      image: "postgres:17.7-alpine",
      blocker: null,
    });
    expect(pick("postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg17-trixie").image).toBe("pgvector/pgvector:0.8.8-pg17-trixie");
    expect(pick("mongo", null, "8.0", "mongo:8.0.40").image).toBe("mongo:8.0.40");
    expect(pick("clickhouse", null, "26.3", "clickhouse/clickhouse-server:26.3.70.1").image).toBe("clickhouse/clickhouse-server:26.3.70.1");
    // Any image of the engine's repository on the same line (0.2.11): kept with the data whenever the
    // catalog's could read it differently. Another base system, older or newer; KeyDB's and Dragonfly's
    // own repositories; a tag that floats, or a digest next to its tag.
    for (const [engine, line, ran, why] of [
      ["postgres", "17", "postgres:17.7-trixie", "built on another base system"],
      ["postgres", "17", "postgres:17.4", "built on another base system"],
      ["dragonfly", "2.0", "ghcr.io/dragonflydb/dragonfly:v2.0.9", "newer than"],
      ["mongo", "8.0", "mongo:8.0", "which does not show its release"],
      ["mongo", "8.0", `docker.io/library/mongo:8.0.40@sha256:${"c".repeat(64)}`, "newer than"],
    ] as const) {
      const got = pick(engine, null, line, ran);
      const stored = ran.replace("docker.io/library/", "");
      expect({ ran, ...got }).toEqual({ ran, image: stored, warning: expect.stringContaining(`It ran ${ran}, ${why}`), blocker: null });
      expect(got.warning).toContain(`It keeps ${stored}`);
      // Without the data, an empty database on the catalog image.
      expect(pick(engine, null, line, ran, false)).toMatchObject({ blocker: null, image: engineVersion(engine, line)?.image });
    }
    // An older release on the catalog's base: the catalog's newer patch opens its data.
    expect(pick("postgres", null, "17", "postgres:17.5-alpine")).toMatchObject({ image: "postgres:17.6-alpine", blocker: null });
    expect(pick("mongo", null, "8.0", `mongo:8.0.20@sha256:${"c".repeat(64)}`)).toMatchObject({
      image: engineVersion("mongo", "8.0")?.image,
      blocker: null,
    });
    // Newer data of another line: refused.
    for (const [engine, line, ran] of [["mariadb", "11.4", "mariadb:11.8.2"]] as const) {
      const got = pick(engine, null, line, ran);
      expect(got.image).toBe(engineVersion(engine, line)?.image as string);
      expect(got.blocker).toContain(`Its data was written by ${ran}, newer than`);
      // Without the data nothing is refused: an empty database on the catalog image.
      expect(pick(engine, null, line, ran, false)).toMatchObject({ blocker: null, image: engineVersion(engine, line)?.image });
    }
    // A digest has no release to compare (KeyDB's catalog image is one): the catalog image.
    expect(pick("keydb", null, "6.3", "eqalpha/keydb:x86_64_v6.3.5")).toMatchObject({ blocker: null });
    expect(pick("redis", null, "7.4", `redis@sha256:${"b".repeat(64)}`)).toMatchObject({ image: "redis:7.4.5-alpine", blocker: null });
  });

  test("listeners follow databases.setExposure here: none for a version without TLS or a node too old to keep it TLS only", async () => {
    const a = await side();
    const b = await side("node-b");
    const listener = (serviceId: string, s: Side, port: number) =>
      s.panel.deps.db
        .insert(portExposures)
        .values({ serviceId, nodeId: s.nodeId, kind: "database", listenPort: port, targetPort: 3306, allowedCidrs: ["203.0.113.0/24"] })
        .run();
    // MariaDB 10.11 has no TLS: a listener from before 0.2.9 is closed there, and none is made here.
    await callOp(
      a.panel,
      dbOps.create,
      { projectId: a.projectId, name: "maria", engine: "mariadb", nodeId: a.nodeId, version: "10.11" },
      {
        cookie: a.cookie,
      },
    );
    const maria = a.panel.deps.db.select().from(services).where(eq(services.name, "maria")).get()?.id as string;
    listener(maria, a, 13306);
    exposingNode(b);
    const old = await begin(b, (await exportZip(a, maria)).bytes);
    expect(old.status).toBe(200);
    expect(old.body.extras.exposures).toEqual([
      {
        listenPort: 13306,
        allowedCidrs: ["203.0.113.0/24"],
        clash: false,
        action: "skip",
        refusal: engineVersion("mariadb", "10.11")?.noExposure,
      },
    ]);
    const made = await callOp(
      b.panel,
      transferOps.importService,
      { projectId: b.projectId, importId: old.body.importId },
      { cookie: b.cookie },
    );
    expect(made.status).toBe(200);
    expect(b.panel.deps.db.select().from(portExposures).where(eq(portExposures.serviceId, made.body.service.id)).all()).toEqual([]);
    expect(made.body.skipped).toContainEqual({ what: "Database listeners", why: engineVersion("mariadb", "10.11")?.noExposure });

    // MariaDB 11.4 on a node whose agent is from before 0.2.9: refused, as setExposure refuses it; added once the node can.
    await callOp(
      a.panel,
      dbOps.create,
      { projectId: a.projectId, name: "maria2", engine: "mariadb", nodeId: a.nodeId, version: "11.4" },
      {
        cookie: a.cookie,
      },
    );
    const maria2 = a.panel.deps.db.select().from(services).where(eq(services.name, "maria2")).get()?.id as string;
    listener(maria2, a, 13307);
    const zip = (await exportZip(a, maria2)).bytes;
    b.fleet.caps.set(b.nodeId, new Set([...(b.fleet.hub.capabilities(b.nodeId) ?? [])].filter((c) => c !== exposureCapability)));
    const tooOld = await begin(b, zip);
    expect(tooOld.body.extras.exposures[0]).toMatchObject({ listenPort: 13307, action: "skip" });
    expect(tooOld.body.extras.exposures[0].refusal).toBe(
      "The agent on node-b cannot expose MariaDB with its own user over TLS yet. Update the node, then expose it on its Connection tab.",
    );
    exposingNode(b);
    const updated = await begin(b, zip);
    expect(updated.body.extras.exposures).toEqual([
      { listenPort: 13307, allowedCidrs: ["203.0.113.0/24"], clash: false, action: "add", refusal: null },
    ]);
    const added = await callOp(
      b.panel,
      transferOps.importService,
      { projectId: b.projectId, importId: updated.body.importId },
      {
        cookie: b.cookie,
      },
    );
    expect(added.status).toBe(200);
    const got = await callOp(b.panel, dbOps.get, { serviceId: added.body.service.id }, { cookie: b.cookie });
    expect(got.body.exposure).toMatchObject({ enabled: true, user: "root", allowedCidrs: ["203.0.113.0/24"] });
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
