import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { databases as dbOps, exposures as exposureOps } from "@seylo/ops";
import { DatabaseEngine } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { serviceSecrets, services } from "../src/db/schema";
import { databaseRuntime } from "../src/modules/databases/desired";
import { edgeSubject, verifyEdgeTicket } from "../src/modules/databases/edge-ticket";
import { changePasswordExec, connectionUrl, generatePassword } from "../src/modules/databases/engines";
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

async function createDb(engine: "postgres" | "mysql" | "mariadb" | "mongo" | "redis", extra: Record<string, unknown> = {}) {
  const project = seedProject(panel);
  const node = seedNode(panel, { ipv4: "203.0.113.10", wildcard: "n1.example.com" });
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
    for (const engine of ["postgres", "mysql", "mariadb", "mongo", "redis"] as const) {
      const exec = changePasswordExec(engine, "admin", "NewSecret123");
      expect(exec.command.join(" ")).not.toContain("NewSecret123");
      expect(exec.stdin).toContain("NewSecret123");
    }
  });
});

describe("databases ops", () => {
  test("create writes a pinned image, a data volume and sealed credentials", async () => {
    const { res, node } = await createDb("postgres");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "shop-db",
      engine: "postgres",
      version: "17",
      nodeId: node.id,
      internal: { host: "shop-db", port: 5432, database: "shop_db", user: "postgres" },
      exposure: { enabled: false, host: null, port: null, user: "external", certificate: "none" },
      webUi: { tool: "pgweb", idleMinutes: 15, running: false },
    });
    const row = panel.deps.db.select().from(services).where(eq(services.id, res.body.serviceId)).get();
    expect(row?.kind).toBe("postgres");
    expect(JSON.stringify(row?.spec)).toContain("postgres:17.6-alpine");
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
