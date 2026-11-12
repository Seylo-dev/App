// The Users tab's ops against a fake agent whose Exec answers like the
// engine (the scripts themselves run in database-users-scripts.test.ts
// and on real images in the VM): listing with what may be done with each
// user, the stored main user only ever after the engine took a change,
// what is refused and why, restarts for the engines that need one, the
// services to redeploy, permissions, audit redaction, MCP approval and
// one change at a time per database.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { databases as dbOps, env as envOps } from "@seylo/ops";
import { and, eq, ne } from "drizzle-orm";
import { callTimedOut } from "../src/agent-hub/calls";
import { apiKeys, auditLog, deployments, nodes, serviceDatabases, serviceSecrets, services } from "../src/db/schema";
import { enginesCapability } from "../src/modules/databases/engines";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { hashToken, prefixedToken } from "../src/security/tokens";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, seedService, settleDeploys } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
let ownerId: string;
beforeEach(async () => {
  panel = testPanel();
  const owner = await createUser(panel, "owner");
  cookie = owner.cookie;
  ownerId = owner.user.id;
});
afterEach(async () => {
  await settleDeploys(panel);
  panel.close();
});

type Engine = "postgres" | "mysql" | "mariadb" | "mongo" | "redis" | "dragonfly" | "clickhouse";
type Call = { command: string[]; stdin: string };
type Reply = { exitCode?: number; stdout?: string; stderr?: string };

/** A database as databases.create makes it, with its first deploy settled. */
async function createDb(engine: Engine, extra: Record<string, unknown> = {}) {
  const project = seedProject(panel);
  const node = seedNode(panel);
  panel.deps.db
    .update(nodes)
    .set({ facts: { capabilities: [enginesCapability] } })
    .where(eq(nodes.id, node.id))
    .run();
  const res = await callOp(
    panel,
    dbOps.create,
    { projectId: project.id, name: "shop-db", engine, nodeId: node.id, password: "StoredPassword01", ...extra } as never,
    {
      cookie,
    },
  );
  expect(res.status).toBe(200);
  await settleDeploys(panel);
  // The first deploy found no agent: settled either way, so no deploy is running.
  panel.deps.db.update(deployments).set({ status: "failed" }).where(eq(deployments.serviceId, res.body.serviceId)).run();
  return { project, node, serviceId: res.body.serviceId as string };
}

const isList = (c: Call) =>
  c.stdin.includes("json_build_object('kind', 'server'") ||
  c.stdin.includes("SELECT JSON_OBJECT('user'") ||
  c.stdin.includes("usersInfo") ||
  c.stdin.includes("FROM system.users");

/** The agent's Exec: lists answer with rows, anything else with reply (exit 0 by default). */
function engineAgent(nodeId: string, rows: () => string, reply: (c: Call) => Reply | Promise<Reply> = () => ({})) {
  const seen: Call[] = [];
  const agent = fakeAgent(panel, nodeId, {
    exec: async (req: { command: string[]; stdin: Uint8Array }) => {
      const call = { command: req.command, stdin: new TextDecoder().decode(req.stdin) };
      seen.push(call);
      const r = isList(call) ? { stdout: rows() } : await reply(call);
      return {
        exitCode: r.exitCode ?? 0,
        stdout: new TextEncoder().encode(r.stdout ?? ""),
        stderr: new TextEncoder().encode(r.stderr ?? ""),
      };
    },
  });
  return { seen, changes: () => seen.filter((c) => !isList(c)), agent };
}

const pgRows = (owns = 2) =>
  [
    '{"kind" : "server", "version" : 180006, "databases" : ["postgres", "shop_db", "template1"]}',
    '{"kind" : "user", "name" : "postgres", "bootstrap" : true, "super" : true, "createrole" : true, "createdb" : true, "expired" : false, "password" : "scram", "memberOf" : [], "owns" : 0}',
    `{"kind" : "user", "name" : "app", "bootstrap" : false, "super" : false, "createrole" : false, "createdb" : false, "expired" : false, "password" : "scram", "memberOf" : ["pg_read_all_data", "pg_write_all_data"], "owns" : ${owns}}`,
    '{"kind" : "user", "name" : "legacy", "bootstrap" : false, "super" : false, "createrole" : false, "createdb" : false, "expired" : false, "password" : "md5", "memberOf" : [], "owns" : 0}',
  ].join("\n");

const mysqlRows = (definers = 0) =>
  [
    '{"user": "root", "host": "%", "locked": 0, "global": "select,insert,update,delete,create,drop,alter,index,createRoutine,event,grant,super,createUser", "db": null, "definers": 0}',
    '{"user": "root", "host": "localhost", "locked": 0, "global": "select,insert,update,delete,create,drop,alter,index,createRoutine,event,grant,super,createUser", "db": null, "definers": 0}',
    `{"user": "app", "host": "%", "locked": 0, "global": "", "db": "select,insert,update,delete", "definers": ${definers}}`,
    '{"user": "odd\\\\name", "host": "%", "locked": 0, "global": "", "db": "select", "definers": 0}',
  ].join("\n");

const mongoRows = () =>
  [
    'admin> {"kind":"user","user":"root","db":"admin","roles":[{"role":"root","db":"admin"}],"mechanisms":["SCRAM-SHA-256"]}',
    '{"kind":"user","user":"app","db":"admin","roles":[{"role":"readWrite","db":"shop_db"}],"mechanisms":["SCRAM-SHA-256"]}',
  ].join("\n");

const storedAdmin = (serviceId: string) =>
  panel.deps.db.select({ user: serviceDatabases.adminUser }).from(serviceDatabases).where(eq(serviceDatabases.serviceId, serviceId)).get()
    ?.user;
const storedPassword = async (serviceId: string) =>
  (await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.internal.password;
/** Deploys queued after the database's first one (createDb marks that one failed). */
const queued = (serviceId: string) =>
  panel.deps.db
    .select()
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), ne(deployments.generation, 1)))
    .all();

describe("databases.users", () => {
  test("Postgres: the main user first, what each one may do, and the presets", async () => {
    const { node, serviceId } = await createDb("postgres");
    const { agent } = engineAgent(node.id, () => pgRows());
    const res = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      engine: "postgres",
      presets: ["readOnly", "readWrite", "serverAdmin"],
      hosts: false,
      canCreate: true,
      notice: null,
      main: { user: "postgres", rename: "inPlace", canSwitch: true },
      signIn: "ok",
      truncated: false,
    });
    const users = res.body.users as { name: string }[];
    expect(users.map((u) => u.name)).toEqual(["postgres", "app", "legacy"]);
    expect(res.body.users[0]).toMatchObject({
      main: true,
      system: false,
      access: "serverAdmin",
      can: { passwordChange: true, rename: true, delete: false, makeMain: false },
    });
    expect(res.body.users[1]).toMatchObject({
      access: "readWrite",
      ownsObjects: 2,
      can: { passwordChange: true, rename: true, delete: true, makeMain: true },
    });
    // An md5 password is cleared by a rename, so the rename asks for one.
    expect(res.body.users[2]).toMatchObject({ access: "custom", passwordForRename: true });
    agent.disconnect();
  });

  test("offline: only the stored main user, nothing to change; the Redis-likes: default and why", async () => {
    const { serviceId } = await createDb("postgres");
    const offline = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    expect(offline.body).toMatchObject({ signIn: "offline", users: [{ name: "postgres", main: true, can: { passwordChange: false } }] });
    expect(offline.body.message).toContain("is not connected");

    const redis = await createDb("redis");
    const r = await callOp(panel, dbOps.users, { serviceId: redis.serviceId }, { cookie });
    expect(r.body).toMatchObject({ presets: [], canCreate: false, main: { user: "default", rename: "none", canSwitch: false } });
    expect(r.body.notice).toContain("one user, default");
    expect(r.body.notice).toContain("ACL SETUSER");
    const made = await callOp(panel, dbOps.createUser, { serviceId: redis.serviceId, name: "app", access: "readOnly" }, { cookie });
    expect(made.status).toBe(409);
    expect(made.body.error.details.reason).toBe("notOffered");
  });

  test("MySQL: root's two rows, a name Seylo leaves to the shell, root out of step shows the main user alone", async () => {
    const { node, serviceId } = await createDb("mysql");
    let rootSignsIn = true;
    const { agent } = engineAgent(
      node.id,
      () => mysqlRows(),
      (c) => (c.stdin.includes("CURRENT_USER") || c.command.join(" ").includes("CURRENT_USER") ? { stdout: "root@%\n" } : {}),
    );
    const res = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    const byKey = Object.fromEntries((res.body.users as { name: string; host: string }[]).map((u) => [`${u.name}@${u.host}`, u]));
    expect(byKey["root@%"]).toMatchObject({ main: true, can: { rename: true, delete: false } });
    expect(byKey["root@localhost"]).toMatchObject({ system: true, can: { passwordChange: false, rename: false, delete: false } });
    expect(byKey["odd\\name@%"]).toMatchObject({ can: { passwordChange: false, rename: false, delete: false } });
    expect(res.body.main).toMatchObject({ rename: "switch" });
    agent.disconnect();

    // Root refuses both passwords (exit 10); the main user signs in by itself.
    const out = engineAgent(
      node.id,
      () => "",
      (c) => (c.command.join(" ").includes("CURRENT_USER") ? { stdout: "root@%\n" } : {}),
    );
    out.agent.disconnect();
    const late = fakeAgent(panel, node.id, {
      exec: (req: { command: string[] }) =>
        req.command.join(" ").includes("CURRENT_USER") && rootSignsIn
          ? { exitCode: 0, stdout: new TextEncoder().encode("root@%\n") }
          : { exitCode: 10 },
    });
    const outOfStep = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    expect(outOfStep.body).toMatchObject({ signIn: "ok", canCreate: false, presets: [], users: [{ name: "root", main: true }] });
    expect(outOfStep.body.message).toContain("root user kept an older password");
    rootSignsIn = false;
    const failed = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    expect(failed.body).toMatchObject({ signIn: "failed", users: [{ name: "root", main: true, can: { passwordChange: true } }] });
    late.disconnect();
  });
});

describe("making and changing users", () => {
  test("createUser: a verifier, the password once, this user's URLs, nothing stored", async () => {
    const { node, serviceId } = await createDb("postgres");
    const { changes, agent } = engineAgent(node.id, () => pgRows());
    const made = await callOp(panel, dbOps.createUser, { serviceId, name: "app_ro", access: "readOnly" }, { cookie });
    expect(made.status).toBe(200);
    expect(made.body.password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(made.body.internalUrl).toBe(`postgresql://app_ro:${made.body.password}@shop-db:5432/shop_db`);
    expect(made.body.exposedUrl).toBeNull();
    const [create] = changes();
    expect(create?.stdin).toContain('CREATE ROLE "app_ro" LOGIN PASSWORD \'SCRAM-SHA-256$4096:');
    expect(create?.stdin).toContain('GRANT pg_read_all_data TO "app_ro";');
    expect(create?.stdin).not.toContain(made.body.password);
    expect(create?.command.join(" ")).not.toContain(made.body.password);
    // Seylo keeps only the main user's password.
    const secrets = panel.deps.db.select().from(serviceSecrets).where(eq(serviceSecrets.serviceId, serviceId)).all();
    expect(secrets.map((s) => s.name)).toEqual(["admin_password"]);
    expect(await storedPassword(serviceId)).toBe("StoredPassword01");

    const refused = async (input: Record<string, unknown>) =>
      (await callOp(panel, dbOps.createUser, { serviceId, access: "readOnly", ...input } as never, { cookie })).body.error;
    expect(await refused({ name: "app" })).toMatchObject({ details: { reason: "exists" } });
    expect(await refused({ name: "pg_mine" })).toMatchObject({ code: "BAD_REQUEST", details: { field: "name" } });
    expect(await refused({ name: "dba", access: "databaseAdmin" })).toMatchObject({ code: "BAD_REQUEST", details: { field: "access" } });
    expect(await refused({ name: "x", host: "%" })).toMatchObject({ details: { field: "host" } });
    // A failure is refused, and the engine's words lose the password.
    agent.disconnect();
    const failing = engineAgent(
      node.id,
      () => pgRows(),
      (c) => (c.stdin.includes("CREATE ROLE") ? { exitCode: 3, stderr: "ERROR:  near SecretPassword123" } : {}),
    );
    const failed = await callOp(
      panel,
      dbOps.createUser,
      { serviceId, name: "app2", access: "readOnly", password: "SecretPassword123" },
      { cookie },
    );
    expect(failed.status).toBe(409);
    expect(failed.body.error).toMatchObject({ details: { reason: "execFailed" } });
    expect(failed.body.error.message).toContain("[redacted]");
    expect(failed.body.error.message).not.toContain("SecretPassword123");
    failing.agent.disconnect();
  });

  test("another user's password changes in the engine only; root@localhost's never on its own", async () => {
    const { node, serviceId } = await createDb("mysql");
    const { changes, agent } = engineAgent(node.id, () => mysqlRows());
    const set = await callOp(
      panel,
      dbOps.setUserPassword,
      { serviceId, user: { name: "app", host: "%" }, password: "AppPassword0001" },
      { cookie },
    );
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ password: "AppPassword0001", affectedServiceIds: [], deploymentId: null, warning: null });
    expect(changes()[0]?.stdin).toContain("ALTER USER 'app'@'%' IDENTIFIED BY 'AppPassword0001';");
    expect(await storedPassword(serviceId)).toBe("StoredPassword01");
    const root = await callOp(panel, dbOps.setUserPassword, { serviceId, user: { name: "root", host: "localhost" } }, { cookie });
    expect(root.body.error.details.reason).toBe("systemUser");
    const missing = await callOp(panel, dbOps.setUserPassword, { serviceId, user: { name: "nobody", host: "%" } }, { cookie });
    expect(missing.body.error.details.reason).toBe("notFound");
    agent.disconnect();
  });

  test("the main user's password signs in with what Seylo stores, twice in a row (MongoDB) and as the stored name (Postgres)", async () => {
    const mongo = await createDb("mongo");
    const m = engineAgent(mongo.node.id, () => mongoRows());
    expect(
      (
        await callOp(
          panel,
          dbOps.setUserPassword,
          { serviceId: mongo.serviceId, user: { name: "root" }, password: "FirstPassword01" },
          { cookie },
        )
      ).status,
    ).toBe(200);
    expect(
      (await callOp(panel, dbOps.resetPassword, { serviceId: mongo.serviceId, user: "internal", password: "SecondPassword1" }, { cookie }))
        .status,
    ).toBe(200);
    const [first, second] = m.changes();
    // Not the container's first password: the stored one, which the first change replaced.
    expect(first?.stdin).toContain('admin.auth("root", "StoredPassword01")');
    expect(second?.stdin).toContain('admin.auth("root", "FirstPassword01")');
    expect(second?.stdin).toContain('changeUserPassword("root", "SecondPassword1")');
    expect(second?.command).toEqual(["mongosh", "--quiet", "--norc", "mongodb://127.0.0.1:27017/admin"]);
    expect(await storedPassword(mongo.serviceId)).toBe("SecondPassword1");
    m.agent.disconnect();
    await settleDeploys(panel);

    const pg = await createDb("postgres", { user: "owner_user" });
    const p = engineAgent(pg.node.id, () => pgRows());
    expect(
      (await callOp(panel, dbOps.resetPassword, { serviceId: pg.serviceId, user: "internal", password: "PgPassword00001" }, { cookie }))
        .status,
    ).toBe(200);
    const [reset] = p.changes();
    expect(reset?.command).toContain("--username=owner_user");
    expect(reset?.stdin.split("\n")[0]).toBe("StoredPassword01");
    expect(reset?.stdin).toMatch(/ALTER ROLE "owner_user" PASSWORD 'SCRAM-SHA-256\$4096:/);
    expect(reset?.stdin).not.toContain("PgPassword00001");
    p.agent.disconnect();
  });

  test("a main password Seylo lost: known stores the one that works after signing in with it, the engine untouched", async () => {
    const { node, serviceId } = await createDb("mongo");
    let works = "WorkingPassword1";
    const { seen, agent } = engineAgent(
      node.id,
      () => mongoRows(),
      (c) => ({ exitCode: c.stdin.includes(`"${works}"`) ? 0 : 10 }),
    );
    const wrong = await callOp(
      panel,
      dbOps.setUserPassword,
      { serviceId, user: { name: "root" }, password: "NotItPassword01", known: true },
      { cookie },
    );
    expect(wrong.body.error.details.reason).toBe("signInFailed");
    expect(await storedPassword(serviceId)).toBe("StoredPassword01");
    const right = await callOp(
      panel,
      dbOps.setUserPassword,
      { serviceId, user: { name: "root" }, password: works, known: true },
      { cookie },
    );
    expect(right.status).toBe(200);
    expect(await storedPassword(serviceId)).toBe(works);
    expect(seen.every((c) => !c.stdin.includes("changeUserPassword"))).toBe(true);
    works = "";
    agent.disconnect();
  });

  test("Redis, Valkey, KeyDB and Dragonfly restart with a new password, which needs services.deploy", async () => {
    for (const engine of ["redis", "dragonfly"] as const) {
      const { node, serviceId, project } = await createDb(engine);
      const { seen, agent } = engineAgent(node.id, () => "");
      const app = seedService(panel, { projectId: project.id, name: `app-${engine}`, nodeIds: [node.id] });
      await callOp(panel, envOps.set, { serviceId: app.id, text: "R=${{shop-db.INTERNAL_URL}}\n" }, { cookie });
      const res = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal", password: "FreshPassword123" }, { cookie });
      expect(res.status).toBe(200);
      expect(res.body.affectedServiceIds).toEqual([app.id]);
      // CONFIG SET changes the running Redis only; its container would start with the old password again.
      expect(seen).toHaveLength(engine === "redis" ? 1 : 0);
      const deployment = queued(serviceId);
      expect(deployment.map((d) => d.id)).toEqual([res.body.deploymentId]);
      expect(resolveServiceEnv(panel.deps, serviceId).map((v) => v.value)).toContain("FreshPassword123");
      agent.disconnect();
      await settleDeploys(panel);
      // Someone who may see the credentials but not deploy: refused before anything changes.
      const member = await createUser(panel, "member");
      grant(panel, member.user.id, "service", serviceId, ["services.view", "databases.credentials"]);
      const refused = await callOp(
        panel,
        dbOps.resetPassword,
        { serviceId, user: "internal", password: "OtherPassword12" },
        { cookie: member.cookie },
      );
      expect(refused.status).toBe(403);
      expect(await storedPassword(serviceId)).toBe("FreshPassword123");
    }
  });
});

describe("the main user's name", () => {
  test("Postgres renames in place, stores the name after the engine took it, restarts, and lists the services using USER", async () => {
    const { node, serviceId, project } = await createDb("postgres");
    let fail = true;
    const { changes, agent } = engineAgent(
      node.id,
      () => pgRows(),
      () => ({ exitCode: fail ? 3 : 0 }),
    );
    const userOnly = seedService(panel, { projectId: project.id, name: "reports", nodeIds: [node.id] });
    await callOp(panel, envOps.set, { serviceId: userOnly.id, text: "DB_USER=${{shop-db.USER}}\n" }, { cookie });
    const failed = await callOp(panel, dbOps.renameUser, { serviceId, user: { name: "postgres" }, name: "boss" }, { cookie });
    expect(failed.body.error.details.reason).toBe("execFailed");
    expect(storedAdmin(serviceId)).toBe("postgres");
    expect(queued(serviceId)).toHaveLength(0);
    fail = false;
    const renamed = await callOp(panel, dbOps.renameUser, { serviceId, user: { name: "postgres" }, name: "boss" }, { cookie });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ user: { name: "boss" }, password: null, affectedServiceIds: [userOnly.id], warning: null });
    expect(changes().at(-1)?.stdin).toContain("SET SESSION AUTHORIZATION");
    expect(storedAdmin(serviceId)).toBe("boss");
    expect(queued(serviceId).map((d) => d.id)).toEqual([renamed.body.deploymentId]);
    agent.disconnect();
  });

  test("Postgres with deploy: false leaves the restart; MySQL's root and MongoDB switch instead; ClickHouse restarts", async () => {
    const pg = await createDb("postgres");
    const p = engineAgent(pg.node.id, () => pgRows());
    const later = await callOp(
      panel,
      dbOps.renameUser,
      { serviceId: pg.serviceId, user: { name: "postgres" }, name: "boss", deploy: false },
      { cookie },
    );
    expect(later.body.deploymentId).toBeNull();
    expect(queued(pg.serviceId)).toHaveLength(0);
    p.agent.disconnect();
    await settleDeploys(panel);

    for (const engine of ["mysql", "mongo"] as const) {
      const db = await createDb(engine);
      const res = await callOp(panel, dbOps.renameUser, { serviceId: db.serviceId, user: { name: "root" }, name: "boss" }, { cookie });
      expect(res.body.error.details.reason).toBe("useSwitchMainUser");
      await settleDeploys(panel);
    }

    const ch = await createDb("clickhouse", { user: "ch_admin" });
    // Not running: nothing to check against, the new environment is the change.
    const res = await callOp(
      panel,
      dbOps.renameUser,
      { serviceId: ch.serviceId, user: { name: "ch_admin" }, name: "boss", password: "BossPassword123" },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(storedAdmin(ch.serviceId)).toBe("boss");
    expect(queued(ch.serviceId).map((d) => d.id)).toEqual([res.body.deploymentId]);
    const env = Object.fromEntries(resolveServiceEnv(panel.deps, ch.serviceId).map((v) => [v.name, v.value]));
    expect(env).toMatchObject({ CLICKHOUSE_USER: "boss", CLICKHOUSE_PASSWORD: "BossPassword123" });
  });

  test("switch: proved before it is stored, a made user goes again when the proof fails; MySQL gives root the password", async () => {
    const { node, serviceId } = await createDb("mongo");
    let proof = 10;
    const { changes, agent } = engineAgent(
      node.id,
      () => mongoRows(),
      (c) => (c.stdin.includes("connectionStatus") ? { exitCode: proof } : {}),
    );
    const failed = await callOp(panel, dbOps.switchMainUser, { serviceId, name: "boss", password: "BossPassword123" }, { cookie });
    expect(failed.body.error.details.reason).toBe("signInFailed");
    expect(changes().map((c) => /createUser|connectionStatus|dropUser/.exec(c.stdin)?.[0])).toEqual([
      "createUser",
      "connectionStatus",
      "dropUser",
    ]);
    expect(storedAdmin(serviceId)).toBe("root");
    expect(await storedPassword(serviceId)).toBe("StoredPassword01");
    proof = 0;
    const ok = await callOp(panel, dbOps.switchMainUser, { serviceId, name: "boss", password: "BossPassword123" }, { cookie });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ user: "boss", password: "BossPassword123", deploymentId: null, warning: null });
    expect(storedAdmin(serviceId)).toBe("boss");
    expect(await storedPassword(serviceId)).toBe("BossPassword123");
    // An existing user without root needs grantAdmin.
    const existing = await callOp(panel, dbOps.switchMainUser, { serviceId, name: "app", existing: true }, { cookie });
    expect(existing.body.error.details.reason).toBe("notAdmin");
    agent.disconnect();
    await settleDeploys(panel);

    const mysql = await createDb("mysql");
    const m = engineAgent(
      mysql.node.id,
      () => mysqlRows(),
      () => ({}),
    );
    const switched = await callOp(
      panel,
      dbOps.switchMainUser,
      { serviceId: mysql.serviceId, name: "boss", password: "BossPassword123", oldUser: "delete" },
      { cookie },
    );
    expect(switched.status).toBe(200);
    const after = m.changes().at(-1)?.stdin ?? "";
    expect(after).toContain("ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY 'BossPassword123';");
    expect(after).toContain("DROP USER IF EXISTS 'root'@'%';");
    expect(storedAdmin(mysql.serviceId)).toBe("boss");
    // Root always has the main user's password: the env gives root the new one on the next deploy.
    const env = Object.fromEntries(resolveServiceEnv(panel.deps, mysql.serviceId).map((v) => [v.name, v.value]));
    expect(env).toMatchObject({ MYSQL_ROOT_PASSWORD: "BossPassword123", MYSQL_USER: "boss" });
    m.agent.disconnect();
  });
});

describe("the main user when a step fails or gets no answer", () => {
  /** The proof of a sign-in as a new main user (proofExec), per engine. */
  const isProof = (c: Call) =>
    c.command.join(" ").includes("SELECT current_user") ||
    c.command.join(" ").includes("CURRENT_USER()") ||
    c.stdin.includes("connectionStatus");

  test("switch: removing MySQL's root@% is refused while objects run as it, as a delete is", async () => {
    const { node, serviceId } = await createDb("mysql");
    const rows = () => mysqlRows().replace('"db": null, "definers": 0}', '"db": null, "definers": 2}');
    const { changes, agent } = engineAgent(node.id, rows);
    const list = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    expect(list.body.users[0]).toMatchObject({ name: "root", host: "%", main: true, definerObjects: 2 });
    const refused = await callOp(panel, dbOps.switchMainUser, { serviceId, name: "boss", oldUser: "delete" }, { cookie });
    expect(refused.body.error.details).toMatchObject({ reason: "definerObjects", count: "2" });
    expect(changes()).toHaveLength(0);
    expect(storedAdmin(serviceId)).toBe("root");
    const accepted = await callOp(
      panel,
      dbOps.switchMainUser,
      { serviceId, name: "boss", oldUser: "delete", acceptOrphanDefiners: true },
      { cookie },
    );
    expect(accepted.status).toBe(200);
    expect(changes().at(-1)?.stdin).toContain("DROP USER IF EXISTS 'root'@'%';");
    agent.disconnect();
  });

  test("switch: stored once the new main user signed in; root's password without an answer is a warning", async () => {
    const { node, serviceId } = await createDb("mysql");
    const { changes, agent } = engineAgent(
      node.id,
      () => mysqlRows(),
      (c) => {
        if (c.stdin.includes("ALTER USER IF EXISTS 'root'@'localhost'")) throw callTimedOut(node.id, "exec");
        return {};
      },
    );
    const res = await callOp(
      panel,
      dbOps.switchMainUser,
      { serviceId, name: "boss", password: "BossPassword123", oldUser: "delete" },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.body.warning).toContain("did not answer while Seylo gave root the same password and removed 'root'@'%'");
    expect(res.body.warning).toContain("Set boss's password again on the Users tab");
    // boss signed in before root's step: Seylo signs in as boss whatever root's step did.
    expect(changes().map((c) => (isProof(c) ? "proof" : /CREATE USER|ALTER USER IF EXISTS/.exec(c.stdin)?.[0]))).toEqual([
      "CREATE USER",
      "proof",
      "ALTER USER IF EXISTS",
    ]);
    expect(storedAdmin(serviceId)).toBe("boss");
    expect(await storedPassword(serviceId)).toBe("BossPassword123");
    agent.disconnect();
  });

  test("switch: a proof without an answer removes the user made for it; nothing is stored", async () => {
    const { node, serviceId } = await createDb("postgres");
    const { changes, agent } = engineAgent(
      node.id,
      () => pgRows(),
      (c) => {
        if (isProof(c)) throw callTimedOut(node.id, "exec");
        return {};
      },
    );
    const res = await callOp(panel, dbOps.switchMainUser, { serviceId, name: "boss" }, { cookie });
    expect(res.status).toBe(503);
    expect(res.body.error.details.reason).toBe("noAnswer");
    expect(res.body.error.message).toContain("postgres is still the main user");
    expect(res.body.error.message).toContain("The boss it made for the switch is removed again.");
    expect(changes().at(-1)?.stdin).toContain('DROP ROLE "boss";');
    expect(storedAdmin(serviceId)).toBe("postgres");
    expect(await storedPassword(serviceId)).toBe("StoredPassword01");
    agent.disconnect();
  });

  test("switch to an existing user: never a locked one; full rights only after it signed in; a failed proof says its password changed", async () => {
    const { node, serviceId } = await createDb("postgres");
    const expired =
      '{"kind" : "user", "name" : "bob", "bootstrap" : false, "super" : false, "createrole" : false, "createdb" : false, "expired" : true, "password" : "scram", "memberOf" : [], "owns" : 0}';
    let proof = 10;
    const { changes, agent } = engineAgent(
      node.id,
      () => `${pgRows()}\n${expired}`,
      (c) => (isProof(c) ? { exitCode: proof, stderr: 'FATAL:  password authentication failed for user "app"' } : {}),
    );
    const list = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    const bob = (list.body.users as { name: string; why: string | null }[]).find((u) => u.name === "bob");
    expect(bob).toMatchObject({ locked: true, can: { makeMain: false } });
    expect(bob?.why).toContain("cannot sign in now");
    const locked = await callOp(panel, dbOps.switchMainUser, { serviceId, name: "bob", existing: true, grantAdmin: true }, { cookie });
    expect(locked.body.error.details.reason).toBe("locked");
    expect(changes()).toHaveLength(0);

    const failed = await callOp(panel, dbOps.switchMainUser, { serviceId, name: "app", existing: true, grantAdmin: true }, { cookie });
    expect(failed.body.error.details.reason).toBe("signInFailed");
    expect(failed.body.error.message).toContain("postgres is still the main user");
    expect(failed.body.error.message).toContain("app's password changed for the switch");
    // Only its password changed: no rights were added before the proof.
    expect(changes().map((c) => (isProof(c) ? "proof" : c.stdin.split("\n")[1]?.replace(/'SCRAM.*'/, "<verifier>")))).toEqual([
      'ALTER ROLE "app" LOGIN PASSWORD <verifier>;',
      "proof",
    ]);
    expect(storedAdmin(serviceId)).toBe("postgres");

    proof = 0;
    const ok = await callOp(panel, dbOps.switchMainUser, { serviceId, name: "app", existing: true, grantAdmin: true }, { cookie });
    expect(ok.status).toBe(200);
    expect(
      changes()
        .slice(2)
        .map((c) => (isProof(c) ? "proof" : c.stdin.split("\n")[1]?.replace(/'SCRAM.*'/, "<verifier>"))),
    ).toEqual(['ALTER ROLE "app" LOGIN PASSWORD <verifier>;', "proof", 'ALTER ROLE "app" SUPERUSER CREATEDB CREATEROLE;']);
    expect(storedAdmin(serviceId)).toBe("app");
    agent.disconnect();
  });

  test("a Postgres main rename without an answer: stored when Seylo signs in with the new name, else nothing", async () => {
    const { node, serviceId } = await createDb("postgres");
    let renamed = 0;
    const { changes, agent } = engineAgent(
      node.id,
      () => pgRows(),
      (c) => {
        if (c.stdin.includes("RENAME TO")) throw callTimedOut(node.id, "exec");
        return isProof(c) ? { exitCode: renamed } : {};
      },
    );
    renamed = 10;
    const lost = await callOp(panel, dbOps.renameUser, { serviceId, user: { name: "postgres" }, name: "boss", deploy: false }, { cookie });
    expect(lost.status).toBe(503);
    expect(lost.body.error.details.reason).toBe("noAnswer");
    expect(storedAdmin(serviceId)).toBe("postgres");
    renamed = 0;
    const res = await callOp(panel, dbOps.renameUser, { serviceId, user: { name: "postgres" }, name: "boss", deploy: false }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.warning).toContain("did not answer the rename, but boss signs in");
    const proof = changes().at(-1);
    expect(proof?.command).toContain("--username=boss");
    // The rename keeps a SCRAM password: the stored one.
    expect(proof?.stdin).toBe("StoredPassword01\n");
    expect(storedAdmin(serviceId)).toBe("boss");
    agent.disconnect();
  });

  test("a MySQL main rename with a password is stored before root gets it; root's step without an answer is a warning", async () => {
    const { node, serviceId } = await createDb("mysql", { user: "shop" });
    const rows = () =>
      `${mysqlRows()}\n{"user": "shop", "host": "%", "locked": 0, "global": "select,insert,update,delete,create,drop,alter,index,createRoutine,event,grant,super,createUser", "db": null, "definers": 0}`;
    const { agent } = engineAgent(node.id, rows, (c) => {
      if (c.stdin.includes("ALTER USER IF EXISTS 'root'@'%'")) throw callTimedOut(node.id, "exec");
      return {};
    });
    const res = await callOp(
      panel,
      dbOps.renameUser,
      { serviceId, user: { name: "shop", host: "%" }, name: "boss", password: "BossPassword123" },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.body.warning).toContain("did not answer while Seylo gave root the new password too");
    expect(storedAdmin(serviceId)).toBe("boss");
    expect(await storedPassword(serviceId)).toBe("BossPassword123");
    agent.disconnect();
  });

  test("a main password change without an answer is stored only when the new password signs in", async () => {
    const { node, serviceId } = await createDb("mongo");
    let works = 10;
    const { agent } = engineAgent(
      node.id,
      () => mongoRows(),
      (c) => {
        if (c.stdin.includes("changeUserPassword")) throw callTimedOut(node.id, "exec");
        return isProof(c) && c.stdin.includes('"NewPassword0001"') ? { exitCode: works } : {};
      },
    );
    const lost = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal", password: "NewPassword0001" }, { cookie });
    expect(lost.status).toBe(503);
    expect(lost.body.error.details.reason).toBe("noAnswer");
    expect(await storedPassword(serviceId)).toBe("StoredPassword01");
    works = 0;
    const res = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal", password: "NewPassword0001" }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.warning).toContain("did not answer the password change, but root signs in with the new password");
    expect(await storedPassword(serviceId)).toBe("NewPassword0001");
    agent.disconnect();
  });

  test("a stopped ClickHouse keeps its password and name and stays stopped: no deploy starts it", async () => {
    const { serviceId } = await createDb("clickhouse", { user: "ch_admin" });
    panel.deps.db.update(services).set({ stopped: true }).where(eq(services.id, serviceId)).run();
    const list = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    expect(list.body).toMatchObject({ signIn: "offline", users: [{ name: "ch_admin", can: { passwordChange: false, rename: false } }] });
    expect(list.body.message).toContain("stopped");
    const reset = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal", password: "FreshPassword123" }, { cookie });
    expect(reset.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "notRunning" } });
    const rename = await callOp(panel, dbOps.renameUser, { serviceId, user: { name: "ch_admin" }, name: "boss" }, { cookie });
    expect(rename.body.error.details.reason).toBe("notRunning");
    expect(queued(serviceId)).toHaveLength(0);
    expect(await storedPassword(serviceId)).toBe("StoredPassword01");
    expect(storedAdmin(serviceId)).toBe("ch_admin");
    expect(panel.deps.db.select({ stopped: services.stopped }).from(services).where(eq(services.id, serviceId)).get()?.stopped).toBe(true);
  });
});

describe("deleting users", () => {
  test("a Postgres delete that fails part way says the user may no longer sign in and its objects may have moved", async () => {
    const { node, serviceId } = await createDb("postgres");
    const { agent } = engineAgent(
      node.id,
      () => pgRows(3),
      (c) =>
        c.stdin.includes("DROP ROLE") ? { exitCode: 3, stderr: 'FATAL:  database "shop_db" is not currently accepting connections' } : {},
    );
    const res = await callOp(panel, dbOps.deleteUser, { serviceId, user: { name: "app" }, reassignOwned: true }, { cookie });
    expect(res.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "execFailed" } });
    expect(res.body.error.message).toContain("did not finish deleting app. It may no longer sign in");
    expect(res.body.error.message).toContain("some of what it owned may already belong to postgres");
    expect(res.body.error.message).not.toContain("nothing changed");
    agent.disconnect();
  });

  test("never the main user or root@localhost; Postgres owners only with reassignOwned, in every database", async () => {
    const { node, serviceId } = await createDb("postgres");
    const { changes, agent } = engineAgent(node.id, () => pgRows(3));
    const del = (input: Record<string, unknown>) => callOp(panel, dbOps.deleteUser, { serviceId, ...input } as never, { cookie });
    expect((await del({ user: { name: "postgres" } })).body.error.details.reason).toBe("mainUser");
    const owns = await del({ user: { name: "app" } });
    expect(owns.body.error.details).toMatchObject({ reason: "ownsObjects", count: "3" });
    expect(changes()).toHaveLength(0);
    const ok = await del({ user: { name: "app" }, reassignOwned: true });
    expect(ok.body).toEqual({ deleted: true, reassignedObjects: 3 });
    const statements = changes()[0]?.stdin ?? "";
    for (const db of ["postgres", "shop_db", "template1"])
      expect(statements).toContain(`\\connect '${db}'\nREASSIGN OWNED BY "app" TO "postgres";`);
    expect(statements).toContain('DROP ROLE "app";');
    agent.disconnect();
    await settleDeploys(panel);

    const mysql = await createDb("mysql");
    const m = engineAgent(mysql.node.id, () => mysqlRows(2));
    const root = await callOp(
      panel,
      dbOps.deleteUser,
      { serviceId: mysql.serviceId, user: { name: "root", host: "localhost" } },
      { cookie },
    );
    expect(root.body.error.details.reason).toBe("systemUser");
    const definers = await callOp(panel, dbOps.deleteUser, { serviceId: mysql.serviceId, user: { name: "app" } }, { cookie });
    expect(definers.body.error.details).toMatchObject({ reason: "definerObjects", count: "2" });
    expect(
      (await callOp(panel, dbOps.deleteUser, { serviceId: mysql.serviceId, user: { name: "app" }, acceptOrphanDefiners: true }, { cookie }))
        .status,
    ).toBe(200);
    m.agent.disconnect();
  });

  test("MongoDB keeps its last user with root", async () => {
    const { node, serviceId } = await createDb("mongo");
    const root = '{"kind":"user","user":"ops","db":"other","roles":[{"role":"root","db":"admin"}]}';
    const { agent } = engineAgent(
      node.id,
      () => `{"kind":"user","user":"root","db":"admin","roles":[{"role":"root","db":"admin"}]}\n${root}`,
    );
    // Two with root: ops may go (it is in another auth database, so it cannot be the main user).
    const two = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    expect(two.body.users[1]).toMatchObject({ name: "ops", authDatabase: "other", can: { delete: true, makeMain: false } });
    agent.disconnect();
    // root lost its role in the shell: ops is the last user with root.
    const alone = engineAgent(
      node.id,
      () => `{"kind":"user","user":"root","db":"admin","roles":[{"role":"readWrite","db":"shop_db"}]}\n${root}`,
    );
    const list = await callOp(panel, dbOps.users, { serviceId }, { cookie });
    expect(list.body.users[1]).toMatchObject({ name: "ops", can: { delete: false } });
    const del = await callOp(panel, dbOps.deleteUser, { serviceId, user: { name: "ops", authDatabase: "other" } }, { cookie });
    expect(del.body.error.details.reason).toBe("lastAdmin");
    expect(alone.changes()).toHaveLength(0);
    alone.agent.disconnect();
  });
});

describe("who may, audit, approval and one change at a time", () => {
  test("databases.credentials on the service; viewers are refused", async () => {
    const { serviceId } = await createDb("postgres");
    const viewer = await createUser(panel, "member");
    grant(panel, viewer.user.id, "service", serviceId, ["services.view"]);
    expect((await callOp(panel, dbOps.users, { serviceId }, { cookie: viewer.cookie })).status).toBe(403);
    expect((await callOp(panel, dbOps.createUser, { serviceId, name: "x", access: "readOnly" }, { cookie: viewer.cookie })).status).toBe(
      403,
    );
    expect((await callOp(panel, dbOps.get, { serviceId }, { cookie: viewer.cookie })).status).toBe(200);
  });

  test("passwords never reach the audit log; a model's change waits for a person, a new user does not", async () => {
    const { node, serviceId } = await createDb("postgres");
    const { agent } = engineAgent(node.id, () => pgRows());
    await callOp(panel, dbOps.createUser, { serviceId, name: "app2", access: "readWrite", password: "AuditPassword01" }, { cookie });
    await callOp(panel, dbOps.setUserPassword, { serviceId, user: { name: "app" }, password: "AuditPassword02" }, { cookie });
    const rows = panel.deps.db
      .select()
      .from(auditLog)
      .all()
      .filter((r) => r.opId.startsWith("databases."));
    const made = rows.find((r) => r.opId === "databases.createUser");
    expect(made?.input).toMatchObject({ name: "app2", access: "readWrite", password: "[redacted]" });
    expect(JSON.stringify(rows)).not.toContain("AuditPassword0");

    const token = prefixedToken("mcp");
    panel.deps.db
      .insert(apiKeys)
      .values({
        userId: ownerId,
        kind: "mcp",
        name: "model",
        prefix: token.slice(0, 14),
        tokenHash: hashToken(token),
        actions: ["*"],
        readOnly: false,
      })
      .run();
    for (const [op, input] of [
      [dbOps.setUserPassword, { serviceId, user: { name: "app" } }],
      [dbOps.renameUser, { serviceId, user: { name: "app" }, name: "app3" }],
      [dbOps.deleteUser, { serviceId, user: { name: "app" } }],
      [dbOps.switchMainUser, { serviceId, name: "boss" }],
    ] as const) {
      const res = await callOp(panel, op as never, input as never, { bearer: token });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
    }
    expect((await callOp(panel, dbOps.users, { serviceId }, { bearer: token })).status).toBe(200);
    expect((await callOp(panel, dbOps.createUser, { serviceId, name: "app4", access: "readOnly" }, { bearer: token })).status).toBe(200);
    agent.disconnect();
  });

  test("changes of one database run one after another", async () => {
    const { node, serviceId } = await createDb("mysql");
    const order: string[] = [];
    const { agent } = engineAgent(
      node.id,
      () => mysqlRows(),
      async (c) => {
        const who = /'(app|root)'@'%' IDENTIFIED BY '(\w+)'/.exec(c.stdin)?.[2] ?? "?";
        order.push(`start ${who}`);
        await Bun.sleep(50);
        order.push(`end ${who}`);
        return {};
      },
    );
    await Promise.all([
      callOp(panel, dbOps.setUserPassword, { serviceId, user: { name: "app" }, password: "FirstPassword01" }, { cookie }),
      callOp(panel, dbOps.setUserPassword, { serviceId, user: { name: "app" }, password: "SecondPassword1" }, { cookie }),
    ]);
    expect(order).toEqual(["start FirstPassword01", "end FirstPassword01", "start SecondPassword1", "end SecondPassword1"]);
    agent.disconnect();
  });

  test("not while a deploy of the database runs", async () => {
    const { node, serviceId } = await createDb("postgres");
    const { agent } = engineAgent(node.id, () => pgRows());
    panel.deps.db.update(deployments).set({ status: "deploying" }).where(eq(deployments.serviceId, serviceId)).run();
    const res = await callOp(panel, dbOps.createUser, { serviceId, name: "x", access: "readOnly" }, { cookie });
    expect(res.body.error.details.reason).toBe("deployRunning");
    panel.deps.db.update(deployments).set({ status: "failed" }).where(eq(deployments.serviceId, serviceId)).run();
    agent.disconnect();
  });
});
