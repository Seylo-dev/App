import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "@seylo/env-analyzer";
import {
  boxes as boxOps,
  databases as dbOps,
  deployments as deploymentOps,
  domains as domainOps,
  env,
  projects,
  services as serviceOps,
} from "@seylo/ops";
import { DeployStage } from "@seylo/proto";
import { and, eq, sql } from "drizzle-orm";
import {
  apiKeys,
  deployments,
  domains,
  grants,
  invites,
  nodes,
  serviceCopies,
  serviceDatabases,
  serviceSecrets,
  services,
  sourceUploads,
  volumes,
} from "../src/db/schema";
import { compileDesiredState } from "../src/desired";
import { engineFor } from "../src/modules/deployments/engine";
import { cloneDataJob, cloneName } from "../src/modules/services/clone";
import { serviceSpecFor } from "../src/modules/services/desired";
import { ownReferenceEffects, referrersOf, renameSelf, sharedVariablesLost } from "../src/modules/services/impact";
import { hashToken, prefixedToken } from "../src/security/tokens";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let shop: string;
let blog: string;
let nodeA: string;
let nodeB: string;

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a");
  nodeB = fleet.addNode("node-b");
  panel.deps.db.update(nodes).set({ wildcardDomain: "b.example.com" }).where(eq(nodes.id, nodeB)).run();
  ({ cookie } = await createUser(panel, "owner"));
  shop = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  blog = (await callOp(panel, projects.create, { name: "blog" }, { cookie })).body.id;
});
afterEach(() => panel.close());

async function app(projectId: string, name: string, options: { volumes?: { name: string; mountPath: string }[]; env?: string } = {}) {
  const id = (
    await callOp(
      panel,
      serviceOps.create,
      {
        projectId,
        name,
        kind: "app",
        nodeId: nodeA,
        source: { type: "image", image: "nginx:1.27", registryId: null },
        ports: [{ containerPort: 8080, protocol: "tcp" }],
      },
      { cookie },
    )
  ).body.id as string;
  if (options.volumes)
    expect((await callOp(panel, serviceOps.setVolumes, { serviceId: id, volumes: options.volumes }, { cookie })).status).toBe(200);
  if (options.env) expect((await callOp(panel, env.set, { serviceId: id, text: options.env }, { cookie })).status).toBe(200);
  return id;
}

async function deployLive(id: string) {
  const dep = (await callOp(panel, deploymentOps.deploy, { serviceId: id }, { cookie })).body;
  await fleet.settle();
  fleet.deployProgress(nodeA, id, dep.generation, DeployStage.SUCCEEDED);
  await fleet.settle();
  return dep.generation as number;
}

/** Replaces a grant (the helper only inserts). */
function regrant(userId: string, scopeType: "project" | "service", scopeId: string, actions: string[]) {
  panel.deps.db
    .delete(grants)
    .where(and(eq(grants.userId, userId), eq(grants.scopeType, scopeType), eq(grants.scopeId, scopeId)))
    .run();
  grant(panel, userId, scopeType, scopeId, actions);
}

function row(id: string) {
  return panel.deps.db.select().from(services).where(eq(services.id, id)).get();
}

describe("clone names", () => {
  test("adds -copy, then counts, and fits 40 characters", () => {
    const taken = new Set(["api-copy", "api-copy-2"]);
    expect(cloneName((n) => taken.has(n), "web")).toBe("web-copy");
    expect(cloneName((n) => taken.has(n), "api")).toBe("api-copy-3");
    const long = "a".repeat(38);
    expect(cloneName(() => false, long)).toBe(`${"a".repeat(35)}-copy`);
    expect(cloneName(() => false, `${"a".repeat(34)}-bbbb`)).toBe(`${"a".repeat(34)}-copy`);
  });
});

describe("services.clone", () => {
  test("copies settings, env, notes and access rules onto a new automatic domain; no domains or history", async () => {
    const id = await app(shop, "web", { env: "MODE=prod\nAPI_KEY=s3cret\n" });
    await callOp(panel, serviceOps.setNotes, { serviceId: id, notes: "runbook" }, { cookie });
    await callOp(
      panel,
      serviceOps.setResources,
      { serviceId: id, memoryLimitBytes: 256 * 1024 * 1024, memoryReservationBytes: null, cpuWeight: 200, pidsLimit: null },
      { cookie },
    );
    await callOp(panel, serviceOps.setCrashPolicy, { serviceId: id, restart: true, stopAfterCrashes: 3 }, { cookie });
    const added = await callOp(panel, domainOps.add, { serviceId: id, host: "web.shop.example" }, { cookie });
    await callOp(
      panel,
      domainOps.setMiddlewares,
      {
        serviceId: id,
        domainId: added.body.domain.id,
        ipAllowList: ["10.0.0.0/8"],
        rateLimit: { average: 50, burst: 100, periodSeconds: 1 },
      },
      { cookie },
    );
    await deployLive(id);

    const preview = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog, nodeId: nodeB }, { cookie });
    expect(preview.body).toMatchObject({ name: "web-copy", env: "copied", autoDomain: "web-copy.b.example.com", middlewares: true });
    expect(preview.body.data).toEqual({ available: false, blockedBy: "noVolumes", alwaysStops: false });

    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeB, autoDomain: true }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.copied).toEqual({
      env: true,
      fileMounts: false,
      databaseLogins: false,
      middlewares: true,
      autoDomain: "web-copy.b.example.com",
    });
    const clone = res.body.service;
    expect(clone).toMatchObject({
      name: "web-copy",
      projectId: blog,
      status: "idle",
      stopped: true,
      notes: "runbook",
      liveDeployment: null,
      crashPolicy: { restart: true, stopAfterCrashes: 3 },
      resources: { memoryLimitBytes: 256 * 1024 * 1024, cpuWeight: 200 },
      sourceConfig: { type: "image", image: "nginx:1.27" },
    });
    expect(clone.placements.map((p: { nodeId: string }) => p.nodeId)).toEqual([nodeB]);
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, clone.id)).all()).toEqual([]);
    const cloneDomains = panel.deps.db.select().from(domains).where(eq(domains.serviceId, clone.id)).all();
    expect(cloneDomains.map((d) => [d.host, d.auto, d.isPrimary])).toEqual([["web-copy.b.example.com", true, true]]);
    expect(cloneDomains[0]?.middlewares).toEqual({ ipAllowList: ["10.0.0.0/8"], rateLimit: { average: 50, burst: 100, periodSeconds: 1 } });
    const copied = await callOp(panel, env.get, { serviceId: clone.id }, { cookie });
    expect(copied.body.text).toBe("MODE=prod\nAPI_KEY=s3cret\n");
    // Parked on its node (stopped, no image) until its first start.
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, clone.id, nodeB);
    expect(spec?.stopped).toBe(true);
    expect(spec?.projectId).toBe(blog);
    expect(spec?.image?.reference).toBe("");

    // Starting it is its first deploy.
    expect((await callOp(panel, serviceOps.start, { serviceId: clone.id }, { cookie })).status).toBe(200);
    const deploys = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, clone.id)).all();
    expect(deploys.length).toBe(1);
  });

  test("a second clone in the same project counts up, and stacks are refused", async () => {
    const id = await app(shop, "api");
    expect((await callOp(panel, serviceOps.clone, { serviceId: id, projectId: shop, nodeId: nodeA }, { cookie })).body.service.name).toBe(
      "api-copy",
    );
    expect((await callOp(panel, serviceOps.clone, { serviceId: id, projectId: shop, nodeId: nodeA }, { cookie })).body.service.name).toBe(
      "api-copy-2",
    );
    const named = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: shop, nodeId: nodeA, name: "api" }, { cookie });
    expect(named.body.error).toMatchObject({ code: "CONFLICT", details: { field: "name" } });
    const stack = panel.deps.db
      .insert(services)
      .values({ projectId: shop, name: "stack", nameKey: "stack", kind: "compose", spec: {} })
      .returning()
      .get();
    const refused = await callOp(panel, serviceOps.clone, { serviceId: stack.id, projectId: shop, nodeId: nodeA }, { cookie });
    expect(refused.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "compose" } });
  });

  test("a compose member becomes a standalone app", async () => {
    const stack = panel.deps.db
      .insert(services)
      .values({ projectId: shop, name: "stack", nameKey: "stack", kind: "compose", spec: {} })
      .returning()
      .get();
    const member = await app(shop, "stack-db");
    const spec = row(member)?.spec as Record<string, unknown>;
    panel.deps.db
      .update(services)
      .set({ parentId: stack.id, spec: { ...spec, member: { composeService: "db", dependsOn: [], buildContext: null } } })
      .where(eq(services.id, member))
      .run();
    const res = await callOp(panel, serviceOps.clone, { serviceId: member, projectId: shop, nodeId: nodeA }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.service.parentId).toBeNull();
    const cloneSpec = row(res.body.service.id)?.spec as { member: unknown };
    expect(cloneSpec.member).toBeNull();
  });

  test("needs services.view on the source and services.create in the target project", async () => {
    const id = await app(shop, "web");
    const member = await createUser(panel, "member");
    const noView = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie: member.cookie });
    expect(noView.body.error).toMatchObject({ code: "FORBIDDEN" });

    grant(panel, member.user.id, "service", id, ["services.view"]);
    const noCreate = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie: member.cookie });
    expect(noCreate.body.error).toMatchObject({ code: "FORBIDDEN", details: { action: "services.create" } });
    const preview = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { cookie: member.cookie });
    expect(preview.body.error).toMatchObject({ code: "FORBIDDEN" });

    grant(panel, member.user.id, "project", blog, ["services.create", "services.view"]);
    const ok = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie: member.cookie });
    expect(ok.status).toBe(200);
  });

  test("env and file mounts come along only for people who can read them", async () => {
    const id = await app(shop, "web", { env: "TOKEN=abc\n" });
    panel.deps.db
      .insert(volumes)
      .values({
        serviceId: id,
        name: "config",
        mountPath: "/etc/app.conf",
        kind: "file",
        contentSealed: panel.deps.secrets.seal("password=x", "volume.file"),
      })
      .run();
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view"]);
    grant(panel, member.user.id, "project", blog, ["services.create", "services.view", "env.view", "env.edit", "files.write"]);

    const preview = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { cookie: member.cookie });
    expect(preview.body.env).toBe("hidden");
    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie: member.cookie });
    expect(res.body.copied).toMatchObject({ env: false, fileMounts: false });
    expect((await callOp(panel, env.get, { serviceId: res.body.service.id }, { cookie })).body.text).toBe("");
    expect(panel.deps.db.select().from(volumes).where(eq(volumes.serviceId, res.body.service.id)).all()).toEqual([]);

    // With env.view the .env and the file mount (re-sealed) come along.
    regrant(member.user.id, "service", id, ["services.view", "env.view"]);
    const full = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie: member.cookie });
    expect(full.body.copied).toMatchObject({ env: true, fileMounts: true });
    const file = panel.deps.db.select().from(volumes).where(eq(volumes.serviceId, full.body.service.id)).get();
    expect(file?.kind).toBe("file");
    expect(panel.deps.secrets.open(file?.contentSealed ?? "", "volume.file")).toBe("password=x");
  });

  test("env and file mounts stay behind without env.edit (and files.write) in the target project", async () => {
    const id = await app(shop, "web", { env: "TOKEN=abc\n" });
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view", "env.view"]);
    // services.create alone does not let anyone set a service's env there.
    grant(panel, member.user.id, "project", blog, ["services.create", "services.view"]);
    const preview = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { cookie: member.cookie });
    expect(preview.body.env).toBe("noWrite");
    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie: member.cookie });
    expect(res.status).toBe(200);
    expect(res.body.copied).toMatchObject({ env: false, fileMounts: false });
    expect((await callOp(panel, env.get, { serviceId: res.body.service.id }, { cookie })).body.text).toBe("");

    // With env.edit the .env comes along; a file mount also needs files.write.
    regrant(member.user.id, "project", blog, ["services.create", "services.view", "env.edit"]);
    expect((await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { cookie: member.cookie })).body.env).toBe(
      "copied",
    );
    panel.deps.db
      .insert(volumes)
      .values({
        serviceId: id,
        name: "config",
        mountPath: "/etc/app.conf",
        kind: "file",
        contentSealed: panel.deps.secrets.seal("x", "volume.file"),
      })
      .run();
    expect((await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { cookie: member.cookie })).body.env).toBe(
      "noWrite",
    );
    regrant(member.user.id, "project", blog, ["services.create", "services.view", "env.edit", "files.write"]);
    const full = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie: member.cookie });
    expect(full.body.copied).toMatchObject({ env: true, fileMounts: true });
  });

  test("the copied .env names the clone where it named the source itself", async () => {
    const text =
      'A=${{web.URL}}\nSELF=http://web:8080/health\nHOST=web\nB=${{ WEB.PORT }}\nQ="postgres://u:p@web:5432/app"\nOTHER=${{api.URL}}\n';
    await app(shop, "api");
    const id = await app(shop, "web", { env: text });
    const preview = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: shop }, { cookie });
    expect(preview.body.name).toBe("web-copy");
    expect(preview.body.references).toEqual([
      { key: "A", target: "web.URL", via: "reference", effect: "renamed" },
      { key: "SELF", target: "web:8080", via: "hostname", effect: "renamed" },
      { key: "B", target: "WEB.PORT", via: "reference", effect: "renamed" },
      { key: "Q", target: "web:5432", via: "hostname", effect: "renamed" },
      // A value that is just the name may be a database or user name: it stays, and now reaches the source.
      { key: "HOST", target: "web", via: "hostname", effect: "retargeted" },
    ]);
    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: shop, nodeId: nodeA }, { cookie });
    expect(res.status).toBe(200);
    expect((await callOp(panel, env.get, { serviceId: res.body.service.id }, { cookie })).body.text).toBe(
      'A=${{web-copy.URL}}\nSELF=http://web-copy:8080/health\nHOST=web\nB=${{ web-copy.PORT }}\nQ="postgres://u:p@web-copy:5432/app"\nOTHER=${{api.URL}}\n',
    );
    // In another project the bare name points at nothing (blog has no web).
    const there = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { cookie });
    expect(there.body.references).toContainEqual({ key: "HOST", target: "web", via: "hostname", effect: "unresolved" });
    expect(there.body.references).toContainEqual({ key: "OTHER", target: "api.URL", via: "reference", effect: "unresolved" });
    expect(there.body.references).toContainEqual({ key: "A", target: "web.URL", via: "reference", effect: "renamed" });
  });

  test("renameSelf: references and URL hosts follow the clone's name, a bare value stays", () => {
    expect(renameSelf("A=${{web.URL}}\n", "web", "web-copy")).toEqual({
      text: "A=${{web-copy.URL}}\n",
      renamed: [{ key: "A", target: "web.URL", via: "reference" }],
      kept: [],
    });
    expect(renameSelf("DB_NAME=web\nX='web:80'\nY=webby:80\nZ=${{web2.URL}}\n", "web", "web-copy")).toEqual({
      text: "DB_NAME=web\nX='web-copy:80'\nY=webby:80\nZ=${{web2.URL}}\n",
      renamed: [{ key: "X", target: "web:80", via: "hostname" }],
      kept: [{ key: "DB_NAME", target: "web" }],
    });
    expect(renameSelf("A=${{web.URL}}\n", "web", "WEB").renamed).toEqual([]);
    // Every occurrence changes; each is listed once.
    expect(renameSelf("A=http://web:80,http://web:80\n", "web", "w2")).toEqual({
      text: "A=http://w2:80,http://w2:80\n",
      renamed: [{ key: "A", target: "web:80", via: "hostname" }],
      kept: [],
    });
  });

  test("a copied .env may not reach into the target project past what the caller can read", async () => {
    await app(blog, "vault", { env: "MASTER=hunter2\n" });
    const id = await app(shop, "web", { env: "SECRET=${{vault.MASTER}}\n" });
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view", "env.view"]);
    grant(panel, member.user.id, "project", blog, ["services.create", "services.view", "env.edit"]);
    const preview = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { cookie: member.cookie });
    expect(preview.body.references).toEqual([{ key: "SECRET", target: "vault.MASTER", via: "reference", effect: "retargeted" }]);
    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie: member.cookie });
    expect(res.body.error).toMatchObject({ code: "FORBIDDEN", details: { reference: "vault.MASTER" } });
    expect(panel.deps.db.select().from(services).where(eq(services.nameKey, "web-copy")).get()).toBeUndefined();
  });

  test("push deploys and previews stay off on the clone", async () => {
    const id = await app(shop, "web");
    const spec = row(id)?.spec as Record<string, unknown>;
    panel.deps.db
      .update(services)
      .set({
        spec: {
          ...spec,
          source: { type: "git", url: "https://git.example.com/a/b.git", branch: "main", credentialId: null, deployOnPush: true },
          previews: { enabled: true, domainPattern: "", maxPreviews: 5 },
        },
      })
      .where(eq(services.id, id))
      .run();
    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: shop, nodeId: nodeA }, { cookie });
    expect(res.body.service.sourceConfig).toMatchObject({ type: "git", deployOnPush: false });
    const cloneSpec = row(res.body.service.id)?.spec as { previews: { enabled: boolean } } | undefined;
    expect(cloneSpec?.previews.enabled).toBe(false);
  });

  test("an upload app's clone gets a copy of the newest archive, for people who can read its files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seylo-clone-upload-"));
    (panel.deps.config as { dataDir: string }).dataDir = dir;
    try {
      const id = await app(shop, "site");
      const spec = row(id)?.spec as Record<string, unknown>;
      panel.deps.db
        .update(services)
        .set({ spec: { ...spec, source: { type: "upload", fileName: "site-v2.tar.gz" } } })
        .where(eq(services.id, id))
        .run();
      await mkdir(join(dir, "uploads"), { recursive: true });
      const upload = (fileName: string, content: string, createdAt: Date) => {
        const r = panel.deps.db
          .insert(sourceUploads)
          .values({ serviceId: id, fileName, sizeBytes: content.length, sha256: "0".repeat(64), createdAt })
          .returning()
          .get();
        writeFileSync(join(dir, "uploads", `${r.id}.tar.gz`), content);
      };
      upload("site-v1.tar.gz", "old archive", new Date(Date.now() - 120_000));
      upload("site-v2.tar.gz", "newest archive", new Date(Date.now() - 60_000));

      const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie });
      expect(res.status).toBe(200);
      const cloneId = res.body.service.id as string;
      const copied = panel.deps.db.select().from(sourceUploads).where(eq(sourceUploads.serviceId, cloneId)).all();
      expect(copied.map((u) => [u.fileName, u.sizeBytes])).toEqual([["site-v2.tar.gz", "newest archive".length]]);
      expect(readFileSync(join(dir, "uploads", `${copied[0]?.id}.tar.gz`), "utf8")).toBe("newest archive");
      expect((await callOp(panel, serviceOps.get, { serviceId: cloneId }, { cookie })).body.sourceConfig).toEqual({
        type: "upload",
        fileName: "site-v2.tar.gz",
      });

      // The archive is the source's files: without files.read the clone waits for its own upload.
      const member = await createUser(panel, "member");
      grant(panel, member.user.id, "service", id, ["services.view"]);
      grant(panel, member.user.id, "project", blog, ["services.create", "services.view"]);
      const bare = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { cookie: member.cookie });
      expect(bare.status).toBe(200);
      expect(panel.deps.db.select().from(sourceUploads).where(eq(sourceUploads.serviceId, bare.body.service.id)).all()).toEqual([]);
      expect(row(bare.body.service.id)?.spec).toMatchObject({ source: { type: "upload", fileName: null } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("API keys on clone and move", () => {
  function key(userId: string, options: { projectIds?: string[]; readOnly?: boolean }) {
    const token = prefixedToken("key");
    panel.deps.db
      .insert(apiKeys)
      .values({
        userId,
        name: "test",
        prefix: token.slice(0, 12),
        tokenHash: hashToken(token),
        actions: ["*"],
        projectIds: options.projectIds ?? null,
        readOnly: options.readOnly ?? false,
      })
      .run();
    return token;
  }

  test("a key limited to one project clones and moves only inside it; a read-only key only previews", async () => {
    const id = await app(shop, "api");
    const owner = await createUser(panel, "owner");
    const limited = key(owner.user.id, { projectIds: [shop] });
    const forbidden = { code: "FORBIDDEN", details: { action: "services.create" } };

    expect((await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: shop }, { bearer: limited })).status).toBe(200);
    expect((await callOp(panel, serviceOps.clone, { serviceId: id, projectId: shop, nodeId: nodeA }, { bearer: limited })).status).toBe(
      200,
    );
    // The op's own permission is on the source (inside the key's project); the target is checked in the handler.
    const preview = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { bearer: limited });
    expect(preview.body.error).toMatchObject(forbidden);
    const clone = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { bearer: limited });
    expect(clone.body.error).toMatchObject(forbidden);
    const impact = await callOp(panel, serviceOps.moveProjectImpact, { serviceId: id, projectId: blog }, { bearer: limited });
    expect(impact.body.error).toMatchObject(forbidden);
    const move = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { bearer: limited });
    expect(move.body.error).toMatchObject(forbidden);
    expect(panel.deps.db.select().from(services).where(eq(services.projectId, blog)).all()).toEqual([]);

    const readOnly = key(owner.user.id, { readOnly: true });
    expect((await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { bearer: readOnly })).status).toBe(200);
    expect((await callOp(panel, serviceOps.moveProjectImpact, { serviceId: id, projectId: blog }, { bearer: readOnly })).status).toBe(200);
    const roClone = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA }, { bearer: readOnly });
    expect(roClone.status).toBe(403);
    const roMove = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { bearer: readOnly });
    expect(roMove.status).toBe(403);
    expect(row(id)?.projectId).toBe(shop);
  });
});

describe("cloning databases and data", () => {
  async function postgres(name = "db") {
    const res = await callOp(panel, dbOps.create, { projectId: shop, name, engine: "postgres", nodeId: nodeA }, { cookie });
    expect(res.status).toBe(200);
    await fleet.settle();
    return res.body.serviceId as string;
  }

  test("starting empty gets new logins; copying data needs databases.credentials and keeps the logins", async () => {
    const id = await postgres();
    const secretsOf = (serviceId: string) =>
      Object.fromEntries(
        panel.deps.db
          .select()
          .from(serviceSecrets)
          .where(eq(serviceSecrets.serviceId, serviceId))
          .all()
          .map((s) => [s.name, panel.deps.secrets.open(s.valueSealed, "service.secret")]),
      );
    const empty = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeB }, { cookie });
    expect(empty.status).toBe(200);
    expect(empty.body.copied.databaseLogins).toBe(false);
    const before = secretsOf(id);
    const fresh = secretsOf(empty.body.service.id);
    expect(Object.keys(fresh).sort()).toEqual(Object.keys(before).sort());
    expect(fresh.admin_password).not.toBe(before.admin_password);
    const dbRow = panel.deps.db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, empty.body.service.id)).get();
    expect(dbRow).toMatchObject({ engine: "postgres", tlsHostname: null });
    // A database is sent to its node even before its first start, stopped.
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, empty.body.service.id, nodeB)?.stopped).toBe(true);

    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view", "files.read"]);
    grant(panel, member.user.id, "project", blog, ["services.create", "services.view"]);
    const preview = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { cookie: member.cookie });
    expect(preview.body.data).toEqual({ available: false, blockedBy: "databaseLogins", alwaysStops: true });
    const refused = await callOp(
      panel,
      serviceOps.clone,
      { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy" },
      { cookie: member.cookie },
    );
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", details: { reason: "databaseLogins" } });
    const running = await callOp(
      panel,
      serviceOps.clone,
      { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy", stopSource: false },
      { cookie },
    );
    expect(running.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "stopSource" } });

    const copied = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy" }, { cookie });
    expect(copied.status).toBe(200);
    expect(copied.body.copied.databaseLogins).toBe(true);
    expect(secretsOf(copied.body.service.id).admin_password).toBe(before.admin_password);
    expect(copied.body.dataCopy).toMatchObject({ status: "queued", fromName: "db", volumes: ["data"] });
  });

  test("copies volume data through the panel, stopping and restarting the source; the clone waits", async () => {
    const id = await app(shop, "files", { volumes: [{ name: "data", mountPath: "/data" }] });
    await deployLive(id);
    fleet.volumes.set(nodeA, new Map([[`${id}/data`, new TextEncoder().encode("the bytes of the volume")]]));
    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy" }, { cookie });
    expect(res.status).toBe(200);
    const cloneId = res.body.service.id as string;
    // Neither the clone nor its stopped source may deploy until the copy ended.
    const early = await callOp(panel, deploymentOps.deploy, { serviceId: cloneId }, { cookie });
    expect(early.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "copying" } });

    const job = panel.runner.runDue(panel.deps);
    await fleet.settle();
    expect(row(id)?.stopped).toBe(true);
    // The source reports it stopped.
    fleet.reportRunning(nodeA, id, 1, "", 8 /* STOPPED */);
    await job;
    await panel.runner.runDue(panel.deps);
    await fleet.settle();
    expect(new TextDecoder().decode(fleet.volumes.get(nodeB)?.get(`${cloneId}/data`))).toBe("the bytes of the volume");
    const copy = panel.deps.db.select().from(serviceCopies).where(eq(serviceCopies.serviceId, cloneId)).get();
    expect(copy).toMatchObject({ status: "done", bytesCopied: 23, sourceStopped: false });
    expect(row(id)?.stopped).toBe(false);
    const detail = await callOp(panel, serviceOps.get, { serviceId: cloneId }, { cookie });
    expect(detail.body.dataCopy).toMatchObject({ status: "done", fromName: "files", bytesCopied: 23 });
    expect((await callOp(panel, deploymentOps.deploy, { serviceId: cloneId }, { cookie })).status).toBe(200);
  });

  test("a database clone's first start deploys it", async () => {
    const id = await postgres();
    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeB }, { cookie });
    expect(res.status).toBe(200);
    const cloneId = res.body.service.id as string;
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, cloneId, nodeB)?.stopped).toBe(true);
    expect((await callOp(panel, serviceOps.start, { serviceId: cloneId }, { cookie })).status).toBe(200);
    await fleet.settle();
    const deploys = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, cloneId)).all();
    expect(deploys.map((d) => [d.status, d.targetNodeIds])).toEqual([["deploying", [nodeB]]]);
    const spec = serviceSpecFor(panel.deps.db, panel.deps.secrets, cloneId, nodeB);
    expect(spec?.stopped).toBe(false);
    expect(spec?.projectId).toBe(blog);
    expect(spec?.image?.reference).toContain("postgres");
    fleet.deployProgress(nodeB, cloneId, deploys[0]?.generation ?? 0, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, cloneId)).get()?.status).toBe("live");
    // Starting it again is an ordinary start now.
    expect((await callOp(panel, serviceOps.start, { serviceId: cloneId }, { cookie })).status).toBe(200);
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, cloneId)).all()).toHaveLength(1);
  });

  test("a copy interrupted by a panel restart resumes: no second stop, the whole volume again, once", async () => {
    const id = await app(shop, "files", { volumes: [{ name: "data", mountPath: "/data" }] });
    const gen = await deployLive(id);
    fleet.volumes.set(nodeA, new Map([[`${id}/data`, new TextEncoder().encode("the bytes of the volume")]]));
    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy" }, { cookie });
    const cloneId = res.body.service.id as string;
    const copyId = res.body.dataCopy.id as string;
    // The first run stopped the source and wrote part of the volume when the panel restarted.
    const startedAt = new Date(Date.now() - 60_000);
    panel.deps.db.update(services).set({ stopped: true }).where(eq(services.id, id)).run();
    panel.deps.db
      .update(serviceCopies)
      .set({ status: "copying", sourceStopped: true, startedAt, bytesCopied: 4 })
      .where(eq(serviceCopies.id, copyId))
      .run();
    fleet.volumes.set(nodeB, new Map([[`${cloneId}/data`, new TextEncoder().encode("the ")]]));
    fleet.reportRunning(nodeA, id, gen, "", 8 /* STOPPED */);

    // The job runs again after the restart.
    const job = (attempt: number) => ({ ...panel.deps, jobId: `clone-data:${copyId}`, attempt });
    await cloneDataJob.run({ copyId }, job(1));
    await fleet.settle();
    expect(new TextDecoder().decode(fleet.volumes.get(nodeB)?.get(`${cloneId}/data`))).toBe("the bytes of the volume");
    const copy = panel.deps.db.select().from(serviceCopies).where(eq(serviceCopies.id, copyId)).get();
    expect(copy).toMatchObject({ status: "done", bytesCopied: 23, sourceStopped: false });
    expect(copy?.startedAt?.getTime()).toBeLessThan(Date.now() - 30_000);
    expect(row(id)?.stopped).toBe(false);
    const exports = () => fleet.calls.filter((c) => c.method === "exportVolume").length;
    expect(exports()).toBe(1);

    // The run queued before the restart finds it done and touches nothing.
    await cloneDataJob.run({ copyId }, job(1));
    expect(exports()).toBe(1);
    expect(row(id)?.stopped).toBe(false);
    expect(panel.deps.db.select().from(serviceCopies).where(eq(serviceCopies.id, copyId)).get()?.status).toBe("done");
  });

  test("copying volume data needs files.read and online nodes", async () => {
    const id = await app(shop, "files", { volumes: [{ name: "data", mountPath: "/data" }] });
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view"]);
    grant(panel, member.user.id, "project", blog, ["services.create", "services.view"]);
    const refused = await callOp(
      panel,
      serviceOps.clone,
      { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy" },
      { cookie: member.cookie },
    );
    expect(refused.body.error).toMatchObject({ code: "FORBIDDEN", details: { reason: "files" } });
    fleet.online.delete(nodeB);
    const offline = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog, nodeId: nodeB }, { cookie });
    expect(offline.body.data.blockedBy).toBe("offline");
    // Starting empty works either way.
    expect((await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeB }, { cookie })).status).toBe(200);
  });
});

describe("move impact analysis", () => {
  const parsed = (text: string) => parseEnv(text);
  const svc = (id: string, name: string, text = "", kind = "app") => ({ id, name, kind, parsed: parsed(text) });

  test("own references: unresolved, retargeted, shared variables and literal host names", () => {
    const self = svc(
      "s1",
      "api",
      "DB=${{db.INTERNAL_URL}}\nCACHE=${{cache.URL}}\nKEY=${{project.API_KEY}}\nLOG=${{project.LOG_LEVEL}}\nMQ=amqp://queue:5672\nSELF=${{api.PORT}}\nGONE=${{nobody.X}}\n",
    );
    const from = {
      services: [self, svc("s2", "db"), svc("s3", "cache"), svc("s4", "queue")],
      shared: parsed("API_KEY=1\nLOG_LEVEL=info\n"),
    };
    const to = { services: [svc("t1", "cache")], shared: parsed("LOG_LEVEL=debug\n") };
    expect(ownReferenceEffects(self, from, to)).toEqual([
      { key: "DB", target: "db.INTERNAL_URL", via: "reference", effect: "unresolved" },
      { key: "CACHE", target: "cache.URL", via: "reference", effect: "retargeted" },
      { key: "KEY", target: "project.API_KEY", via: "reference", effect: "unresolved" },
      { key: "LOG", target: "project.LOG_LEVEL", via: "reference", effect: "retargeted" },
      { key: "MQ", target: "queue:5672", via: "hostname", effect: "unresolved" },
    ]);
  });

  test("referrers by reference or host name, and shared variables lost", () => {
    const project = {
      services: [
        svc("s1", "api", "X=1\n"),
        svc("s2", "web", "API=${{api.URL}}\nOTHER=1\n"),
        svc("s3", "worker", "TARGET=http://api:8080/jobs\n"),
        svc("s4", "docs", "NAME=api docs\n"),
      ],
      shared: parsed("A=1\nX=2\nB=3\n"),
    };
    expect(referrersOf("api", project, "s1").map((r) => [r.service.name, r.keys])).toEqual([
      ["web", ["API"]],
      ["worker", ["TARGET"]],
    ]);
    const self = project.services[0] as ReturnType<typeof svc>;
    expect(sharedVariablesLost(self, project, { services: [], shared: parsed("B=9\n") })).toEqual(["A"]);
    expect(sharedVariablesLost({ ...self, kind: "postgres" }, project, { services: [], shared: parsed("") })).toEqual([]);
  });
});

describe("services.moveProject", () => {
  test("the impact lists referrers, own references, grants, invites and blockers", async () => {
    const id = await app(shop, "api", { env: "DB=${{db.URL}}\n" });
    await app(shop, "db");
    await app(shop, "web", { env: "API=${{api.INTERNAL_URL}}\n" });
    await app(blog, "front", { env: "BACKEND=http://api:8080\n" });
    const member = await createUser(panel, "member", "pat@example.com");
    grant(panel, member.user.id, "service", id, ["services.view"]);
    panel.deps.db
      .insert(invites)
      .values({
        email: "sam@example.com",
        grants: [{ scopeType: "service", scopeId: id, actions: ["services.view"] }],
        tokenHash: "x",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .run();

    const impact = await callOp(panel, serviceOps.moveProjectImpact, { serviceId: id, projectId: blog }, { cookie });
    expect(impact.status).toBe(200);
    expect(impact.body).toMatchObject({
      blockers: [],
      referencedBy: [{ name: "web", keys: ["API"] }],
      targetReferrers: [{ name: "front", keys: ["BACKEND"] }],
      ownReferences: [{ key: "DB", target: "db.URL", via: "reference", effect: "unresolved" }],
      grants: { count: 1, names: ["member"] },
      invites: 1,
      switches: false,
    });

    const same = await callOp(panel, serviceOps.moveProjectImpact, { serviceId: id, projectId: shop }, { cookie });
    expect(same.body.blockers.map((b: { reason: string }) => b.reason)).toEqual(["sameProject"]);
    await app(blog, "api");
    const clash = await callOp(panel, serviceOps.moveProjectImpact, { serviceId: id, projectId: blog }, { cookie });
    expect(clash.body.blockers.map((b: { reason: string }) => b.reason)).toEqual(["nameTaken"]);
  });

  test("needs full access to the service and services.create in the target", async () => {
    const id = await app(shop, "api");
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view", "services.move"]);
    const noCreate = await callOp(
      panel,
      serviceOps.moveProject,
      { serviceId: id, projectId: blog, confirm: true },
      { cookie: member.cookie },
    );
    expect(noCreate.body.error).toMatchObject({ code: "FORBIDDEN", details: { action: "services.create" } });
    grant(panel, member.user.id, "project", blog, ["*"]);
    const impact = await callOp(panel, serviceOps.moveProjectImpact, { serviceId: id, projectId: blog }, { cookie: member.cookie });
    expect(impact.body.blockers.map((b: { reason: string }) => b.reason)).toEqual(["access"]);
    const partial = await callOp(
      panel,
      serviceOps.moveProject,
      { serviceId: id, projectId: blog, confirm: true },
      { cookie: member.cookie },
    );
    expect(partial.body.error).toMatchObject({ code: "FORBIDDEN", details: { reason: "access" } });
    expect(row(id)?.projectId).toBe(shop);

    regrant(member.user.id, "service", id, ["*"]);
    // Their own grant on the service goes too, so it needs a confirm; the project grant carries them on.
    const unconfirmed = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog }, { cookie: member.cookie });
    expect(unconfirmed.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "confirm" } });
    const moved = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { cookie: member.cookie });
    expect(moved.status).toBe(200);
    expect((await callOp(panel, serviceOps.get, { serviceId: id }, { cookie: member.cookie })).status).toBe(200);
    expect(row(id)?.projectId).toBe(blog);
  });

  test("refuses without confirm when something changes; a stopped service just changes project", async () => {
    const id = await app(shop, "api");
    await app(shop, "web", { env: "API=${{api.URL}}\n" });
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view"]);
    const unconfirmed = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog }, { cookie });
    expect(unconfirmed.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "confirm" } });

    const res = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.deploymentId).toBeNull();
    expect(row(id)?.projectId).toBe(blog);
    // Access follows the new project: the grant on the service is gone.
    expect(panel.deps.db.select().from(grants).where(eq(grants.scopeId, id)).all()).toEqual([]);
    expect((await callOp(panel, serviceOps.get, { serviceId: id }, { cookie: member.cookie })).body.error.code).toBe("FORBIDDEN");
  });

  test("a running service switches like a deploy and stays in the new project", async () => {
    const id = await app(shop, "api");
    const gen = await deployLive(id);
    const res = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.impact.switches).toBe(true);
    await fleet.settle();
    const d = (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie })).body.deployment;
    expect(d).toMatchObject({ trigger: "move", status: "deploying", generation: gen + 1 });
    // The same image again, no build; the node gets the new project.
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.id, d.id)).get()?.imageRef).toBe("nginx:1.27");
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.projectId).toBe(blog);
    fleet.deployProgress(nodeA, id, d.generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect((await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: d.id }, { cookie })).body.deployment.status).toBe("live");
    expect(row(id)?.projectId).toBe(blog);
  });

  test("a failed switch puts the service and its grants back", async () => {
    const id = await app(shop, "api");
    await deployLive(id);
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view", "logs.view"]);
    const res = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { cookie });
    expect(row(id)?.projectId).toBe(blog);
    expect(panel.deps.db.select().from(grants).where(eq(grants.scopeId, id)).all()).toEqual([]);
    await fleet.settle();
    const d = (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie })).body.deployment;
    fleet.deployProgress(nodeA, id, d.generation, DeployStage.FAILED, "not healthy on the new network");
    await fleet.settle();
    expect((await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: d.id }, { cookie })).body.deployment.status).toBe(
      "failed",
    );
    expect(row(id)?.projectId).toBe(shop);
    const restored = panel.deps.db.select().from(grants).where(eq(grants.scopeId, id)).all();
    expect(restored.map((g) => [g.userId, g.actions])).toEqual([[member.user.id, ["services.view", "logs.view"]]]);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.projectId).toBe(shop);
  });

  test("a cancelled switch puts the service, its grants and invites back", async () => {
    const id = await app(shop, "api");
    await deployLive(id);
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view", "logs.view"]);
    const invite = panel.deps.db
      .insert(invites)
      .values({
        email: "sam@example.com",
        grants: [{ scopeType: "service", scopeId: id, actions: ["services.view"] }],
        tokenHash: "x",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning()
      .get();
    const inviteGrants = () => panel.deps.db.select().from(invites).where(eq(invites.id, invite.id)).get()?.grants;
    const res = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { cookie });
    expect(res.status).toBe(200);
    await fleet.settle();
    expect(row(id)?.projectId).toBe(blog);
    expect(panel.deps.db.select().from(grants).where(eq(grants.scopeId, id)).all()).toEqual([]);
    expect(inviteGrants()).toEqual([]);

    const cancelled = await callOp(panel, deploymentOps.cancel, { serviceId: id, deploymentId: res.body.deploymentId }, { cookie });
    expect(cancelled.status).toBe(200);
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.id, res.body.deploymentId)).get()?.status).toBe("cancelled");
    expect(row(id)?.projectId).toBe(shop);
    const restored = panel.deps.db.select().from(grants).where(eq(grants.scopeId, id)).all();
    expect(restored.map((g) => [g.userId, g.actions])).toEqual([[member.user.id, ["services.view", "logs.view"]]]);
    expect(inviteGrants()).toEqual([{ scopeType: "service", scopeId: id, actions: ["services.view"] }]);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, id, nodeA)?.projectId).toBe(shop);
    expect((await callOp(panel, serviceOps.get, { serviceId: id }, { cookie: member.cookie })).status).toBe(200);
  });

  test("the node keeps the old project until the switch deployment ships", async () => {
    const id = await app(shop, "api");
    const gen = await deployLive(id);
    // Hold the switch in the queue, as if the engine had not reached it yet.
    panel.deps.db.run(
      sql.raw(
        `CREATE TEMP TRIGGER hold_move AFTER INSERT ON deployments WHEN NEW."trigger" = 'move' BEGIN UPDATE deployments SET move_copying = 1 WHERE id = NEW.id; END`,
      ),
    );
    const res = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { cookie });
    expect(res.status).toBe(200);
    await fleet.settle();
    const deploymentId = res.body.deploymentId as string;
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get()?.status).toBe("queued");
    expect(row(id)?.projectId).toBe(blog);

    // Something else changes on the node and its desired state is compiled again meanwhile.
    panel.deps.agents.desired.markDirty({ nodeId: nodeA });
    await fleet.settle();
    const compile = () => compileDesiredState(panel.deps.db, nodeA, { revision: 1n, secrets: panel.deps.secrets });
    const held = compile();
    expect(held.services.find((s) => s.id === id)).toMatchObject({ projectId: shop, generation: BigInt(gen) });
    expect(held.networks.map((n) => n.projectId)).toEqual([shop]);

    // The engine reaches it: the switch ships with the new project.
    panel.deps.db.run(sql.raw("DROP TRIGGER hold_move"));
    panel.deps.db.update(deployments).set({ moveCopying: false }).where(eq(deployments.id, deploymentId)).run();
    engineFor(panel.deps).kick(deploymentId);
    await fleet.settle();
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get()?.status).toBe("deploying");
    const shipped = compile();
    expect(shipped.services.find((s) => s.id === id)).toMatchObject({ projectId: blog, generation: BigInt(gen + 1) });
    expect(shipped.networks.map((n) => n.projectId)).toEqual([blog]);
  });

  test("protected services and compose members cannot move", async () => {
    const id = await app(shop, "api");
    panel.deps.db.update(services).set({ protected: true }).where(eq(services.id, id)).run();
    const res = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { cookie });
    expect(res.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "protected" } });
  });
});

describe("references waiting for a name", () => {
  test("a move is blocked when the new project already reads the service's values; addresses are fine", async () => {
    const id = await app(shop, "api", { env: "SECRET=s3cret\n" });
    const front = await app(blog, "front", { env: "API=${{api.INTERNAL_URL}}\n" });
    const ok = await callOp(panel, serviceOps.moveProjectImpact, { serviceId: id, projectId: blog }, { cookie });
    expect(ok.body.blockers).toEqual([]);
    await callOp(panel, env.set, { serviceId: front, text: "API=${{api.INTERNAL_URL}}\nLEAK=${{api.SECRET}}\n" }, { cookie });
    const blocked = await callOp(panel, serviceOps.moveProjectImpact, { serviceId: id, projectId: blog }, { cookie });
    expect(blocked.body.blockers).toEqual([
      {
        reason: "references",
        message:
          "front (LEAK) in blog already references api.SECRET, which would start reading this service's values. Remove that reference first.",
      },
    ]);
    const move = await callOp(panel, serviceOps.moveProject, { serviceId: id, projectId: blog, confirm: true }, { cookie });
    expect(move.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "references" } });
  });

  test("a clone's suggested name avoids them, a chosen one is refused", async () => {
    const id = await app(shop, "api");
    await app(blog, "front", { env: "TOKEN=${{api-copy.TOKEN}}\n" });
    const preview = await callOp(panel, serviceOps.clonePreview, { serviceId: id, projectId: blog }, { cookie });
    expect(preview.body.name).toBe("api-copy-2");
    const named = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeA, name: "api-copy" }, { cookie });
    expect(named.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "references", field: "name" } });
  });
});

describe("data copy guards", () => {
  test("stopping the source needs services.control; copying without a stop does not", async () => {
    const id = await app(shop, "files", { volumes: [{ name: "data", mountPath: "/data" }] });
    await deployLive(id);
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", id, ["services.view", "files.read"]);
    grant(panel, member.user.id, "project", blog, ["services.create", "services.view"]);
    const stopping = await callOp(
      panel,
      serviceOps.clone,
      { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy" },
      { cookie: member.cookie },
    );
    expect(stopping.body.error).toMatchObject({ code: "FORBIDDEN", details: { action: "services.control" } });
    const live = await callOp(
      panel,
      serviceOps.clone,
      { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy", stopSource: false },
      { cookie: member.cookie },
    );
    expect(live.status).toBe(200);
    expect(live.body.dataCopy).toMatchObject({ status: "queued" });
    // One copy from a source at a time.
    const second = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy" }, { cookie });
    expect(second.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "copying" } });
  });

  test("a Box being copied cannot be opened, and a service being copied cannot change node", async () => {
    const box = await callOp(panel, boxOps.create, { projectId: shop, name: "dev", nodeId: nodeA }, { cookie });
    expect(box.status).toBe(200);
    const boxId = box.body.serviceId as string;
    await fleet.settle();
    const boxClone = await callOp(panel, serviceOps.clone, { serviceId: boxId, projectId: shop, nodeId: nodeA, data: "copy" }, { cookie });
    expect(boxClone.status).toBe(200);
    const copying = { code: "CONFLICT", details: { reason: "copying" } };
    // Opening starts a Box: not the source the copy stops, not the clone it writes.
    expect((await callOp(panel, boxOps.open, { serviceId: boxId }, { cookie })).body.error).toMatchObject(copying);
    expect((await callOp(panel, boxOps.open, { serviceId: boxClone.body.service.id }, { cookie })).body.error).toMatchObject(copying);
    expect(row(boxClone.body.service.id)?.stopped).toBe(true);

    const id = await app(shop, "files", { volumes: [{ name: "data", mountPath: "/data" }] });
    await deployLive(id);
    // Even a copy that leaves the source running reads its folder on node-a.
    const res = await callOp(
      panel,
      serviceOps.clone,
      { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy", stopSource: false },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect((await callOp(panel, serviceOps.move, { serviceId: id, toNodeId: nodeB }, { cookie })).body.error).toMatchObject(copying);
    const cloneMove = await callOp(panel, serviceOps.move, { serviceId: res.body.service.id, toNodeId: nodeA }, { cookie });
    expect(cloneMove.body.error).toMatchObject(copying);
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.trigger, "move")).all()).toEqual([]);
  });

  test("a clone deleted while its copy waits still gets its source started again", async () => {
    const id = await app(shop, "files", { volumes: [{ name: "data", mountPath: "/data" }] });
    await deployLive(id);
    const res = await callOp(panel, serviceOps.clone, { serviceId: id, projectId: blog, nodeId: nodeB, data: "copy" }, { cookie });
    const cloneId = res.body.service.id as string;
    // The copy stopped the source (as after a panel restart mid-copy), then the clone goes.
    panel.deps.db.update(services).set({ stopped: true }).where(eq(services.id, id)).run();
    panel.deps.db.update(serviceCopies).set({ status: "copying", sourceStopped: true }).where(eq(serviceCopies.serviceId, cloneId)).run();
    expect((await callOp(panel, serviceOps.remove, { serviceId: cloneId, confirmName: "files-copy" }, { cookie })).status).toBe(200);
    await panel.runner.runDue(panel.deps);
    await fleet.settle();
    expect(row(id)?.stopped).toBe(false);
  });
});
