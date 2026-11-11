import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { databases as dbOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { backupRuns, type DatabaseEngine, deployments, nodes, serviceDatabases, services } from "../src/db/schema";
import { containerEnv, engines, enginesCapability, engineVersions } from "../src/modules/databases/engines";
import {
  compareVersions,
  customImage,
  imageRelease,
  judgeVersion,
  lineOfImage,
  mongoFcvExec,
  type VersionPoint,
} from "../src/modules/databases/version";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, settleDeploys } from "./seed-helpers";

/** A catalog line as a VersionPoint. */
function point(engine: DatabaseEngine, version: string, variant: string | null = null): VersionPoint {
  const line = engineVersions(engine, variant)?.find((v) => v.version === version);
  if (!line) throw new Error(`${engine} ${version} is not in the catalog`);
  return line;
}
const lines = (engine: DatabaseEngine, variant: string | null = null) => (engineVersions(engine, variant) ?? []).map((v) => v.version);
const judge = (engine: DatabaseEngine, from: string, to: string, variant: string | null = null) =>
  judgeVersion(engine, point(engine, from, variant), point(engine, to, variant), lines(engine, variant));

describe("version rules", () => {
  test("every engine: an older catalog line is refused, the same image is current, a newer pinned image is a patch", () => {
    for (const engine of Object.keys(engines) as DatabaseEngine[]) {
      for (const variant of [null, ...engines[engine].variants.map((v) => v.id)]) {
        const catalog = engineVersions(engine, variant) ?? [];
        for (const [i, newer] of catalog.entries()) {
          for (const older of catalog.slice(i + 1)) {
            expect({ engine, variant, j: judgeVersion(engine, newer, older, lines(engine, variant)) }).toMatchObject({
              j: { kind: "downgrade", allowed: false, reason: "downgrade" },
            });
          }
          expect(judgeVersion(engine, newer, newer, lines(engine, variant))).toMatchObject({
            kind: "current",
            allowed: false,
            reason: "current",
          });
          // The catalog moved on since the database was created: same line, newer image.
          const old = { ...newer, image: `${newer.image}-old` };
          expect(judgeVersion(engine, old, newer, lines(engine, variant))).toMatchObject({ kind: "patch", allowed: true });
        }
      }
    }
  });

  test("Postgres and pgvector never change major in place", () => {
    for (const variant of [null, "pgvector"]) {
      expect(judge("postgres", "17", "18", variant)).toMatchObject({ kind: "major", allowed: false, reason: "postgresMajor" });
      expect(judge("postgres", "15", "16", variant)).toMatchObject({ allowed: false, reason: "postgresMajor" });
      expect(judge("postgres", "17", "18", variant).message).toContain("dump and restore");
    }
    // pgvector images carry the extension's release first; a newer one on the same major is a patch.
    expect(
      judgeVersion(
        "postgres",
        { ...point("postgres", "17", "pgvector"), image: "pgvector/pgvector:0.8.0-pg17" },
        point("postgres", "17", "pgvector"),
        [],
      ),
    ).toMatchObject({ kind: "patch", allowed: true });
  });

  test("MySQL 8.0 to 8.4, MariaDB and MongoDB one line at a time", () => {
    expect(judge("mysql", "8.0", "8.4")).toMatchObject({ kind: "upgrade", allowed: true });
    expect(judge("mariadb", "10.11", "11.4")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("mariadb", "11.4", "11.8")).toMatchObject({ kind: "upgrade", allowed: true });
    expect(judge("mariadb", "10.11", "11.8")).toMatchObject({ allowed: false, reason: "oneStep" });
    expect(judge("mariadb", "10.11", "11.8").message).toContain("go to 11.4 first");
    expect(judge("mongo", "7.0", "8.0")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("mongo", "8.0", "9.0")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("mongo", "7.0", "9.0")).toMatchObject({ allowed: false, reason: "oneStep" });
  });

  test("Redis, Valkey and ClickHouse take any newer line; KeyDB and Dragonfly patches only", () => {
    expect(judge("redis", "7.4", "8.2")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("valkey", "8.1", "9.1")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("valkey", "9.0", "9.1")).toMatchObject({ kind: "upgrade", allowed: true });
    expect(judge("clickhouse", "26.3", "26.8")).toMatchObject({ kind: "upgrade", allowed: true });
    for (const engine of ["keydb", "dragonfly"] as const) {
      const from = engines[engine].versions[0] as VersionPoint;
      const next = { ...from, version: `${Number(from.version.split(".")[0]) + 1}.0`, image: `${from.image}-next` };
      expect(judgeVersion(engine, from, next, [from.version, next.version])).toMatchObject({ allowed: false, reason: "patchOnly" });
    }
  });

  test("an older image of the same line and another data folder are refused", () => {
    const now = point("mongo", "8.0");
    expect(judgeVersion("mongo", { ...now, image: "mongo:8.0.99" }, now, lines("mongo"))).toMatchObject({
      kind: "downgrade",
      allowed: false,
      reason: "olderImage",
    });
    expect(
      judgeVersion("redis", point("redis", "7.4"), { ...point("redis", "8.2"), dataPath: "/elsewhere" }, lines("redis")),
    ).toMatchObject({
      allowed: false,
      reason: "dataPath",
    });
  });

  test("versions compare number by number; images give their release and line", () => {
    expect(compareVersions("10.11", "11.4")).toBe(-1);
    expect(compareVersions("11.10", "11.8")).toBe(1);
    expect(compareVersions("8.0", "8")).toBe(0);
    expect(imageRelease("mongo:8.0.34")).toBe("8.0.34");
    expect(imageRelease("postgres:17.6-alpine")).toBe("17.6");
    expect(imageRelease("ghcr.io/dragonflydb/dragonfly:v2.0.2")).toBe("2.0.2");
    expect(imageRelease("eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac")).toBeNull();
    expect(imageRelease("localhost:5000/mongo")).toBeNull();
    expect(lineOfImage("mongo:7.0.21", engines.mongo.versions)).toBe("7.0");
    expect(lineOfImage("mongo:8.0.34", engines.mongo.versions)).toBe("8.0");
    expect(lineOfImage("mariadb:10.11.9", engines.mariadb.versions)).toBe("10.11");
    expect(lineOfImage("pgvector/pgvector:0.8.0-pg16", engineVersions("postgres", "pgvector") ?? [])).toBe("16");
    expect(lineOfImage("mongo:6.0.1", engines.mongo.versions)).toBeNull();
  });

  test("custom images: the engine's official repository with an exact release of the line it claims", () => {
    expect(customImage("mongo", null, "8.0", "mongo:8.0.40")).toBe("mongo:8.0.40");
    expect(customImage("mongo", null, "8.0", "docker.io/library/mongo:8.0.40")).toBe("mongo:8.0.40");
    expect(customImage("postgres", null, "17", "postgres:17.7-alpine")).toBe("postgres:17.7-alpine");
    expect(customImage("postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg17-trixie")).toBe("pgvector/pgvector:0.8.8-pg17-trixie");
    expect(customImage("valkey", null, "9.1", "valkey/valkey:9.1.4-alpine")).toBe("valkey/valkey:9.1.4-alpine");
    expect(customImage("clickhouse", null, "26.8", "clickhouse/clickhouse-server:26.8.40.1")).toBe(
      "clickhouse/clickhouse-server:26.8.40.1",
    );
    const refused = (engine: DatabaseEngine, variant: string | null, version: string, image: string) => {
      try {
        customImage(engine, variant, version, image);
        return null;
      } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason ?? "thrown";
      }
    };
    for (const [engine, variant, version, image] of [
      ["mongo", null, "8.0", "mongo:latest"],
      ["mongo", null, "8.0", "mongo"],
      ["mongo", null, "8.0", "mongo:8.0"],
      ["mongo", null, "8.0", "mongo:9.0.4"],
      ["mongo", null, "8.0", "bitnami/mongodb:8.0.4"],
      ["mongo", null, "8.0", "ghcr.io/acme/mongo:8.0.40"],
      ["postgres", null, "17", "pgvector/pgvector:0.8.8-pg17"],
      ["postgres", "pgvector", "17", "postgres:17.7"],
      ["postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg18"],
      // A digest could be any version: a downgrade or a major would pass as a patch.
      ["mongo", null, "8.0", `mongo@sha256:${"a".repeat(64)}`],
      ["mongo", null, "8.0", `mongo:8.0.40@sha256:${"a".repeat(64)}`],
      ["postgres", null, "17", `postgres@sha256:${"a".repeat(64)}`],
      // Debian instead of the catalog's Alpine (or another Debian than pgvector's trixie): another C library's collation.
      ["postgres", null, "17", "postgres:17.7"],
      ["postgres", null, "17", "postgres:17.7-bookworm"],
      ["postgres", null, "17", "postgres:17.7-trixie"],
      ["postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg17"],
      ["postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg17-bookworm"],
      ["keydb", null, "6.3", "eqalpha/keydb:x86_64_v6.3.4"],
      ["dragonfly", null, "2.0", "ghcr.io/dragonflydb/dragonfly:v2.0.3"],
    ] as const) {
      expect({ image, reason: refused(engine, variant, version, image) }).toEqual({ image, reason: "customImage" });
    }
  });

  test("MongoDB's compatibility step keeps the password off the command line and fails loudly", () => {
    const exec = mongoFcvExec("root", "S3cretPassword1", "7.0");
    expect(exec.command.join(" ")).not.toContain("S3cretPassword1");
    expect(exec.stdin).toContain('admin.auth("root", "S3cretPassword1")');
    expect(exec.stdin).toContain('setFeatureCompatibilityVersion: "7.0", confirm: true');
    // mongosh reading stdin goes on after an error; quit() sets the exit code.
    expect(exec.stdin).toContain("quit(2)");
    expect(exec.stdin).toContain("quit(3)");
    expect(exec.stdin.trim().split("\n")).toHaveLength(1);
  });

  test("MariaDB containers upgrade their system tables on start; MySQL's need nothing", () => {
    const creds = { user: "root", password: "pw", database: "app" };
    expect(containerEnv("mariadb", creds)).toContainEqual({ name: "MARIADB_AUTO_UPGRADE", value: "1", secret: false });
    expect(containerEnv("mysql", creds).map((v) => v.name)).not.toContain("MYSQL_AUTO_UPGRADE");
  });
});

describe("databases.versionChoices and setVersion", () => {
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

  async function createDb(engine: DatabaseEngine, version: string) {
    const project = seedProject(panel);
    const node = seedNode(panel);
    panel.deps.db
      .update(nodes)
      .set({ facts: { capabilities: [enginesCapability] } })
      .where(eq(nodes.id, node.id))
      .run();
    const res = await callOp(panel, dbOps.create, { projectId: project.id, name: "shop-db", engine, version, nodeId: node.id }, { cookie });
    expect(res.status).toBe(200);
    // No agent answers here: the create deploy goes live by hand.
    await settleDeploys(panel);
    goLive(res.body.serviceId);
    return { node, serviceId: res.body.serviceId as string };
  }

  /** Ends the service's open deploys as if its node reported them healthy; the newest is live. */
  function goLive(serviceId: string) {
    const rows = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).all();
    for (const d of rows) {
      if (["live", "failed", "cancelled", "superseded"].includes(d.status)) continue;
      panel.deps.db.update(deployments).set({ status: "live", finishedAt: new Date() }).where(eq(deployments.id, d.id)).run();
    }
    const newest = rows.sort((a, b) => b.generation - a.generation)[0];
    if (newest) {
      panel.deps.db
        .update(services)
        .set({ liveDeploymentId: newest.id, targetDeploymentId: newest.id })
        .where(eq(services.id, serviceId))
        .run();
    }
  }

  const specImage = (serviceId: string) => {
    const spec = panel.deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, serviceId)).get()?.spec as {
      source: { image: string };
    };
    return spec.source.image;
  };
  const setImage = (serviceId: string, image: string) => {
    const row = panel.deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, serviceId)).get();
    const spec = row?.spec as { source: Record<string, unknown> };
    panel.deps.db
      .update(services)
      .set({ spec: { ...spec, source: { ...spec.source, image } } })
      .where(eq(services.id, serviceId))
      .run();
  };
  const deployCount = (serviceId: string) =>
    panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).all().length;
  const backup = (serviceId: string, finishedAt: Date) =>
    panel.deps.db
      .insert(backupRuns)
      .values({ serviceId, kind: "backup", target: "database", status: "succeeded", startedAt: finishedAt, finishedAt })
      .run();

  test("lists every catalog line with what a change would do", async () => {
    const { serviceId } = await createDb("mongo", "7.0");
    const res = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ engine: "mongo", version: "7.0", image: "mongo:7.0.45", pendingImage: null, blocked: null });
    expect(res.body.backupFresh).toBe(false);
    expect(res.body.recentBackupAt).toBeNull();
    expect(
      res.body.choices.map((c: { version: string; kind: string; allowed: boolean; reason?: string }) => [
        c.version,
        c.kind,
        c.allowed,
        c.reason ?? null,
      ]),
    ).toEqual([
      ["9.0", "major", false, "oneStep"],
      ["8.0", "major", true, null],
      ["7.0", "current", false, "current"],
    ]);
  });

  test("a patch update needs no backup and deploys the newer pinned image", async () => {
    const { serviceId } = await createDb("mongo", "8.0");
    // Created before the catalog moved on: it runs the older pinned image.
    setImage(serviceId, "mongo:8.0.12");
    const live = panel.deps.db.select({ id: services.liveDeploymentId }).from(services).where(eq(services.id, serviceId)).get()?.id ?? "";
    panel.deps.db.update(deployments).set({ imageRef: "mongo:8.0.12" }).where(eq(deployments.id, live)).run();
    const choices = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(choices.body.choices.find((c: { version: string }) => c.version === "8.0")).toMatchObject({
      kind: "patch",
      allowed: true,
      image: "mongo:8.0.34",
    });
    const before = deployCount(serviceId);
    // No agent is connected: a patch update runs no exec.
    const res = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0" }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.database).toMatchObject({ engine: "mongo", version: "8.0" });
    expect(res.body.deploymentId).toBeString();
    expect(specImage(serviceId)).toBe("mongo:8.0.34");
    expect(deployCount(serviceId)).toBe(before + 1);
  });

  test("a MongoDB upgrade needs a backup, raises the compatibility version first and changes nothing when that fails", async () => {
    const { serviceId, node } = await createDb("mongo", "7.0");
    const refused = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0" }, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("backupRequired");
    // A backup older than a day does not count.
    backup(serviceId, new Date(Date.now() - 25 * 60 * 60 * 1000));
    expect((await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0" }, { cookie })).body.error.details.reason).toBe(
      "backupRequired",
    );

    const before = deployCount(serviceId);
    const failing = fakeAgent(panel, node.id, {
      exec: () => ({ exitCode: 3, stdout: new TextEncoder().encode("Authentication failed.\n") }),
    });
    const failed = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0", confirmNoBackup: true }, { cookie });
    expect(failed.status).toBe(409);
    expect(failed.body.error.details.reason).toBe("fcvFailed");
    expect(failed.body.error.message).toContain("Authentication failed.");
    expect(panel.deps.db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, serviceId)).get()?.version).toBe("7.0");
    expect(specImage(serviceId)).toBe("mongo:7.0.45");
    expect(deployCount(serviceId)).toBe(before);
    failing.disconnect();

    backup(serviceId, new Date(Date.now() - 60 * 60 * 1000));
    const fresh = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(fresh.body.backupFresh).toBe(true);
    let request: { command: string[]; stdin: Uint8Array } | null = null;
    const agent = fakeAgent(panel, node.id, {
      exec: (req: { command: string[]; stdin: Uint8Array }) => {
        request = req;
        return { exitCode: 0 };
      },
    });
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    const res = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0" }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.database.version).toBe("8.0");
    expect(specImage(serviceId)).toBe("mongo:8.0.34");
    expect(deployCount(serviceId)).toBe(before + 1);
    const sent = request as unknown as { command: string[]; stdin: Uint8Array };
    const stdin = new TextDecoder().decode(sent.stdin);
    // The running 7.0 is set to its own line before 8.0 starts on its files.
    expect(stdin).toContain('setFeatureCompatibilityVersion: "7.0"');
    expect(stdin).toContain(conn.body.internal.password);
    expect(sent.command.join(" ")).not.toContain(conn.body.internal.password);
    agent.disconnect();
  });

  test("two changes at once: the second refuses once the first queued its deploy", async () => {
    const { serviceId, node } = await createDb("mongo", "7.0");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = fakeAgent(panel, node.id, {
      exec: async () => {
        await gate;
        return { exitCode: 0 };
      },
    });
    const before = deployCount(serviceId);
    const first = callOp(panel, dbOps.setVersion, { serviceId, version: "8.0", confirmNoBackup: true }, { cookie });
    const second = callOp(panel, dbOps.setVersion, { serviceId, version: "8.0", confirmNoBackup: true }, { cookie });
    // Both wait in the MongoDB step.
    await Bun.sleep(100);
    release();
    const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(deployCount(serviceId)).toBe(before + 1);
    agent.disconnect();
  });

  test("downgrades, Postgres majors and skipped lines are refused; custom images are checked", async () => {
    const mongo = await createDb("mongo", "8.0");
    const down = await callOp(panel, dbOps.setVersion, { serviceId: mongo.serviceId, version: "7.0", confirmNoBackup: true }, { cookie });
    expect(down.status).toBe(409);
    expect(down.body.error.details.reason).toBe("downgrade");
    const unknown = await callOp(panel, dbOps.setVersion, { serviceId: mongo.serviceId, version: "6.0" }, { cookie });
    expect(unknown.status).toBe(400);
    const latest = await callOp(panel, dbOps.setVersion, { serviceId: mongo.serviceId, version: "8.0", image: "mongo:latest" }, { cookie });
    expect(latest.status).toBe(400);
    expect(latest.body.error.details.reason).toBe("customImage");
    // A digest-only image of another version would pass as a patch of the line it claims.
    const digest = await callOp(
      panel,
      dbOps.setVersion,
      { serviceId: mongo.serviceId, version: "8.0", image: `mongo@sha256:${"b".repeat(64)}` },
      { cookie },
    );
    expect(digest.status).toBe(400);
    expect(digest.body.error.details.reason).toBe("customImage");
    expect(specImage(mongo.serviceId)).toBe("mongo:8.0.34");
    // A custom image of the same line is a patch update.
    const custom = await callOp(panel, dbOps.setVersion, { serviceId: mongo.serviceId, version: "8.0", image: "mongo:8.0.40" }, { cookie });
    expect(custom.status).toBe(200);
    expect(specImage(mongo.serviceId)).toBe("mongo:8.0.40");

    const pg = await createDb("postgres", "17");
    const major = await callOp(panel, dbOps.setVersion, { serviceId: pg.serviceId, version: "18", confirmNoBackup: true }, { cookie });
    expect(major.status).toBe(409);
    expect(major.body.error.details.reason).toBe("postgresMajor");
    expect(major.body.error.message).toContain("dump and restore");
    // The Debian image of the same major is no patch: its C library sorts text in another order.
    const debian = await callOp(
      panel,
      dbOps.setVersion,
      { serviceId: pg.serviceId, version: "17", image: "postgres:17.7-bookworm" },
      { cookie },
    );
    expect(debian.status).toBe(400);
    expect(debian.body.error.details.reason).toBe("customImage");
    expect(debian.body.error.message).toContain("sorts text differently");
    expect(specImage(pg.serviceId)).toBe("postgres:17.6-alpine");
    const alpine = await callOp(
      panel,
      dbOps.setVersion,
      { serviceId: pg.serviceId, version: "17", image: "postgres:17.7-alpine" },
      { cookie },
    );
    expect(alpine.status).toBe(200);
    expect(specImage(pg.serviceId)).toBe("postgres:17.7-alpine");

    const maria = await createDb("mariadb", "10.11");
    const skip = await callOp(panel, dbOps.setVersion, { serviceId: maria.serviceId, version: "11.8", confirmNoBackup: true }, { cookie });
    expect(skip.body.error.details.reason).toBe("oneStep");
    // The change deploys with the container env that upgrades MariaDB's system tables.
    const env = Object.fromEntries(resolveServiceEnv(panel.deps, maria.serviceId).map((v) => [v.name, v.value]));
    expect(env.MARIADB_AUTO_UPGRADE).toBe("1");
    const step = await callOp(panel, dbOps.setVersion, { serviceId: maria.serviceId, version: "11.4", confirmNoBackup: true }, { cookie });
    expect(step.status).toBe(200);
    expect(specImage(maria.serviceId)).toBe("mariadb:11.4.7");
  });

  test("a stopped database, a running deploy or no node blocks every change", async () => {
    const { serviceId } = await createDb("redis", "7.4");
    panel.deps.db.update(services).set({ stopped: true }).where(eq(services.id, serviceId)).run();
    const stopped = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(stopped.body.blocked).toMatchObject({ reason: "stopped" });
    const refused = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.2", confirmNoBackup: true }, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("stopped");
    panel.deps.db.update(services).set({ stopped: false }).where(eq(services.id, serviceId)).run();

    const first = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.2", confirmNoBackup: true }, { cookie });
    expect(first.status).toBe(200);
    // Its deploy is queued or running: a second change waits for it.
    const second = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(second.body.blocked).toMatchObject({ reason: "deployRunning" });
    expect(second.body.pendingImage).toBe("redis:8.2.1-alpine");
  });

  test("after a failed change the database is judged by what still runs: retry or stay", async () => {
    const { serviceId } = await createDb("mongo", "7.0");
    // The 7.0 deploy went live; then a change to 8.0 failed, so 7.0 still runs.
    panel.deps.db.update(serviceDatabases).set({ version: "8.0" }).where(eq(serviceDatabases.serviceId, serviceId)).run();
    setImage(serviceId, "mongo:8.0.34");
    const res = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(res.body).toMatchObject({ version: "7.0", image: "mongo:7.0.45", pendingImage: "mongo:8.0.34" });
    expect(res.body.choices.map((c: { version: string; allowed: boolean }) => [c.version, c.allowed])).toEqual([
      ["9.0", false],
      ["8.0", true],
      ["7.0", true],
    ]);
    // Staying on 7.0 is no line change: no backup, no exec.
    const stay = await callOp(panel, dbOps.setVersion, { serviceId, version: "7.0" }, { cookie });
    expect(stay.status).toBe(200);
    expect(stay.body.database.version).toBe("7.0");
    expect(specImage(serviceId)).toBe("mongo:7.0.45");
  });
});
