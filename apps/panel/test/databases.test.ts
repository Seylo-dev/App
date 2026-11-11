import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { databases as dbOps, env as envOps, exposures as exposureOps, services as serviceOps } from "@seylo/ops";
import { DatabaseEngine } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments, nodes, portExposures, serviceDatabases, serviceSecrets, services } from "../src/db/schema";
import { compileMemo } from "../src/desired/contributors";
import { databaseRuntime } from "../src/modules/databases/desired";
import { edgeSubject, verifyEdgeTicket } from "../src/modules/databases/edge-ticket";
import {
  changePasswordExec,
  connectionUrl,
  containerCommand,
  engines,
  enginesCapability,
  exposureCapability,
  generatePassword,
  generateUserName,
  healthCommand,
  healthProbe,
  httpUrl,
} from "../src/modules/databases/engines";
import { retiredExposedPasswordSecret, writeSecret } from "../src/modules/databases/info";
import { releaseHeldRetirements } from "../src/modules/databases/retire";
import { publishDeploymentChange } from "../src/modules/deployments/store";
import { deploymentEnv, resolveServiceEnv, sealDeploymentEnv } from "../src/modules/env/desired";
import { ensureEdgeTicketKey } from "../src/security/edge-ticket-key";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, seedService, settleDeploys } from "./seed-helpers";

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
  advertise(node.id, [enginesCapability, exposureCapability]);
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
  // The sidebar and the dashboard read projects.list (panel topic); before, a new database only told the
  // project's own screens, so the sidebar kept showing the project with no services.
  test("create tells the sidebar (panel topic) and the project's screens at once", async () => {
    const received: { topic: string; ops: string[] }[] = [];
    panel.deps.live.subscribe(
      {
        id: "tab",
        send: (m: { type: string; topic?: string; event?: { ops?: string[] } }) => {
          if (m.type === "event" && m.topic) received.push({ topic: m.topic, ops: m.event?.ops ?? [] });
        },
      } as never,
      "panel",
    );
    const { res } = await createDb("postgres");
    expect(res.status).toBe(200);
    expect(received).toContainEqual({ topic: "panel", ops: ["projects.list"] });
  });

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
      // Exposure uses the database's own user.
      exposure: { enabled: false, host: null, port: null, user: "postgres", certificate: "none" },
      webUi: { tool: "pgweb", idleMinutes: 15, running: false },
    });
    const row = panel.deps.db.select().from(services).where(eq(services.id, res.body.serviceId)).get();
    expect(row?.kind).toBe("postgres");
    expect(JSON.stringify(row?.spec)).toContain("postgres:18.6-alpine");
    expect(JSON.stringify(row?.spec)).toContain('"mode":"recreate"');
    // Passwords are sealed, never stored as plain text.
    const secrets = panel.deps.db.select().from(serviceSecrets).where(eq(serviceSecrets.serviceId, res.body.serviceId)).all();
    // One login: no separate exposed user or password.
    expect(secrets.map((s) => s.name)).toEqual(["admin_password"]);
    expect(panel.deps.db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, res.body.serviceId)).get()?.exposedUser).toBe(
      "",
    );

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
      retiredExposedUser: "",
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

    const agent = fakeAgent(panel, node.id, {}, [], [enginesCapability, exposureCapability]);
    agent.snapshot({ epoch: 1n, services: [{ serviceId, openPorts: [{ hostPort: 45432, containerPort: 5432 }] }] });
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    expect(conn.body.exposed).toMatchObject({
      host: "203.0.113.10",
      port: 45432,
      user: "postgres",
      password: conn.body.internal.password,
      tlsParams: "sslmode=require",
    });
    expect(conn.body.exposed.url).toBe(`postgresql://postgres:${conn.body.internal.password}@203.0.113.10:45432/shop_db?sslmode=require`);
    const access = await callOp(panel, exposureOps.get, { serviceId }, { cookie });
    expect(access.body.database).toEqual({ host: "203.0.113.10", port: 45432, allowedCidrs: ["198.51.100.0/24"] });
    const exposure = databaseRuntime(panel.deps, serviceId)?.database.exposure;
    expect(exposure).toMatchObject({ enabled: true, hostPort: 45432 });
    // The agent creates no user: the port is the database's own login over TLS.
    expect(exposure?.user).toBeUndefined();
    expect(exposure?.password).toBeUndefined();

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
    // Services that use the password through a reference are reported as affected, the exposed URL's too.
    const { seedService } = await import("./seed-helpers");
    const app = seedService(panel, { projectId: project.id, name: "api", nodeIds: [node.id] });
    await callOp(panel, (await import("@seylo/ops")).env.set, { serviceId: app.id, text: "DB=${{shop-db.INTERNAL_URL}}\n" }, { cookie });
    const outside = seedService(panel, { projectId: project.id, name: "worker", nodeIds: [node.id] });
    await callOp(panel, (await import("@seylo/ops")).env.set, { serviceId: outside.id, text: "DB=${{shop-db.EXPOSED_URL}}\n" }, { cookie });

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
    expect(reset.body.password).toBe("BrandNewPassword1");
    expect(reset.body.affectedServiceIds.sort()).toEqual([app.id, outside.id].sort());
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

    // "exposed" (older callers) is the same one user: changed in the database, stored as the admin password.
    stdin = "";
    const again = fakeAgent(panel, node.id, {
      exec: (req: { command: string[]; stdin: Uint8Array }) => {
        stdin = new TextDecoder().decode(req.stdin);
        return { exitCode: 0 };
      },
    });
    const exposed = await callOp(panel, dbOps.resetPassword, { serviceId, user: "exposed", password: "ThirdPassword333" }, { cookie });
    expect(exposed.status).toBe(200);
    expect(exposed.body.affectedServiceIds.sort()).toEqual([app.id, outside.id].sort());
    expect(stdin).toContain("ALTER USER 'root'@'%' IDENTIFIED BY 'ThirdPassword333'");
    expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.internal.password).toBe("ThirdPassword333");
    expect(
      panel.deps.db
        .select()
        .from(serviceSecrets)
        .where(eq(serviceSecrets.serviceId, serviceId))
        .all()
        .map((x) => x.name),
    ).toEqual(["admin_password"]);
    again.disconnect();
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
      webUi: { tool: "ClickHouse Play" },
      shellClient: "clickhouse-client",
    });
    expect(res.body.internal.user).toMatch(/^ch_[a-z0-9]{10}$/);
    expect(res.body.exposure.user).toBe(res.body.internal.user);
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

    // Exposure: the native port through the agent's TLS, the same user, the self-signed certificate accepted.
    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ enabled: true });
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure?.user).toBeUndefined();
    const agent = fakeAgent(panel, node.id, {}, [], [enginesCapability]);
    agent.snapshot({ epoch: 1n, services: [{ serviceId, openPorts: [{ hostPort: 49000, containerPort: 9000, tls: true }] }] });
    const exposed = (await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.exposed;
    expect(exposed.url).toBe(`clickhouse://${user}:${password}@203.0.113.10:49000/shop_db?secure=true&skip_verify=true`);
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

  test("every engine's exposed connection is its own user and password, over TLS", async () => {
    for (const engine of ["postgres", "mysql", "mariadb", "mongo", "redis", "valkey", "keydb", "dragonfly", "clickhouse"] as const) {
      const { res, node, project } = await createDb(engine);
      const serviceId = res.body.serviceId;
      const on = await callOp(
        panel,
        dbOps.setExposure,
        { serviceId, enabled: true, ...(engine === "keydb" ? { allowedCidrs: ["198.51.100.24"] } : {}) },
        { cookie },
      );
      expect(on.status).toBe(200);
      expect(on.body.exposure.user).toBe(on.body.internal.user);
      const runtime = databaseRuntime(panel.deps, serviceId, node.id)?.database;
      expect(runtime?.exposure).toMatchObject({ enabled: true });
      expect(runtime?.exposure?.user).toBeUndefined();
      expect(runtime?.exposure?.password).toBeUndefined();
      const agent = fakeAgent(panel, node.id, {}, [], [enginesCapability, exposureCapability]);
      const port = engines[engine].port;
      agent.snapshot({ epoch: 1n, services: [{ serviceId, openPorts: [{ hostPort: 40000 + (port % 10000), containerPort: port }] }] });
      const conn = (await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body;
      expect(conn.exposed).toMatchObject({ user: conn.internal.user, password: conn.internal.password, database: conn.internal.database });
      expect(conn.exposed.url).toContain(`://${conn.internal.user}:${conn.internal.password}@203.0.113.10:`);
      // ${{shop-db.EXPOSED_URL}} is the same URL, with the same login.
      const { seedService } = await import("./seed-helpers");
      const app = seedService(panel, { projectId: project.id, name: `app-${engine}`, nodeIds: [node.id] });
      await callOp(panel, (await import("@seylo/ops")).env.set, { serviceId: app.id, text: "OUT=${{shop-db.EXPOSED_URL}}\n" }, { cookie });
      const appEnv = Object.fromEntries(resolveServiceEnv(panel.deps, app.id).map((v) => [v.name, v.value]));
      expect(appEnv.OUT).toBe(conn.exposed.url);
      agent.disconnect();
      await settleDeploys(panel);
    }
  });

  test("MariaDB 10.11 has no TLS: it is never exposed", async () => {
    const { res, node, project } = await createDb("mariadb", { version: "10.11" });
    expect(res.status).toBe(200);
    const serviceId = res.body.serviceId;
    const refused = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("noTls");
    expect(refused.body.error.message).toContain("MariaDB 10.11 has no TLS");
    expect(panel.deps.db.select().from(portExposures).where(eq(portExposures.serviceId, serviceId)).all()).toEqual([]);
    // Exposed before 0.2.9 (its old user could not sign in without TLS either): it reads as closed everywhere.
    panel.deps.db
      .insert(portExposures)
      .values({ serviceId, nodeId: node.id, kind: "database", listenPort: 43306, targetPort: 3306, tls: true })
      .run();
    expect((await callOp(panel, dbOps.get, { serviceId }, { cookie })).body.exposure).toMatchObject({ enabled: false, port: null });
    expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.exposed).toBeNull();
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toEqual({ enabled: false });
    const { seedService } = await import("./seed-helpers");
    const app = seedService(panel, { projectId: project.id, name: "api", nodeIds: [node.id] });
    await callOp(panel, (await import("@seylo/ops")).env.set, { serviceId: app.id, text: "OUT=${{shop-db.EXPOSED_URL}}\n" }, { cookie });
    expect(resolveServiceEnv(panel.deps, app.id).find((v) => v.name === "OUT")?.value).toBe("");
    // Turning it off still clears the old row.
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: false }, { cookie })).status).toBe(200);
    expect(panel.deps.db.select().from(portExposures).where(eq(portExposures.serviceId, serviceId)).all()).toEqual([]);
    // MariaDB 11.4 and later make their own certificate.
    await settleDeploys(panel);
    const newer = await callOp(
      panel,
      dbOps.create,
      { projectId: project.id, name: "newer", engine: "mariadb", version: "11.4", nodeId: node.id },
      { cookie },
    );
    expect((await callOp(panel, dbOps.setExposure, { serviceId: newer.body.serviceId, enabled: true }, { cookie })).status).toBe(200);
  });

  test("Postgres, MySQL and MariaDB are exposed only through agents with database.exposure.v2", async () => {
    const project = seedProject(panel);
    const old = seedNode(panel, { ipv4: "203.0.113.20" });
    // An agent from before 0.2.9: it runs every engine but relays these three without the TLS check.
    advertise(old.id, [enginesCapability]);
    for (const engine of ["postgres", "mysql", "mariadb"] as const) {
      const created = await callOp(
        panel,
        dbOps.create,
        { projectId: project.id, name: `old-${engine}`, engine, nodeId: old.id },
        { cookie },
      );
      expect(created.status).toBe(200);
      const refused = await callOp(panel, dbOps.setExposure, { serviceId: created.body.serviceId, enabled: true }, { cookie });
      expect(refused.status).toBe(409);
      expect(refused.body.error.details.reason).toBe("agentTooOld");
      expect(refused.body.error.message).toContain("Update the node");
      expect((await callOp(panel, dbOps.setExposure, { serviceId: created.body.serviceId, enabled: false }, { cookie })).status).toBe(200);
    }
    // Their TLS is the gate's already, so older agents keep exposing the others.
    const mongo = await callOp(
      panel,
      dbOps.create,
      { projectId: project.id, name: "old-mongo", engine: "mongo", nodeId: old.id },
      { cookie },
    );
    expect((await callOp(panel, dbOps.setExposure, { serviceId: mongo.body.serviceId, enabled: true }, { cookie })).status).toBe(200);
    expect(databaseRuntime(panel.deps, mongo.body.serviceId, old.id)?.database.exposure).toMatchObject({ enabled: true });

    // Exposed while the node had it; the node went back to an older agent: the port stays closed there.
    const { res, node } = await createDb("postgres");
    const serviceId = res.body.serviceId;
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie })).status).toBe(200);
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ enabled: true });
    advertise(node.id, [enginesCapability]);
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toEqual({ enabled: false });
    // A live agent's own capabilities count.
    const newer = fakeAgent(panel, node.id, {}, [], [enginesCapability, exposureCapability]);
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie })).status).toBe(200);
    newer.disconnect();
  });

  test("a database from before 0.2.9 names its old exposed user for the agent to retire", async () => {
    const { res, node } = await createDb("postgres");
    const serviceId = res.body.serviceId;
    const oldRow = (id: string, exposedUser: string) =>
      panel.deps.db.update(serviceDatabases).set({ exposedUser }).where(eq(serviceDatabases.serviceId, id)).run();
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.retiredExposedUser).toBe("");
    oldRow(serviceId, "external");
    // Sent whether or not exposure is on.
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database).toMatchObject({
      exposure: { enabled: false },
      retiredExposedUser: "external",
    });
    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database).toMatchObject({
      exposure: { enabled: true },
      retiredExposedUser: "external",
    });
    // Its exposed connection is the admin's now, not the old user's.
    expect((await callOp(panel, dbOps.get, { serviceId }, { cookie })).body.exposure.user).toBe("postgres");
    // Never the admin itself, never a Redis-like engine's one user.
    oldRow(serviceId, "postgres");
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.retiredExposedUser).toBe("");
    await settleDeploys(panel);
    const valkey = await createDb("valkey");
    oldRow(valkey.res.body.serviceId, "default");
    expect(databaseRuntime(panel.deps, valkey.res.body.serviceId, valkey.node.id)?.database.retiredExposedUser).toBe("");
  });

  test("the old exposed user stays while a running service still has its URL", async () => {
    const { res, node, project } = await createDb("postgres");
    const serviceId = res.body.serviceId;
    // A database from before 0.2.9: its separate exposed user and that user's password.
    panel.deps.db.update(serviceDatabases).set({ exposedUser: "external" }).where(eq(serviceDatabases.serviceId, serviceId)).run();
    writeSecret(panel.deps.db, panel.deps.secrets, serviceId, retiredExposedPasswordSecret, "OldExposed/Pass123");
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie })).status).toBe(200);
    const { seedService } = await import("./seed-helpers");
    const worker = seedService(panel, { projectId: project.id, name: "worker", nodeIds: [node.id] });
    await callOp(panel, envOps.set, { serviceId: worker.id, text: "DATABASE_URL=${{shop-db.EXPOSED_URL}}\n" }, { cookie });
    const deployment = (envSealed: string, generation: number) =>
      panel.deps.db
        .insert(deployments)
        .values({ serviceId: worker.id, generation, trigger: "manual", status: "live", imageRef: "nginx:1.27", envSealed })
        .returning()
        .get();
    const point = (values: { liveDeploymentId?: string; targetDeploymentId?: string }) =>
      panel.deps.db.update(services).set(values).where(eq(services.id, worker.id)).run();
    const retired = () => databaseRuntime(panel.deps, serviceId, node.id, compileMemo())?.database.retiredExposedUser;
    // The worker's deployment started before the update: the old user's URL is sealed in it (the password percent-encoded).
    const oldUrl = "postgresql://external:OldExposed%2FPass123@203.0.113.10:45432/shop_db?sslmode=require";
    const old = deployment(
      panel.deps.secrets.seal(JSON.stringify([{ name: "DATABASE_URL", value: oldUrl, secret: true }]), "deployment.env"),
      1,
    );
    point({ liveDeploymentId: old.id, targetDeploymentId: old.id });
    expect(retired()).toBe("");
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.retiredExposedUser).toBe("");
    // A redeploy seals the database's own user; while the old deployment still serves, the old user stays.
    const fresh = deployment(sealDeploymentEnv(panel.deps, worker.id), 2);
    expect(deploymentEnv(panel.deps, fresh.envSealed)?.[0]?.value).not.toContain("external");
    point({ targetDeploymentId: fresh.id });
    expect(retired()).toBe("");
    // Live: the retirement goes out, and the database it held back gets its spec again.
    const dirty = spyOn(panel.deps.agents.desired, "markDirty");
    point({ liveDeploymentId: fresh.id });
    publishDeploymentChange(panel.deps, worker.id, fresh.id);
    expect(dirty).toHaveBeenCalledWith({ serviceId });
    dirty.mockRestore();
    expect(retired()).toBe("external");
  });

  test("nodes without database.engines.v2 never get a new engine's exposure", async () => {
    const { res, node } = await createDb("clickhouse");
    const serviceId = res.body.serviceId;
    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ enabled: true });
    // The node went back to an older agent: the compiled spec keeps the port closed, and the op refuses.
    advertise(node.id, []);
    expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toEqual({ enabled: false });
    expect((await callOp(panel, dbOps.get, { serviceId }, { cookie })).body.exposure.state).toBe("waitingForNodeUpdate");
    const again = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
    expect(again.status).toBe(409);
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: false }, { cookie })).status).toBe(200);
  });

  test("an exposure the node's agent cannot keep TLS only reads as closed everywhere until the node is updated", async () => {
    const { res, node, project } = await createDb("postgres");
    const serviceId = res.body.serviceId;
    expect(res.body.exposure.state).toBe("off");
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie })).status).toBe(200);
    // The port the agent picked.
    panel.deps.db.update(portExposures).set({ listenPort: 45432 }).where(eq(portExposures.serviceId, serviceId)).run();
    const worker = seedService(panel, { projectId: project.id, name: "worker", nodeIds: [node.id] });
    const text = "OUT=${{shop-db.EXPOSED_URL}}\nOUT_HOST=${{shop-db.EXPOSED_HOST}}\nOUT_PORT=${{shop-db.EXPOSED_PORT}}\n";
    expect((await callOp(panel, envOps.set, { serviceId: worker.id, text }, { cookie })).status).toBe(200);
    const read = async () => {
      const env = Object.fromEntries(resolveServiceEnv(panel.deps, worker.id).map((v) => [v.name, v.value]));
      const analyzed = await callOp(panel, envOps.analyze, { serviceId: worker.id }, { cookie });
      return {
        exposure: (await callOp(panel, dbOps.get, { serviceId }, { cookie })).body.exposure,
        exposed: (await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.exposed,
        access: (await callOp(panel, exposureOps.get, { serviceId }, { cookie })).body.database,
        env: { OUT: env.OUT, OUT_HOST: env.OUT_HOST, OUT_PORT: env.OUT_PORT },
        problems: analyzed.body.diagnostics.map((d: { code: string }) => d.code),
        runtime: databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure,
      };
    };
    const open = await read();
    expect(open.exposure).toMatchObject({ enabled: true, state: "open", host: "203.0.113.10", port: 45432 });
    expect(open.exposed?.url).toContain("@203.0.113.10:45432/");
    expect(open.access).toMatchObject({ host: "203.0.113.10", port: 45432 });
    expect(open.env).toEqual({ OUT: open.exposed.url, OUT_HOST: "203.0.113.10", OUT_PORT: "45432" });
    expect(open.problems).toEqual([]);
    expect(open.runtime).toMatchObject({ enabled: true, hostPort: 45432 });

    // The node still runs an agent from before 0.2.9: the desired state keeps the port closed, and so does every reader.
    advertise(node.id, [enginesCapability]);
    const waiting = await read();
    expect(waiting.runtime).toEqual({ enabled: false });
    // The setting is kept (the switch stays on), without an address.
    expect(waiting.exposure).toMatchObject({ enabled: true, state: "waitingForNodeUpdate", host: null, port: null });
    expect(waiting.exposed).toBeNull();
    expect(waiting.access).toBeNull();
    // A deploy now gets no URL to a closed port, and the editor says the references have no value yet.
    expect(waiting.env).toEqual({ OUT: "", OUT_HOST: "", OUT_PORT: "" });
    expect(waiting.problems).toEqual(["empty-reference", "empty-reference", "empty-reference"]);

    // Updated, the same port opens again by itself.
    advertise(node.id, [enginesCapability, exposureCapability]);
    const updated = await read();
    expect(updated.exposure).toMatchObject({ enabled: true, state: "open", port: 45432 });
    expect(updated.exposed?.url).toBe(open.exposed.url);
    expect(updated.runtime).toMatchObject({ enabled: true, hostPort: 45432 });
  });

  test("open screens of a database waiting for its node read it again when the updated agent connects", async () => {
    const { res, node } = await createDb("postgres");
    const serviceId = res.body.serviceId;
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie })).status).toBe(200);
    // Exposed on another node: not told.
    const elsewhere = await createDb("postgres");
    const elsewhereId = elsewhere.res.body.serviceId;
    expect((await callOp(panel, dbOps.setExposure, { serviceId: elsewhereId, enabled: true }, { cookie })).status).toBe(200);
    advertise(node.id, [enginesCapability]);
    expect((await callOp(panel, dbOps.get, { serviceId }, { cookie })).body.exposure.state).toBe("waitingForNodeUpdate");
    const told: { topic: string; ops: string[] }[] = [];
    const socket = {
      id: "tab",
      send: (m: { type: string; topic?: string; event?: { ops?: string[] } }) => {
        if (m.type === "event" && m.topic) told.push({ topic: m.topic, ops: m.event?.ops ?? [] });
      },
    } as never;
    panel.deps.live.subscribe(socket, `service:${serviceId}`);
    panel.deps.live.subscribe(socket, `service:${elsewhereId}`);
    const refreshed = ["databases.get", "databases.connection", "exposures.get", "env.references"];
    // The node was updated: its hello stored the new facts, then its agent connects.
    advertise(node.id, [enginesCapability, exposureCapability]);
    fakeAgent(panel, node.id, {}, [], [enginesCapability, exposureCapability]);
    expect(told).toContainEqual({ topic: `service:${serviceId}`, ops: refreshed });
    expect(told.filter((t) => t.topic === `service:${elsewhereId}` && t.ops.includes("databases.get"))).toEqual([]);
    expect((await callOp(panel, dbOps.get, { serviceId }, { cookie })).body.exposure.state).toBe("open");
  });
});

describe("held retirements of an old exposed user", () => {
  const oldUrl = "postgresql://external:OldExposed%2FPass123@203.0.113.10:45432/shop_db?sslmode=require";

  /** A Postgres from before 0.2.9 (its separate exposed user and that user's password), its deploy settled. */
  async function oldDatabase() {
    const created = await createDb("postgres");
    const serviceId = created.res.body.serviceId as string;
    panel.deps.db.update(serviceDatabases).set({ exposedUser: "external" }).where(eq(serviceDatabases.serviceId, serviceId)).run();
    writeSecret(panel.deps.db, panel.deps.secrets, serviceId, retiredExposedPasswordSecret, "OldExposed/Pass123");
    await settleDeploys(panel);
    // What the node's spec names for retirement: "" while held back.
    const compiled = () => databaseRuntime(panel.deps, serviceId, created.node.id, compileMemo())?.database.retiredExposedUser;
    return { ...created, serviceId, compiled };
  }

  /** A deployment of serviceId, live and target, whose env carries value. */
  function runWith(serviceId: string, value: string, generation = 1) {
    const envSealed = panel.deps.secrets.seal(JSON.stringify([{ name: "DATABASE_URL", value, secret: true }]), "deployment.env");
    const row = panel.deps.db
      .insert(deployments)
      .values({ serviceId, generation, trigger: "manual", status: "live", imageRef: "nginx:1.27", envSealed })
      .returning()
      .get();
    panel.deps.db.update(services).set({ liveDeploymentId: row.id, targetDeploymentId: row.id }).where(eq(services.id, serviceId)).run();
    return row;
  }

  /** How often serviceId was marked dirty since the spy started. */
  const marks = (spy: { mock: { calls: unknown[][] } }, serviceId: string) =>
    spy.mock.calls.filter(([target]) => (target as { serviceId?: string }).serviceId === serviceId).length;

  test("a stopped service still holds it; one of another project that is deleted releases it at once", async () => {
    const { serviceId, node, compiled } = await oldDatabase();
    // The old URL copied into a service of another project (references stay within one project).
    const other = seedProject(panel);
    const worker = seedService(panel, { projectId: other.id, name: "worker", nodeIds: [node.id] });
    runWith(worker.id, oldUrl);
    expect(compiled()).toBe("");
    const dirty = spyOn(panel.deps.agents.desired, "markDirty");
    // Stopped, it starts again with the same sealed env (services.start, a clone's data copy, an undone
    // move), so the old user keeps working for it: nothing is sent, not even by the sweep.
    expect((await callOp(panel, serviceOps.stop, { serviceId: worker.id }, { cookie })).status).toBe(200);
    expect(releaseHeldRetirements(panel.deps)).toEqual([]);
    expect(marks(dirty, serviceId)).toBe(0);
    expect(compiled()).toBe("");
    expect((await callOp(panel, serviceOps.start, { serviceId: worker.id }, { cookie })).status).toBe(200);
    expect(compiled()).toBe("");
    // Deleted, it is gone.
    expect((await callOp(panel, serviceOps.remove, { serviceId: worker.id, confirmName: "worker" }, { cookie })).status).toBe(200);
    expect(marks(dirty, serviceId)).toBe(1);
    dirty.mockRestore();
    expect(compiled()).toBe("external");
  });

  test("a deployment going live in another project sends the retirement it released", async () => {
    const { serviceId, node, compiled } = await oldDatabase();
    const other = seedProject(panel);
    const worker = seedService(panel, { projectId: other.id, name: "worker", nodeIds: [node.id] });
    runWith(worker.id, oldUrl);
    expect(compiled()).toBe("");
    const dirty = spyOn(panel.deps.agents.desired, "markDirty");
    // Redeployed with a URL of its own: the old one runs nowhere any more.
    const fresh = runWith(worker.id, "postgresql://app:Fresh123@203.0.113.10:45432/shop_db?sslmode=require", 2);
    publishDeploymentChange(panel.deps, worker.id, fresh.id);
    expect(marks(dirty, serviceId)).toBe(1);
    dirty.mockRestore();
    expect(compiled()).toBe("external");
  });

  test("the sweep marks nothing while nothing changed, and a release once", async () => {
    const { serviceId, node, project, compiled } = await oldDatabase();
    const worker = seedService(panel, { projectId: project.id, name: "worker", nodeIds: [node.id] });
    runWith(worker.id, oldUrl);
    const dirty = spyOn(panel.deps.agents.desired, "markDirty");
    // Nothing compiled held anything back yet.
    expect(releaseHeldRetirements(panel.deps)).toEqual([]);
    expect(compiled()).toBe("");
    // Still held: sweep after sweep leaves it alone.
    expect(releaseHeldRetirements(panel.deps)).toEqual([]);
    expect(releaseHeldRetirements(panel.deps)).toEqual([]);
    expect(marks(dirty, serviceId)).toBe(0);
    // Released by something no hook sees (the worker's deployments are gone): the next sweep sends it, once.
    panel.deps.db.update(services).set({ liveDeploymentId: null, targetDeploymentId: null }).where(eq(services.id, worker.id)).run();
    expect(releaseHeldRetirements(panel.deps)).toEqual([serviceId]);
    expect(releaseHeldRetirements(panel.deps)).toEqual([]);
    expect(compiled()).toBe("external");
    expect(releaseHeldRetirements(panel.deps)).toEqual([]);
    expect(marks(dirty, serviceId)).toBe(1);
    dirty.mockRestore();
    // The databases module runs it every minute.
    const databasesModule = (await import("../src/modules/databases")).default;
    expect(databasesModule.jobs?.map((j) => j.type)).toContain("databases.retirements");
  });
});
