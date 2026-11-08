import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { databases as dbOps, exposures as exposureOps } from "@seylo/ops";
import { DatabaseEngine } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { nodes, serviceSecrets, services } from "../src/db/schema";
import { databaseRuntime } from "../src/modules/databases/desired";
import { edgeSubject, verifyEdgeTicket } from "../src/modules/databases/edge-ticket";
import {
  changePasswordExec,
  connectionUrl,
  containerCommand,
  engines,
  enginesCapability,
  generatePassword,
  generateUserName,
  healthCommand,
  healthProbe,
  httpUrl,
} from "../src/modules/databases/engines";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { ensureEdgeTicketKey } from "../src/security/edge-ticket-key";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, settleDeploys } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
});
afterEach(async () => {
  // databases.create queues a deploy; let it settle before the database closes.
  await settleDeploys(panel);
  panel.close();
});

type Engine = "postgres" | "mysql" | "mariadb" | "mongo" | "redis" | "valkey" | "keydb" | "dragonfly" | "clickhouse";

/** Records that the node's agent advertised capabilities (as nodes.facts keeps them for offline nodes). */
function advertise(nodeId: string, capabilities: string[]) {
  panel.deps.db.update(nodes).set({ facts: { capabilities } }).where(eq(nodes.id, nodeId)).run();
}

async function createDb(engine: Engine, extra: Record<string, unknown> = {}) {
  const project = seedProject(panel);
  const node = seedNode(panel, { ipv4: "203.0.113.10", wildcard: "n1.example.com" });
  advertise(node.id, [enginesCapability]);
  const res = await callOp(panel, dbOps.create, { projectId: project.id, name: "shop-db", engine, nodeId: node.id, ...extra } as never, {
    cookie,
  });
  return { project, node, res };
}

describe("engines", () => {
  test("passwords use the allowed alphabet; URLs per engine", () => {
    const pw = generatePassword();
    expect(pw).toMatch(/^[A-Za-z0-9]{32}$/);
    const creds = { user: "postgres", password: "pw", database: "shop" };
    expect(connectionUrl("postgres", creds, "db", 5432)).toBe("postgresql://postgres:pw@db:5432/shop");
    expect(connectionUrl("postgres", creds, "1.2.3.4", 41000, true)).toBe("postgresql://postgres:pw@1.2.3.4:41000/shop?sslmode=require");
    expect(connectionUrl("mongo", { ...creds, user: "root" }, "db", 27017)).toBe("mongodb://root:pw@db:27017/shop?authSource=admin");
    expect(connectionUrl("redis", { user: "default", password: "pw", database: "" }, "cache", 6379, true)).toBe(
      "rediss://default:pw@cache:6379",
    );
  });

  test("password changes go on stdin, never in the command", () => {
    for (const engine of ["postgres", "mysql", "mariadb", "mongo", "redis", "valkey", "keydb"] as const) {
      const exec = changePasswordExec(engine, "admin", "NewSecret123");
      expect(exec?.command.join(" ")).not.toContain("NewSecret123");
      expect(exec?.stdin).toContain("NewSecret123");
      // The old password signs in from the environment, not the command line.
      expect(exec?.command.join(" ")).not.toContain(" -a ");
    }
    // These read the password from their environment at start: the new env restarts them.
    expect(changePasswordExec("dragonfly", "default", "x")).toBeNull();
    expect(changePasswordExec("clickhouse", "admin", "x")).toBeNull();
  });
});

describe("databases ops", () => {
  test("create writes a pinned image, a data volume and sealed credentials", async () => {
    const { res, node } = await createDb("postgres");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "shop-db",
      engine: "postgres",
      version: "18",
      variant: null,
      shellClient: "psql",
      nodeId: node.id,
      internal: { host: "shop-db", port: 5432, database: "shop_db", user: "postgres" },
      exposure: { enabled: false, host: null, port: null, user: "external", certificate: "none" },
      webUi: { tool: "pgweb", idleMinutes: 15, running: false },
    });
    const row = panel.deps.db.select().from(services).where(eq(services.id, res.body.serviceId)).get();
    expect(row?.kind).toBe("postgres");
    expect(JSON.stringify(row?.spec)).toContain("postgres:18.6-alpine");
    expect(JSON.stringify(row?.spec)).toContain('"mode":"recreate"');
    // Passwords are sealed, never stored as plain text.
    const secrets = panel.deps.db.select().from(serviceSecrets).where(eq(serviceSecrets.serviceId, res.body.serviceId)).all();
    expect(secrets.map((s) => s.name).sort()).toEqual(["admin_password", "exposed_password"]);

    const conn = await callOp(panel, dbOps.connection, { serviceId: res.body.serviceId }, { cookie });
    expect(conn.body.internal.url).toMatch(/^postgresql:\/\/postgres:[A-Za-z0-9]{32}@shop-db:5432\/shop_db$/);
    for (const s of secrets) expect(s.valueSealed).not.toContain(conn.body.internal.password);
    expect(conn.body.exposed).toBeNull();

    // The container gets the engine's variables; the agent gets the DatabaseSpec.
    const env = Object.fromEntries(resolveServiceEnv(panel.deps, res.body.serviceId).map((v) => [v.name, v.value]));
    expect(env).toMatchObject({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: conn.body.internal.password, POSTGRES_DB: "shop_db" });
    expect(databaseRuntime(panel.deps, res.body.serviceId)?.database).toMatchObject({
      engine: DatabaseEngine.POSTGRES,
      credentials: { adminUser: "postgres", adminPassword: conn.body.internal.password, database: "shop_db" },
      exposure: { enabled: false },
    });
  });

  test("bad versions, names in use and Redis users are refused", async () => {
    const { project, node } = await createDb("postgres");
    const again = await callOp(
      panel,
      dbOps.create,
      { projectId: project.id, name: "shop-db", engine: "redis", nodeId: node.id },
      { cookie },
    );
    expect(again.status).toBe(409);
    const version = await callOp(
      panel,
      dbOps.create,
      { projectId: project.id, name: "x", engine: "postgres", version: "9", nodeId: node.id },
      { cookie },
    );
    expect(version.status).toBe(400);
    const redisUser = await callOp(
      panel,
      dbOps.create,
      { projectId: project.id, name: "y", engine: "redis", user: "admin", nodeId: node.id },
      { cookie },
    );
    expect(redisUser.status).toBe(400);
  });

  test("exposure opens a TLS port; the exposed URL appears once the agent reports the port", async () => {
    const { res, node } = await createDb("postgres");
    const serviceId = res.body.serviceId;
    const on = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: ["198.51.100.0/24"] }, { cookie });
    expect(on.body.exposure).toMatchObject({ enabled: true, host: "203.0.113.10", port: null, certificate: "selfSigned" });

    const agent = fakeAgent(panel, node.id);
    agent.snapshot({ epoch: 1n, services: [{ serviceId, openPorts: [{ hostPort: 45432, containerPort: 5432 }] }] });
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    expect(conn.body.exposed).toMatchObject({ host: "203.0.113.10", port: 45432, user: "external", tlsParams: "sslmode=require" });
    expect(conn.body.exposed.url).toContain("@203.0.113.10:45432/shop_db?sslmode=require");
    const access = await callOp(panel, exposureOps.get, { serviceId }, { cookie });
    expect(access.body.database).toEqual({ host: "203.0.113.10", port: 45432, allowedCidrs: ["198.51.100.0/24"] });
    expect(databaseRuntime(panel.deps, serviceId)?.database.exposure).toMatchObject({
      enabled: true,
      hostPort: 45432,
      user: "external",
      password: conn.body.exposed.password,
    });

    const acme = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, tlsHostname: "db.example.com" }, { cookie });
    expect(acme.body.exposure).toMatchObject({
      host: "db.example.com",
      port: 45432,
      certificate: "pending",
      allowedCidrs: ["198.51.100.0/24"],
    });
    const off = await callOp(panel, dbOps.setExposure, { serviceId, enabled: false }, { cookie });
    expect(off.body.exposure.enabled).toBe(false);
    agent.disconnect();
  });

  test("Mongo TLS through the agent: web UI state and the served certificate come from the node", async () => {
    const { res, node } = await createDb("mongo");
    const serviceId = res.body.serviceId;
    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    const agent = fakeAgent(panel, node.id);
    const expires = new Date(Date.now() + 60 * 86_400_000);
    agent.snapshot({
      epoch: 1n,
      services: [
        {
          serviceId,
          openPorts: [{ hostPort: 47017, containerPort: 27017, tls: true, certificateIssuer: "seylo self-signed" }],
          webUi: { running: true, lastActiveAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 } },
        },
      ],
    });
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    // No host name: the certificate is self-signed, so the client is told to accept it.
    expect(conn.body.exposed.url).toEndWith("?authSource=admin&tls=true&tlsAllowInvalidCertificates=true");
    const got = await callOp(panel, dbOps.get, { serviceId }, { cookie });
    expect(got.body.webUi.running).toBe(true);
    expect(got.body.webUi.lastActiveAt).not.toBeNull();
    expect(got.body.exposure).toMatchObject({ certificate: "selfSigned", certificateIssuer: "seylo self-signed" });

    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, tlsHostname: "mongo.example.com" }, { cookie });
    agent.snapshot({
      epoch: 2n,
      services: [
        {
          serviceId,
          openPorts: [
            {
              hostPort: 47017,
              containerPort: 27017,
              tls: true,
              certificateIssuer: "R11",
              certificateExpiresAt: { seconds: BigInt(Math.floor(expires.getTime() / 1000)), nanos: 0 },
            },
          ],
        },
      ],
    });
    const acme = await callOp(panel, dbOps.get, { serviceId }, { cookie });
    expect(acme.body.exposure).toMatchObject({ certificate: "valid", certificateIssuer: "Let's Encrypt (R11)" });
    expect(Date.parse(acme.body.exposure.certificateExpiresAt ?? "")).toBe(Math.floor(expires.getTime() / 1000) * 1000);
    expect(acme.body.webUi).toMatchObject({ running: false, lastActiveAt: null });
    const tlsConn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    expect(tlsConn.body.exposed.url).toEndWith("@mongo.example.com:47017/shop_db?authSource=admin&tls=true");
    agent.disconnect();
  });

  test("password reset runs in the database through Exec, then stores the new one", async () => {
    const { res, node, project } = await createDb("mysql");
    const serviceId = res.body.serviceId;
    // A service that uses the password through a reference is reported as affected.
    const { seedService } = await import("./seed-helpers");
    const app = seedService(panel, { projectId: project.id, name: "api", nodeIds: [node.id] });
    await callOp(panel, (await import("@seylo/ops")).env.set, { serviceId: app.id, text: "DB=${{shop-db.INTERNAL_URL}}\n" }, { cookie });

    const offline = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal" }, { cookie });
    expect(offline.status).toBe(503);

    let stdin = "";
    const agent = fakeAgent(panel, node.id, {
      exec: (req: { command: string[]; stdin: Uint8Array }) => {
        stdin = new TextDecoder().decode(req.stdin);
        return { exitCode: 0 };
      },
    });
    const reset = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal", password: "BrandNewPassword1" }, { cookie });
    expect(reset.body).toEqual({ password: "BrandNewPassword1", affectedServiceIds: [app.id] });
    expect(stdin).toContain("ALTER USER 'root'@'%' IDENTIFIED BY 'BrandNewPassword1'");
    expect(agent.calls[0]?.method).toBe("exec");
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    expect(conn.body.internal.password).toBe("BrandNewPassword1");
    agent.disconnect();

    const failing = fakeAgent(panel, node.id, { exec: () => ({ exitCode: 1 }) });
    const refused = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal", password: "AnotherPassword22" }, { cookie });
    expect(refused.status).toBe(409);
    expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.internal.password).toBe("BrandNewPassword1");
    failing.disconnect();

    // The exposed user has no live database change to make here: it is stored and sent with the desired state.
    const exposed = await callOp(panel, dbOps.resetPassword, { serviceId, user: "exposed" }, { cookie });
    expect(exposed.status).toBe(200);
  });

  test("the web UI link carries a single-use edge ticket for this database only", async () => {
    const { res } = await createDb("postgres");
    const serviceId = res.body.serviceId;
    const link = await callOp(panel, dbOps.openWebUi, { serviceId }, { cookie });
    expect(link.status).toBe(200);
    const url = new URL(link.body.url);
    expect(url.host).toBe(`seylo-db-${serviceId}.n1.example.com`);
    expect(url.pathname).toBe("/_seylo/ticket");
    const token = url.searchParams.get("t") ?? "";
    const { publicKey } = ensureEdgeTicketKey(panel.deps.db, panel.deps.secrets);
    expect(verifyEdgeTicket(publicKey, token, edgeSubject("db", serviceId))).toMatchObject({ v: 1, sub: `db-ui:${serviceId}` });
    expect(verifyEdgeTicket(publicKey, token, edgeSubject("box", serviceId))).toBeNull();
    // Flip a whole signature byte: changing the last base64 characters can land on padding bits only.
    const [payload, signature = ""] = token.split(".");
    const tampered = Buffer.from(signature, "base64url");
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(verifyEdgeTicket(publicKey, `${payload}.${tampered.toString("base64url")}`, edgeSubject("db", serviceId))).toBeNull();
    expect(verifyEdgeTicket(publicKey, token, edgeSubject("db", serviceId), Date.now() + 5 * 60_000)).toBeNull();
  });

  test("tools need databases.tools, credentials need databases.credentials", async () => {
    const { res } = await createDb("redis");
    const serviceId = res.body.serviceId;
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", serviceId, ["services.view"]);
    expect((await callOp(panel, dbOps.get, { serviceId }, { cookie: member.cookie })).status).toBe(200);
    expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie: member.cookie })).status).toBe(403);
    expect((await callOp(panel, dbOps.openWebUi, { serviceId }, { cookie: member.cookie })).status).toBe(403);
  });
});

describe("more engines", () => {
  test("catalog: every image is pinned and pgvector covers the Postgres majors", async () => {
    for (const e of Object.values(engines)) {
      for (const v of [...e.versions, ...e.variants.flatMap((x) => x.versions)]) {
        // An exact tag (with a patch number) or a digest; never latest or a bare major.
        expect(v.image).toMatch(/(:v?\d+\.\d+[\w.-]*$)|(@sha256:[0-9a-f]{64}$)/);
        expect(v.image).not.toContain("latest");
      }
    }
    const pgvector = engines.postgres.variants.find((v) => v.id === "pgvector");
    expect(pgvector?.versions.map((v) => v.version)).toEqual(engines.postgres.versions.map((v) => v.version));
    // Postgres 18 images keep their data one level up.
    expect(engines.postgres.versions[0]).toMatchObject({ version: "18", dataPath: "/var/lib/postgresql" });
    expect(engines.postgres.versions[1]?.dataPath).toBe("/var/lib/postgresql/data");

    const res = await callOp(panel, dbOps.engines, {}, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.engines.map((e: { engine: string }) => e.engine)).toEqual([
      "postgres",
      "mysql",
      "mariadb",
      "mongo",
      "redis",
      "valkey",
      "keydb",
      "dragonfly",
      "clickhouse",
    ]);
    const ch = res.body.engines.find((e: { engine: string }) => e.engine === "clickhouse");
    expect(ch).toMatchObject({
      port: 9000,
      defaultUser: null,
      hasDatabase: true,
      shellClient: "clickhouse-client",
      webUiTool: "ClickHouse Play",
      notice: null,
    });
    // KeyDB says why to think twice wherever it is picked (the form, MCP, the assistant).
    const keydb = res.body.engines.find((e: { engine: string }) => e.engine === "keydb");
    expect(keydb.notice).toContain("no security fixes");
    expect(keydb.notice).toContain("CVE-2025-49844");
    expect(keydb.notice).toContain("Prefer Valkey");
    expect(res.body.engines.filter((e: { notice: string | null }) => e.notice !== null).map((e: { engine: string }) => e.engine)).toEqual([
      "keydb",
    ]);
  });

  test("KeyDB, which gets no security fixes, is exposed only to listed addresses", async () => {
    const { res, node } = await createDb("keydb");
    expect(res.status).toBe(200);
    const serviceId = res.body.serviceId;
    expect(res.body.exposure).toMatchObject({ enabled: false, needsAllowedCidrs: true });
    const open = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    expect(open.status).toBe(400);
    expect(open.body.error.details).toMatchObject({ field: "allowedCidrs", reason: "allowlistRequired" });
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toEqual({ enabled: false });

    const limited = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: ["198.51.100.24"] }, { cookie });
    expect(limited.status).toBe(200);
    expect(limited.body.exposure).toMatchObject({ enabled: true, allowedCidrs: ["198.51.100.24/32"], needsAllowedCidrs: true });
    // Emptying the list later is refused too; turning exposure off is not.
    const emptied = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: [] }, { cookie });
    expect(emptied.status).toBe(400);
    expect((await callOp(panel, dbOps.get, { serviceId }, { cookie })).body.exposure.allowedCidrs).toEqual(["198.51.100.24/32"]);
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: false }, { cookie })).status).toBe(200);

    // Valkey, its maintained fork-mate, has no such rule.
    const valkey = await callOp(
      panel,
      dbOps.create,
      { projectId: res.body.projectId, name: "cache", engine: "valkey", nodeId: node.id },
      { cookie },
    );
    expect(valkey.body.exposure.needsAllowedCidrs).toBe(false);
    expect((await callOp(panel, dbOps.setExposure, { serviceId: valkey.body.serviceId, enabled: true }, { cookie })).status).toBe(200);
  });

  test("URLs, commands and health checks of the new engines", () => {
    const one = { user: "default", password: "pw", database: "" };
    expect(connectionUrl("valkey", one, "cache", 6379)).toBe("redis://default:pw@cache:6379");
    expect(connectionUrl("dragonfly", one, "1.2.3.4", 46379, true)).toBe("rediss://default:pw@1.2.3.4:46379");
    const ch = { user: "ch_abc", password: "pw", database: "events" };
    expect(connectionUrl("clickhouse", ch, "ch", 9000)).toBe("clickhouse://ch_abc:pw@ch:9000/events");
    expect(connectionUrl("clickhouse", ch, "1.2.3.4", 49000, true)).toBe("clickhouse://ch_abc:pw@1.2.3.4:49000/events?secure=true");
    expect(httpUrl("clickhouse", ch, "ch")).toBe("http://ch_abc:pw@ch:8123/events");
    expect(httpUrl("postgres", ch, "db")).toBeNull();
    // Passwords come from the environment; the server keeps its own user's rights.
    expect(containerCommand("valkey").join(" ")).toContain(
      'docker-entrypoint.sh valkey-server --requirepass "$VALKEY_PASSWORD" --appendonly yes',
    );
    expect(containerCommand("keydb").join(" ")).toContain('keydb-server /etc/keydb/keydb.conf --requirepass "$KEYDB_PASSWORD"');
    expect(containerCommand("dragonfly")).toEqual(expect.arrayContaining(["--dbfilename", "dump", "--df_snapshot_format=false"]));
    expect(containerCommand("dragonfly").join(" ")).not.toContain("requirepass");
    expect(containerCommand("clickhouse")).toEqual([]);
    expect(healthCommand("keydb").join(" ")).toContain("keydb-cli ping");
    expect(healthProbe("mongo")).toEqual({ type: "tcp", port: 27017 });
    expect(healthCommand("clickhouse").join(" ")).toContain(":8123/ping");
    expect(generateUserName("ch")).toMatch(/^ch_[a-z0-9]{10}$/);
  });

  test("pgvector is a variant of Postgres; unknown variants and versions are refused", async () => {
    const { res, project, node } = await createDb("postgres", { variant: "pgvector", version: "17" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ engine: "postgres", version: "17", variant: "pgvector" });
    const row = panel.deps.db.select().from(services).where(eq(services.id, res.body.serviceId)).get();
    expect(JSON.stringify(row?.spec)).toContain("pgvector/pgvector:0.8.7-pg17-trixie");
    const vol = await callOp(panel, (await import("@seylo/ops")).services.get, { serviceId: res.body.serviceId }, { cookie });
    expect(JSON.stringify(vol.body)).toContain("/var/lib/postgresql/data");
    const create = (input: Record<string, unknown>) =>
      callOp(panel, dbOps.create, { projectId: project.id, nodeId: node.id, ...input } as never, { cookie });
    expect((await create({ name: "v18", engine: "postgres", variant: "pgvector" })).body).toMatchObject({
      version: "18",
      variant: "pgvector",
    });
    const noSuch = await create({ name: "x1", engine: "postgres", variant: "postgis" });
    expect(noSuch.status).toBe(400);
    expect(noSuch.body.error.details.field).toBe("variant");
    expect((await create({ name: "x2", engine: "mysql", variant: "pgvector" })).status).toBe(400);
    expect((await create({ name: "x3", engine: "postgres", variant: "pgvector", version: "14" })).status).toBe(400);
  });

  test("new engines need an agent that advertises database.engines.v2", async () => {
    const project = seedProject(panel);
    const old = seedNode(panel);
    const create = (engine: Engine, nodeId: string, name: string) =>
      callOp(panel, dbOps.create, { projectId: project.id, name, engine, nodeId }, { cookie });
    for (const engine of ["valkey", "keydb", "dragonfly", "clickhouse"] as const) {
      const refused = await create(engine, old.id, `old-${engine}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error.details.reason).toBe("agentTooOld");
    }
    // The first five engines and Postgres variants still go anywhere.
    expect((await create("redis", old.id, "plain-redis")).status).toBe(200);
    // A connected agent's live capabilities count, and are kept for when it is offline.
    const live = seedNode(panel);
    const older = fakeAgent(panel, live.id);
    expect((await create("valkey", live.id, "live-valkey")).status).toBe(409);
    older.disconnect();
    const newer = fakeAgent(panel, live.id, {}, [], [enginesCapability]);
    expect((await create("valkey", live.id, "live-valkey")).status).toBe(200);
    newer.disconnect();
    const keydb = await create("keydb", live.id, "offline-keydb");
    expect(keydb.status).toBe(200);
    // Nor can one move to a node that does not run its engine.
    const moved = await callOp(
      panel,
      (await import("@seylo/ops")).services.move,
      { serviceId: keydb.body.serviceId, toNodeId: old.id },
      { cookie },
    );
    expect(moved.status).toBe(409);
    expect(moved.body.error.details.reason).toBe("agentTooOld");
  });

  test("Valkey: one user over TLS, its own env and command, the Redis tools", async () => {
    const { res, node } = await createDb("valkey");
    expect(res.status).toBe(200);
    const serviceId = res.body.serviceId;
    expect(res.body).toMatchObject({
      engine: "valkey",
      version: "9.1",
      internal: { host: "shop-db", port: 6379, database: "", user: "default", httpPort: null },
      exposure: { user: "default" },
      webUi: { tool: "Redis Commander" },
      shellClient: "valkey-cli",
    });
    const row = panel.deps.db.select().from(services).where(eq(services.id, serviceId)).get();
    expect(row?.kind).toBe("valkey");
    expect(JSON.stringify(row?.spec)).toContain("valkey/valkey:9.1.3-alpine");
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    const env = Object.fromEntries(resolveServiceEnv(panel.deps, serviceId).map((v) => [v.name, v.value]));
    expect(env).toEqual({ VALKEY_PASSWORD: conn.body.internal.password });

    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    const runtime = databaseRuntime(panel.deps, serviceId, node.id)?.database;
    expect(runtime).toMatchObject({ engine: DatabaseEngine.VALKEY, exposure: { enabled: true } });
    expect(runtime?.exposure?.user).toBeUndefined();
    const agent = fakeAgent(panel, node.id, {}, [], [enginesCapability]);
    agent.snapshot({ epoch: 1n, services: [{ serviceId, openPorts: [{ hostPort: 46379, containerPort: 6379, tls: true }] }] });
    expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.exposed.url).toBe(
      `rediss://default:${conn.body.internal.password}@203.0.113.10:46379`,
    );
    agent.disconnect();
    // A user other than default is refused, as for Redis.
    const named = await callOp(
      panel,
      dbOps.create,
      { projectId: res.body.projectId, name: "named", engine: "keydb", nodeId: node.id, user: "admin" },
      { cookie },
    );
    expect(named.status).toBe(400);
  });

  test("ClickHouse: a generated user, native and HTTP URLs, references and TLS exposure", async () => {
    const { res, node, project } = await createDb("clickhouse");
    expect(res.status).toBe(200);
    const serviceId = res.body.serviceId;
    expect(res.body).toMatchObject({
      engine: "clickhouse",
      version: "26.8",
      internal: { host: "shop-db", port: 9000, database: "shop_db", httpPort: 8123 },
      exposure: { user: "external" },
      webUi: { tool: "ClickHouse Play" },
      shellClient: "clickhouse-client",
    });
    expect(res.body.internal.user).toMatch(/^ch_[a-z0-9]{10}$/);
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    const { user, password } = conn.body.internal;
    expect(conn.body.internal).toMatchObject({
      url: `clickhouse://${user}:${password}@shop-db:9000/shop_db`,
      httpUrl: `http://${user}:${password}@shop-db:8123/shop_db`,
    });
    const env = Object.fromEntries(resolveServiceEnv(panel.deps, serviceId).map((v) => [v.name, v.value]));
    expect(env).toEqual({
      CLICKHOUSE_USER: user,
      CLICKHOUSE_PASSWORD: password,
      CLICKHOUSE_DB: "shop_db",
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    });
    const row = panel.deps.db.select().from(services).where(eq(services.id, serviceId)).get();
    expect(JSON.stringify(row?.spec)).toContain('"containerPort":9000');

    // ${{shop-db.INTERNAL_HTTP_URL}} resolves for an app of the project, and is a credential.
    const { seedService } = await import("./seed-helpers");
    const app = seedService(panel, { projectId: project.id, name: "api", nodeIds: [node.id] });
    const set = await callOp(
      panel,
      (await import("@seylo/ops")).env.set,
      {
        serviceId: app.id,
        text: "CH=${{shop-db.INTERNAL_HTTP_URL}}\nCH_NATIVE=${{shop-db.INTERNAL_URL}}\nCH_PORT=${{shop-db.INTERNAL_HTTP_PORT}}\n",
      },
      { cookie },
    );
    expect(set.status).toBe(200);
    const appEnv = Object.fromEntries(resolveServiceEnv(panel.deps, app.id).map((v) => [v.name, v]));
    expect(appEnv.CH).toMatchObject({ value: conn.body.internal.httpUrl, secret: true });
    expect(appEnv.CH_NATIVE?.value).toBe(conn.body.internal.url);
    expect(appEnv.CH_PORT?.value).toBe("8123");
    const refs = await callOp(panel, (await import("@seylo/ops")).env.references, { serviceId: app.id }, { cookie });
    const target = refs.body.targets.find((t: { name: string }) => t.name === "shop-db");
    expect(target.variables.find((v: { name: string }) => v.name === "INTERNAL_HTTP_URL")).toMatchObject({ sensitive: true });

    // Exposure: the native port through the agent's TLS, a separate user, the self-signed certificate accepted.
    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ enabled: true, user: "external" });
    const agent = fakeAgent(panel, node.id, {}, [], [enginesCapability]);
    agent.snapshot({ epoch: 1n, services: [{ serviceId, openPorts: [{ hostPort: 49000, containerPort: 9000, tls: true }] }] });
    const exposed = (await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.exposed;
    expect(exposed.url).toEndWith("@203.0.113.10:49000/shop_db?secure=true&skip_verify=true");
    expect(exposed.tlsParams).toBe("secure=true&skip_verify=true");
    agent.disconnect();
    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, tlsHostname: "ch.example.com" }, { cookie });
    expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.exposed.url).toEndWith(
      "@ch.example.com:49000/shop_db?secure=true",
    );
  });

  test("ClickHouse and Dragonfly take a new admin password by restarting with it", async () => {
    for (const engine of ["clickhouse", "dragonfly"] as const) {
      const { res, node, project } = await createDb(engine);
      const serviceId = res.body.serviceId;
      const { seedService } = await import("./seed-helpers");
      const app = seedService(panel, { projectId: project.id, name: `app-${engine}`, nodeIds: [node.id] });
      const variable = engine === "clickhouse" ? "INTERNAL_HTTP_URL" : "PASSWORD";
      await callOp(panel, (await import("@seylo/ops")).env.set, { serviceId: app.id, text: `X=\${{shop-db.${variable}}}\n` }, { cookie });
      // No agent call: the new environment recreates the container. Works while the node is offline.
      const reset = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal", password: "FreshPassword123" }, { cookie });
      expect(reset.status).toBe(200);
      expect(reset.body.affectedServiceIds).toEqual([app.id]);
      const env = resolveServiceEnv(panel.deps, serviceId).map((v) => v.value);
      expect(env).toContain("FreshPassword123");
      // Clean up for the next engine: one project per database name.
      await settleDeploys(panel);
    }
  });

  test("nodes without database.engines.v2 never get a new engine's exposure", async () => {
    const { res, node } = await createDb("clickhouse");
    const serviceId = res.body.serviceId;
    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ enabled: true });
    // The node went back to an older agent: the compiled spec keeps the port closed, and the op refuses.
    advertise(node.id, []);
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toEqual({ enabled: false });
    const again = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    expect(again.status).toBe(409);
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: false }, { cookie })).status).toBe(200);
  });
});
