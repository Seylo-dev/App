// Any image of a database's engine (0.2.11): databases.create and
// databases.setVersion take any tag or digest of the engine's own
// repository. Only another repository, no node, a stopped database, a
// running deploy and the image that runs are refused; every other change
// the rules would not make is a risk the caller accepts (acceptRisk), the
// backup rule holds for all but a newer patch, and the line recorded is the
// one the tag names, or "custom".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { databases as dbOps, services as serviceOps, serviceTransfer as transferOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import {
  type DatabaseEngine,
  deploymentLogs,
  deployments,
  nodes,
  serviceDatabases,
  servicePlacements,
  services,
  volumes,
} from "../src/db/schema";
import { databaseRuntime } from "../src/modules/databases/desired";
import { enginesCapability, engineVersions, exposureRefusal } from "../src/modules/databases/engines";
import { customLine, dataPathOf, engineImage, importedVersion } from "../src/modules/databases/images";
import {
  type ImagePoint,
  judgeImage,
  nativePasswordCheckNeeded,
  nativePasswordGoneRefusal,
  riskOrder,
} from "../src/modules/databases/version";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, settleDeploys } from "./seed-helpers";
import { begin, closeSides, exportZip, side } from "./transfer-helpers";

/** A catalog line as an ImagePoint. */
function point(engine: DatabaseEngine, version: string, variant: string | null = null): ImagePoint {
  const line = engineVersions(engine, variant)?.find((v) => v.version === version);
  if (!line) throw new Error(`${engine} ${version} is not in the catalog`);
  return { version: line.version, image: line.image, dataPath: line.dataPath };
}
/** An image as setVersion takes it. */
function image(engine: DatabaseEngine, ref: string, variant: string | null = null): ImagePoint {
  const parsed = engineImage(engine, variant, ref);
  return {
    version: parsed.version,
    image: parsed.image,
    dataPath: parsed.dataPath,
    floating: parsed.floating,
    digest: parsed.digest !== null,
  };
}
const lines = (engine: DatabaseEngine, variant: string | null = null) => (engineVersions(engine, variant) ?? []).map((v) => v.version);
const judge = (engine: DatabaseEngine, from: ImagePoint, to: ImagePoint, variant: string | null = null) =>
  judgeImage(engine, from, to, lines(engine, variant));
const digest = `sha256:${"d".repeat(64)}`;

describe("any image of the engine", () => {
  test("the engine's own repository with any tag or digest, docker.io and library/ left out; the line its tag names", () => {
    const read = (engine: DatabaseEngine, ref: string, variant: string | null = null) => {
      const p = engineImage(engine, variant, ref);
      return [p.image, p.version, p.floating];
    };
    expect(read("mongo", "mongo:8.2.12")).toEqual(["mongo:8.2.12", "8.2", false]);
    expect(read("mongo", "docker.io/library/mongo:8.2.12")).toEqual(["mongo:8.2.12", "8.2", false]);
    expect(read("mongo", "library/mongo:4.0.28")).toEqual(["mongo:4.0.28", "4.0", false]);
    expect(read("mongo", "mongo:8.2")).toEqual(["mongo:8.2", "8.2", true]);
    expect(read("mongo", "mongo:8")).toEqual(["mongo:8", customLine, true]);
    expect(read("mongo", "mongo:latest")).toEqual(["mongo:latest", customLine, true]);
    // A bare repository is its latest tag.
    expect(read("mongo", "mongo")).toEqual(["mongo:latest", customLine, true]);
    expect(read("mongo", `mongo@${digest}`)).toEqual([`mongo@${digest}`, customLine, false]);
    expect(read("mongo", `mongo:8.2.12@${digest}`)).toEqual([`mongo:8.2.12@${digest}`, "8.2", false]);
    // The catalog's own image is its line.
    const mongo80 = point("mongo", "8.0").image;
    expect(read("mongo", mongo80)).toEqual([mongo80, "8.0", false]);
    expect(read("postgres", "postgres:17.7-alpine")).toEqual(["postgres:17.7-alpine", "17", false]);
    expect(read("postgres", "postgres:17-alpine")).toEqual(["postgres:17-alpine", "17", true]);
    expect(read("postgres", "postgres:9.6.24")).toEqual(["postgres:9.6.24", "9.6", false]);
    expect(read("postgres", "pgvector/pgvector:0.8.1-pg16-bookworm", "pgvector")).toEqual([
      "pgvector/pgvector:0.8.1-pg16-bookworm",
      "16",
      false,
    ]);
    expect(read("postgres", "pgvector/pgvector:pg14", "pgvector")).toEqual(["pgvector/pgvector:pg14", "14", true]);
    expect(read("mysql", "mysql:9.1.0")).toEqual(["mysql:9.1.0", "9.1", false]);
    expect(read("mariadb", "mariadb:10.6.21")).toEqual(["mariadb:10.6.21", "10.6", false]);
    expect(read("redis", "redis:8.0.3-alpine")).toEqual(["redis:8.0.3-alpine", "8.0", false]);
    expect(read("valkey", "docker.io/valkey/valkey:8.0.6")).toEqual(["valkey/valkey:8.0.6", "8.0", false]);
    expect(read("clickhouse", "clickhouse/clickhouse-server:25.8.2.29")).toEqual(["clickhouse/clickhouse-server:25.8.2.29", "25.8", false]);
    expect(read("clickhouse", "clickhouse/clickhouse-server:25.8")).toEqual(["clickhouse/clickhouse-server:25.8", "25.8", true]);
    expect(read("keydb", "eqalpha/keydb:x86_64_v6.3.4")).toEqual(["eqalpha/keydb:x86_64_v6.3.4", "6.3", false]);
    expect(read("dragonfly", "ghcr.io/dragonflydb/dragonfly:v1.34.1")).toEqual(["ghcr.io/dragonflydb/dragonfly:v1.34.1", "1.34", false]);

    const refused = (engine: DatabaseEngine, ref: string, variant: string | null = null) => {
      try {
        engineImage(engine, variant, ref);
        return null;
      } catch (error) {
        return (error as { code: string; details?: Record<string, string> }).details;
      }
    };
    for (const [engine, ref, variant] of [
      ["mongo", "bitnami/mongodb:8.0.4", null],
      ["mongo", "ghcr.io/acme/mongo:8.0.40", null],
      ["mongo", "localhost:5000/mongo:8.0.40", null],
      ["mongo", "mongo: 8.0", null],
      ["postgres", "pgvector/pgvector:0.8.8-pg17", null],
      ["postgres", "postgres:17.7", "pgvector"],
      ["redis", "valkey/valkey:8.1.11", null],
      ["dragonfly", "docker.io/dragonflydb/dragonfly:v1.34.1", null],
      ["keydb", "redis:7.4.5", null],
    ] as const) {
      expect({ ref, details: refused(engine, ref, variant) }).toEqual({ ref, details: { field: "image", reason: "customImage" } });
    }
  });

  test("a line outside the catalog keeps its data where the engine does", () => {
    expect(dataPathOf("mongo", "8.2", null)).toBe("/data/db");
    expect(dataPathOf("postgres", "14", null)).toBe("/var/lib/postgresql/data");
    expect(dataPathOf("postgres", "9.6", null)).toBe("/var/lib/postgresql/data");
    expect(dataPathOf("postgres", "19", null)).toBe("/var/lib/postgresql");
    expect(dataPathOf("postgres", customLine, null)).toBe("/var/lib/postgresql");
    expect(dataPathOf("postgres", "14", "pgvector")).toBe("/var/lib/postgresql/data");
    expect(dataPathOf("clickhouse", customLine, null)).toBe("/var/lib/clickhouse");
  });

  test("the rules' refusals are risks; only the image that runs is refused", () => {
    const risk = (j: { allowed: boolean; reason?: string; risk?: string; risks: string[] }) => [j.allowed, j.reason ?? null, j.risks];
    const mongo80 = point("mongo", "8.0");
    expect(risk(judge("mongo", mongo80, mongo80))).toEqual([false, "current", []]);
    expect(risk(judge("mongo", mongo80, image("mongo", mongo80.image)))).toEqual([false, "current", []]);
    expect(risk(judge("mongo", mongo80, point("mongo", "7.0")))).toEqual([true, null, ["downgrade"]]);
    expect(risk(judge("mongo", mongo80, image("mongo", "mongo:8.0.1")))).toEqual([true, null, ["olderImage"]]);
    expect(risk(judge("mongo", point("mongo", "7.0"), point("mongo", "9.0")))).toEqual([true, null, ["oneStep"]]);
    expect(risk(judge("postgres", point("postgres", "17"), point("postgres", "18")))).toEqual([true, null, ["postgresMajor", "dataPath"]]);
    expect(risk(judge("postgres", point("postgres", "17"), image("postgres", "postgres:17.9-bookworm")))).toEqual([
      true,
      null,
      ["postgresBase"],
    ]);
    const keydb = point("keydb", "6.3");
    expect(risk(judge("keydb", keydb, image("keydb", "eqalpha/keydb:x86_64_v6.4.0")))).toEqual([true, null, ["patchOnly", "otherLine"]]);
    // A newer patch, from the catalog's image or another tag, takes no risk.
    expect(risk(judge("mongo", mongo80, image("mongo", "mongo:8.0.99")))).toEqual([true, null, []]);
    expect(risk(judge("mongo", point("mongo", "7.0"), point("mongo", "8.0")))).toEqual([true, null, []]);
    expect(risk(judge("keydb", keydb, image("keydb", "eqalpha/keydb:x86_64_v6.3.4")))).toEqual([true, null, []]);
    // Every refusal of the rules (and the rest) is a risk name the contract documents.
    for (const r of ["downgrade", "olderImage", "postgresMajor", "oneStep", "patchOnly", "dataPath"])
      expect(riskOrder).toContain(r as never);
  });

  test("lines outside the catalog, floating tags and digests are risks, judged as far as the tag tells", () => {
    const mongo80 = point("mongo", "8.0");
    // 8.2 is no catalog line: not tested by Seylo, and the catalog's one-step rule says nothing about it.
    const to82 = judge("mongo", mongo80, image("mongo", "mongo:8.2.12"));
    expect(to82).toMatchObject({ kind: "upgrade", allowed: true, risk: "otherLine", risks: ["otherLine"] });
    expect(to82.message).toContain("MongoDB 8.2 is not in Seylo's catalog");
    expect(to82.message).toContain("MongoDB may refuse data whose featureCompatibilityVersion it does not support");
    expect(to82.message).toContain("the old container comes back");
    // From an off-catalog line to the next catalog one is no tested step either.
    const from82 = image("mongo", "mongo:8.2.12");
    expect(judge("mongo", from82, point("mongo", "9.0")).risks).toEqual(["otherLine"]);
    expect(judge("mongo", from82, mongo80).risks).toEqual(["downgrade", "otherLine"]);
    // Patches of the off-catalog line it runs take none.
    expect(judge("mongo", from82, image("mongo", "mongo:8.2.13")).risks).toEqual([]);
    expect(judge("mongo", from82, image("mongo", "mongo:8.2.11")).risks).toEqual(["olderImage"]);
    // mongo:8.2 is a floating tag of a line outside the catalog.
    expect(judge("mongo", mongo80, image("mongo", "mongo:8.2")).risks).toEqual(["otherLine", "floatingTag"]);
    // A floating tag of the same line has no release to compare.
    expect(judge("mongo", mongo80, image("mongo", "mongo:8.0")).risks).toEqual(["floatingTag"]);
    // latest and a bare digest say nothing about the line.
    const latest = judge("mongo", mongo80, image("mongo", "mongo:latest"));
    expect(latest).toMatchObject({ kind: "upgrade", allowed: true, risk: "floatingTag" });
    expect(latest.message).toContain("mongo:latest is a floating tag");
    expect(judge("mongo", mongo80, image("mongo", `mongo@${digest}`)).risks).toEqual(["digest"]);
    expect(judge("mongo", mongo80, image("mongo", `mongo:8.0.99@${digest}`)).risks).toEqual(["digest"]);
    // What runs can be the unknown side too: every change from it is a risk.
    const runsLatest = image("mongo", "mongo:latest");
    const back = judge("mongo", runsLatest, mongo80);
    expect(back.risks).toEqual(["floatingTag"]);
    expect(back.message).toContain("mongo:latest, which runs, is a floating tag");
    expect(judge("mongo", image("mongo", `mongo@${digest}`), mongo80).risks).toEqual(["digest"]);
    // The most serious risk leads.
    expect(judge("postgres", point("postgres", "17"), image("postgres", "postgres:16.4")).risk).toBe("downgrade");
  });

  test("an off-catalog MariaDB line without TLS of its own is not exposed; one with it is", () => {
    expect(exposureRefusal({ engine: "mariadb", version: "10.6", variant: null })).toContain("MariaDB 10.6 has no TLS");
    expect(exposureRefusal({ engine: "mariadb", version: "11.2", variant: null })).toContain("MariaDB 11.2 has no TLS");
    expect(exposureRefusal({ engine: "mariadb", version: "11.6", variant: null })).toBeNull();
    expect(exposureRefusal({ engine: "mariadb", version: "12.0", variant: null })).toBeNull();
    expect(exposureRefusal({ engine: "mariadb", version: customLine, variant: null })).toBeNull();
    expect(exposureRefusal({ engine: "mongo", version: "8.2", variant: null })).toBeNull();
    expect(exposureRefusal({ engine: "mariadb", version: "10.11", variant: null })).toContain("MariaDB 10.11 has no TLS");
  });

  test("MySQL lists the mysql_native_password accounts for any change to 8.4 or later", () => {
    const plan = { on: false, check: false };
    expect(nativePasswordCheckNeeded("mysql", [], "8.0", "9.1", plan)).toBe(true);
    expect(nativePasswordCheckNeeded("mysql", [], "8.0", customLine, plan)).toBe(true);
    expect(nativePasswordCheckNeeded("mysql", [], "5.7", "8.4", plan)).toBe(true);
    // 8.4 run with the plugin on, to 9.1 which has none.
    expect(nativePasswordCheckNeeded("mysql", ["mysqld", "--mysql-native-password=ON"], "8.4", "9.1", plan)).toBe(true);
    expect(nativePasswordCheckNeeded("mysql", [], "8.4", "9.1", plan)).toBe(false);
    expect(nativePasswordCheckNeeded("mysql", [], "8.0", "8.3", plan)).toBe(false);
    expect(nativePasswordCheckNeeded("mysql", [], "8.0", "8.4", { on: true, check: false })).toBe(false);
    expect(nativePasswordCheckNeeded("mysql", [], "8.0", "8.4", { on: false, check: true })).toBe(true);
    expect(nativePasswordCheckNeeded("mariadb", [], "10.11", "11.4", plan)).toBe(false);
    const gone = nativePasswordGoneRefusal(["legacy@%"], "9.1");
    expect(gone.details).toEqual({ reason: "nativePasswordUsers", accounts: "legacy@%", count: "1" });
    expect(gone.message).toContain("a plugin MySQL 9.1 does not have");
    expect(gone.message).not.toContain("keepNativePassword");
  });

  test("an imported database of a line outside the catalog starts on the image it ran", () => {
    expect(importedVersion("mongo", "8.2", null, "mongo:8.2.12")).toEqual({ version: "8.2", image: "mongo:8.2.12", dataPath: "/data/db" });
    expect(importedVersion("mongo", customLine, null, "mongo:latest")).toEqual({
      version: customLine,
      image: "mongo:latest",
      dataPath: "/data/db",
    });
    expect(importedVersion("postgres", "14", null, "postgres:14.13-alpine")).toEqual({
      version: "14",
      image: "postgres:14.13-alpine",
      dataPath: "/var/lib/postgresql/data",
    });
    // The catalog's line wins; an image that names another line or repository is no way in.
    expect(importedVersion("mongo", "8.0", null, "mongo:8.2.12")?.image).toBe(point("mongo", "8.0").image);
    expect(importedVersion("mongo", "8.2", null, "mongo:8.3.0")).toBeNull();
    expect(importedVersion("mongo", "8.2", null, "bitnami/mongodb:8.2.1")).toBeNull();
    expect(importedVersion("mongo", "8.2", null, null)).toBeNull();
  });
});

describe("databases.setVersion and create with any image", () => {
  let panel: TestPanel;
  let cookie: string;
  beforeEach(async () => {
    panel = testPanel();
    cookie = (await createUser(panel, "owner")).cookie;
  });
  afterEach(async () => {
    await settleDeploys(panel);
    panel.close();
  });

  function seedPlace() {
    const project = seedProject(panel);
    const node = seedNode(panel);
    panel.deps.db
      .update(nodes)
      .set({ facts: { capabilities: [enginesCapability] } })
      .where(eq(nodes.id, node.id))
      .run();
    return { project, node };
  }

  async function createDb(engine: DatabaseEngine, version: string) {
    const { project, node } = seedPlace();
    const res = await callOp(panel, dbOps.create, { projectId: project.id, name: "shop-db", engine, version, nodeId: node.id }, { cookie });
    expect(res.status).toBe(200);
    await settleDeploys(panel);
    goLive(res.body.serviceId);
    return { node, serviceId: res.body.serviceId as string };
  }

  /** Ends the service's open deploys as if its node reported them healthy, running the spec's image. */
  function goLive(serviceId: string) {
    const rows = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).all();
    for (const d of rows) {
      if (["live", "failed", "cancelled", "superseded"].includes(d.status)) continue;
      panel.deps.db.update(deployments).set({ status: "live", finishedAt: new Date() }).where(eq(deployments.id, d.id)).run();
    }
    const newest = rows.sort((a, b) => b.generation - a.generation)[0];
    if (newest) {
      panel.deps.db
        .update(deployments)
        .set({ imageRef: specImage(serviceId) })
        .where(eq(deployments.id, newest.id))
        .run();
      panel.deps.db
        .update(services)
        .set({ liveDeploymentId: newest.id, targetDeploymentId: newest.id })
        .where(eq(services.id, serviceId))
        .run();
    }
  }

  const specImage = (serviceId: string) => {
    const spec = panel.deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, serviceId)).get()?.spec as
      | { source: { image: string } }
      | undefined;
    return spec?.source.image ?? "";
  };
  const dbVersion = (serviceId: string) =>
    panel.deps.db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, serviceId)).get()?.version;
  const deployCount = (serviceId: string) =>
    panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).all().length;
  type Res = { status: number; body: { error: { message: string; details: Record<string, string> } } };
  const refusal = (res: Res): Record<string, unknown> => ({ status: res.status, ...res.body.error.details });

  test("a risk is refused until it is accepted, with what can go wrong; then it deploys and records the line", async () => {
    const { serviceId, node } = await createDb("mongo", "8.0");
    const execs: unknown[] = [];
    const agent = fakeAgent(panel, node.id, {
      exec: (req: unknown) => {
        execs.push(req);
        return { exitCode: 0 };
      },
    });
    const before = deployCount(serviceId);
    const res = (await callOp(panel, dbOps.setVersion, { serviceId, image: "mongo:8.2.12" }, { cookie })) as Res;
    expect(refusal(res)).toEqual({
      status: 409,
      reason: "riskNotAccepted",
      risk: "otherLine",
      risks: "otherLine",
      message: expect.stringContaining("MongoDB 8.2 is not in Seylo's catalog"),
      version: "8.2",
      image: "mongo:8.2.12",
      backupRequired: "true",
    });
    expect(res.body.error.message).toContain("Nothing changed: accept the risk (acceptRisk) to go ahead.");
    // Accepted, the backup rule still holds: this is no newer patch of the line it runs.
    const noBackup = (await callOp(panel, dbOps.setVersion, { serviceId, image: "mongo:8.2.12", acceptRisk: true }, { cookie })) as Res;
    expect(refusal(noBackup)).toMatchObject({ status: 409, reason: "backupRequired" });
    expect({ version: dbVersion(serviceId), image: specImage(serviceId), deploys: deployCount(serviceId) }).toEqual({
      version: "8.0",
      image: point("mongo", "8.0").image,
      deploys: before,
    });

    const done = await callOp(
      panel,
      dbOps.setVersion,
      { serviceId, image: "mongo:8.2.12", acceptRisk: true, confirmNoBackup: true },
      { cookie },
    );
    expect(done.status).toBe(200);
    expect(done.body.database.version).toBe("8.2");
    expect(dbVersion(serviceId)).toBe("8.2");
    expect(specImage(serviceId)).toBe("mongo:8.2.12");
    expect(deployCount(serviceId)).toBe(before + 1);
    // No featureCompatibilityVersion step for a move outside the catalog's one-step upgrades.
    expect(execs).toEqual([]);
    agent.disconnect();
    const log = panel.deps.db.select().from(deploymentLogs).where(eq(deploymentLogs.deploymentId, done.body.deploymentId)).all();
    expect(log.map((l) => l.text)).toContain("Risk accepted: otherLine.");

    // Once it runs, the database reads as 8.2 everywhere: the choices, the agent's spec, the volume.
    await settleDeploys(panel);
    goLive(serviceId);
    const choices = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(choices.body).toMatchObject({ version: "8.2", image: "mongo:8.2.12", release: "8.2.12", pendingImage: null, anyImage: true });
    expect(
      choices.body.choices.map((c: { version: string; allowed: boolean; risk?: string }) => [c.version, c.allowed, c.risk ?? null]),
    ).toEqual([
      ["9.0", true, "otherLine"],
      ["8.0", true, "downgrade"],
      ["7.0", true, "downgrade"],
    ]);
    expect(databaseRuntime(panel.deps, serviceId)?.database.version).toBe("8.2");
    expect(panel.deps.db.select().from(volumes).where(eq(volumes.serviceId, serviceId)).get()?.mountPath).toBe("/data/db");
    const got = await callOp(panel, dbOps.get, { serviceId }, { cookie });
    expect(got.body.version).toBe("8.2");
    // A newer patch of the off-catalog line it runs takes no risk and no backup.
    const patch = await callOp(panel, dbOps.setVersion, { serviceId, image: "mongo:8.2.13" }, { cookie });
    expect(patch.status).toBe(200);
  });

  test("each risk needs acceptRisk: a downgrade, an older patch, latest and a digest, then each goes", async () => {
    const { serviceId, node } = await createDb("mongo", "8.0");
    const agent = fakeAgent(panel, node.id, { exec: () => ({ exitCode: 0 }) });
    const catalog = point("mongo", "8.0").image;
    for (const [input, risk, version] of [
      [{ version: "7.0" }, "downgrade", "7.0"],
      [{ image: "mongo:8.0.1" }, "olderImage", "8.0"],
      [{ image: "mongo:latest" }, "floatingTag", customLine],
      [{ image: `mongo@${digest}` }, "digest", customLine],
    ] as const) {
      const refused = (await callOp(panel, dbOps.setVersion, { serviceId, ...input, confirmNoBackup: true }, { cookie })) as Res;
      expect({ input, ...refusal(refused) }).toMatchObject({ input, status: 409, reason: "riskNotAccepted", risk, version });
      expect(specImage(serviceId)).toBe(catalog);
      const done = await callOp(panel, dbOps.setVersion, { serviceId, ...input, confirmNoBackup: true, acceptRisk: true }, { cookie });
      expect({ input, status: done.status, version: done.body.database?.version }).toEqual({ input, status: 200, version });
      // Back where it started for the next one: the old container came back.
      await settleDeploys(panel);
      panel.deps.db.update(serviceDatabases).set({ version: "8.0" }).where(eq(serviceDatabases.serviceId, serviceId)).run();
      const row = panel.deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, serviceId)).get();
      const spec = row?.spec as { source: Record<string, unknown> };
      panel.deps.db
        .update(services)
        .set({ spec: { ...spec, source: { ...spec.source, image: catalog } } })
        .where(eq(services.id, serviceId))
        .run();
      goLive(serviceId);
    }
    agent.disconnect();
  });

  test("hard refusals stay hard with acceptRisk: another repository, the image that runs, stopped, deploying, no node", async () => {
    const { serviceId } = await createDb("mongo", "8.0");
    const all = { acceptRisk: true, confirmNoBackup: true };
    const other = (await callOp(panel, dbOps.setVersion, { serviceId, image: "bitnami/mongodb:8.0.4", ...all }, { cookie })) as Res;
    expect(refusal(other)).toMatchObject({ status: 400, field: "image", reason: "customImage" });
    expect(other.body.error.message).toContain("Use an image of mongo");
    const same = (await callOp(panel, dbOps.setVersion, { serviceId, image: point("mongo", "8.0").image, ...all }, { cookie })) as Res;
    expect(refusal(same)).toMatchObject({ status: 409, reason: "current" });
    const neither = (await callOp(panel, dbOps.setVersion, { serviceId, ...all }, { cookie })) as Res;
    expect(refusal(neither)).toMatchObject({ status: 400, field: "version" });

    panel.deps.db.update(services).set({ stopped: true }).where(eq(services.id, serviceId)).run();
    const stopped = (await callOp(panel, dbOps.setVersion, { serviceId, image: "mongo:latest", ...all }, { cookie })) as Res;
    expect(refusal(stopped)).toMatchObject({ status: 409, reason: "stopped" });
    panel.deps.db.update(services).set({ stopped: false }).where(eq(services.id, serviceId)).run();

    expect((await callOp(panel, dbOps.setVersion, { serviceId, image: "mongo:latest", ...all }, { cookie })).status).toBe(200);
    const running = (await callOp(panel, dbOps.setVersion, { serviceId, image: "mongo:8.2.12", ...all }, { cookie })) as Res;
    expect(refusal(running)).toMatchObject({ status: 409, reason: "deployRunning" });
    await settleDeploys(panel);
    goLive(serviceId);

    panel.deps.db.delete(servicePlacements).where(eq(servicePlacements.serviceId, serviceId)).run();
    const choices = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(choices.body).toMatchObject({ version: customLine, image: "mongo:latest", release: null, blocked: { reason: "noNode" } });
    const noNode = (await callOp(panel, dbOps.setVersion, { serviceId, image: "mongo:8.2.12", ...all }, { cookie })) as Res;
    expect(refusal(noNode)).toMatchObject({ status: 409, reason: "noNode" });
  });

  test("MySQL 8.0 to 9.1, outside the catalog: the accounts on mysql_native_password are listed first", async () => {
    const { serviceId, node } = await createDb("mysql", "8.0");
    const all = { acceptRisk: true, confirmNoBackup: true };
    let accounts = ["legacy@%"];
    let execs = 0;
    const agent = fakeAgent(panel, node.id, {
      exec: () => {
        execs++;
        return { exitCode: 0, stdout: new TextEncoder().encode(accounts.map((a) => `${a}\n`).join("")) };
      },
    });
    const keep = (await callOp(
      panel,
      dbOps.setVersion,
      { serviceId, image: "mysql:9.1.0", keepNativePassword: true, ...all },
      { cookie },
    )) as Res;
    expect(refusal(keep)).toMatchObject({ status: 400, field: "keepNativePassword" });
    expect(keep.body.error.message).toBe("MySQL 9.1 has no mysql_native_password plugin to keep on: keepNativePassword is for MySQL 8.4.");
    expect(execs).toBe(0);
    const refused = (await callOp(panel, dbOps.setVersion, { serviceId, image: "mysql:9.1.0", ...all }, { cookie })) as Res;
    expect(refusal(refused)).toEqual({ status: 409, reason: "nativePasswordUsers", accounts: "legacy@%", count: "1" });
    expect(refused.body.error.message).toContain("a plugin MySQL 9.1 does not have");
    expect(execs).toBe(1);
    expect(dbVersion(serviceId)).toBe("8.0");
    accounts = [];
    const done = await callOp(panel, dbOps.setVersion, { serviceId, image: "mysql:9.1.0", ...all }, { cookie });
    expect(done.status).toBe(200);
    expect(done.body.database.version).toBe("9.1");
    expect(execs).toBe(2);
    agent.disconnect();
  });

  test("databases.create takes any image of the engine and records the line its tag names", async () => {
    const { project, node } = seedPlace();
    const create = (name: string, input: Record<string, unknown>) =>
      callOp(panel, dbOps.create, { projectId: project.id, name, nodeId: node.id, ...input } as never, { cookie });
    const mountOf = (serviceId: string) => panel.deps.db.select().from(volumes).where(eq(volumes.serviceId, serviceId)).get()?.mountPath;
    for (const [name, input, version, stored, mount] of [
      ["mongo-82", { engine: "mongo", image: "docker.io/library/mongo:8.2.12" }, "8.2", "mongo:8.2.12", "/data/db"],
      ["mongo-latest", { engine: "mongo", version: "8.0", image: "mongo:latest" }, customLine, "mongo:latest", "/data/db"],
      ["pg-14", { engine: "postgres", image: "postgres:14.13-alpine" }, "14", "postgres:14.13-alpine", "/var/lib/postgresql/data"],
      ["pg-latest", { engine: "postgres", image: "postgres:latest" }, customLine, "postgres:latest", "/var/lib/postgresql"],
      [
        "vec-16",
        { engine: "postgres", variant: "pgvector", image: "pgvector/pgvector:0.8.1-pg16" },
        "16",
        "pgvector/pgvector:0.8.1-pg16",
        "/var/lib/postgresql/data",
      ],
      ["catalog", { engine: "mongo", image: point("mongo", "7.0").image }, "7.0", point("mongo", "7.0").image, "/data/db"],
    ] as const) {
      const res = await create(name, input);
      expect({ name, status: res.status, version: res.body.version }).toEqual({ name, status: 200, version });
      expect({ name, image: specImage(res.body.serviceId), mount: mountOf(res.body.serviceId) }).toEqual({ name, image: stored, mount });
      expect(dbVersion(res.body.serviceId)).toBe(version);
    }
    for (const [name, input] of [
      ["bitnami", { engine: "mongo", image: "bitnami/mongodb:8.0.4" }],
      ["plain-pg", { engine: "postgres", variant: "pgvector", image: "postgres:17.7-alpine" }],
    ] as const) {
      const res = (await create(name, input)) as Res;
      expect({ name, ...refusal(res) }).toMatchObject({ name, status: 400, field: "image", reason: "customImage" });
    }
  });

  test("a clone of a database outside the catalog keeps its line and image", async () => {
    const { project, node } = seedPlace();
    const res = await callOp(
      panel,
      dbOps.create,
      { projectId: project.id, name: "mongo-82", engine: "mongo", image: "mongo:8.2.12", nodeId: node.id },
      { cookie },
    );
    const clone = await callOp(
      panel,
      serviceOps.clone,
      { serviceId: res.body.serviceId, projectId: project.id, nodeId: node.id, data: "empty" },
      { cookie },
    );
    expect(clone.status).toBe(200);
    expect({ version: dbVersion(clone.body.service.id), image: specImage(clone.body.service.id) }).toEqual({
      version: "8.2",
      image: "mongo:8.2.12",
    });
  });

  test("an off-catalog MariaDB without TLS of its own is not exposed", async () => {
    const { project, node } = seedPlace();
    const res = await callOp(
      panel,
      dbOps.create,
      { projectId: project.id, name: "maria-106", engine: "mariadb", image: "mariadb:10.6.21", nodeId: node.id },
      { cookie },
    );
    expect(res.body.version).toBe("10.6");
    const exposed = (await callOp(panel, dbOps.setExposure, { serviceId: res.body.serviceId, enabled: true }, { cookie })) as Res;
    expect(refusal(exposed)).toMatchObject({ status: 409, reason: "noTls" });
    expect(exposed.body.error.message).toContain("MariaDB 10.6 has no TLS");
  });
});

describe("export and import of a database outside the catalog", () => {
  afterEach(closeSides);

  test("it starts on the image it ran, as the line it was", async () => {
    const a = await side();
    const b = await side("node-b");
    const made = await callOp(
      a.panel,
      dbOps.create,
      { projectId: a.projectId, name: "docs", engine: "mongo", image: "mongo:8.2.12", nodeId: a.nodeId },
      { cookie: a.cookie },
    );
    expect(made.body.version).toBe("8.2");
    const zip = (await exportZip(a, made.body.serviceId, { volumes: [] })).bytes;
    const begun = await begin(b, zip);
    expect(begun.status).toBe(200);
    // Before 0.2.11 a line outside this panel's catalog was "not offered on this panel".
    expect(begun.body.blockers).toEqual([]);
    expect(begun.body.service.source.label).toBe("mongo:8.2.12");
    const ref = { projectId: b.projectId, importId: begun.body.importId as string };
    const imported = await callOp(b.panel, transferOps.importService, ref, { cookie: b.cookie });
    expect(imported.status).toBe(200);
    const id = imported.body.service.id as string;
    expect(b.panel.deps.db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, id)).get()?.version).toBe("8.2");
    expect(b.panel.deps.db.select().from(volumes).where(eq(volumes.serviceId, id)).get()?.mountPath).toBe("/data/db");
  });
});
