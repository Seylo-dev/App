// Timed exposes of databases (exposures.openTimed from the Connection tab):
// the database's own port, its client command and URL without the password
// for exposures.view, the URL with it for databases.credentials, TLS only
// where the database serves it, next to a permanent exposure without a
// clash, in the desired state, audited and swept.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { databases as dbOps, exposures as exposureOps, type LiveServerMessage } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { auditLog, nodes } from "../src/db/schema";
import { compileDesiredState } from "../src/desired/compile";
import { enginesCapability, exposureCapability } from "../src/modules/databases/engines";
import { sweepAndMark } from "../src/modules/exposures/logic";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, seedService, settleDeploys } from "./seed-helpers";

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

type Engine = "postgres" | "mysql" | "mariadb" | "mongo" | "redis" | "valkey" | "keydb" | "dragonfly" | "clickhouse";

async function createDb(
  engine: Engine,
  extra: Record<string, unknown> = {},
  node = { ipv4: "203.0.113.10" as string | null, ipv6: null as string | null },
) {
  const project = seedProject(panel);
  const placed = seedNode(panel, { ipv4: node.ipv4, ipv6: node.ipv6, wildcard: null });
  panel.deps.db
    .update(nodes)
    .set({ facts: { capabilities: [enginesCapability, exposureCapability] } })
    .where(eq(nodes.id, placed.id))
    .run();
  const res = await callOp(panel, dbOps.create, { projectId: project.id, name: "shop-db", engine, nodeId: placed.id, ...extra } as never, {
    cookie,
  });
  expect(res.status).toBe(200);
  return { node: placed, serviceId: res.body.serviceId as string };
}

/** What the node reports for a timed expose: the port it picked, with the expose's end. */
function reportTimed(
  agent: ReturnType<typeof fakeAgent>,
  serviceId: string,
  epoch: bigint,
  ports: { hostPort: number; containerPort: number; expiresAt?: string }[],
) {
  agent.snapshot({
    epoch,
    services: [
      {
        serviceId,
        openPorts: ports.map((p) => ({
          hostPort: p.hostPort,
          containerPort: p.containerPort,
          ...(p.expiresAt
            ? {
                expiresAt: {
                  seconds: BigInt(Math.floor(Date.parse(p.expiresAt) / 1000)),
                  nanos: (Date.parse(p.expiresAt) % 1000) * 1_000_000,
                },
              }
            : {}),
        })),
      },
    ],
  });
}

const open = (serviceId: string, extra: Record<string, unknown> = {}) =>
  callOp(panel, exposureOps.openTimed, { serviceId, durationMinutes: 60, allowedCidrs: ["198.51.100.24"], ...extra } as never, { cookie });

describe("timed expose of a database", () => {
  test("opens the database's port; the command and URL come once the node reports the port, the password only with the credentials", async () => {
    const { node, serviceId } = await createDb("postgres");
    // No port given: the database's own.
    const opened = await open(serviceId);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      targetPort: 5432,
      host: "203.0.113.10",
      port: null,
      allowedCidrs: ["198.51.100.24/32"],
      // No TLS in a Postgres that is not exposed: the card says the connection is not encrypted.
      database: { engine: "postgres", user: "postgres", database: "shop_db", tls: "none", url: null, command: null },
    });
    // Nothing else listens in its container.
    const wrong = await open(serviceId, { targetPort: 3000 });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toContain("PostgreSQL listens on 5432");

    // The node gets it with the database's spec, on the engine's port.
    const state = compileDesiredState(panel.deps.db, node.id, {
      revision: 1n,
      secrets: panel.deps.secrets,
      contributors: panel.deps.agents.desired.contributors(),
    });
    const spec = state.services.find((s) => s.id === serviceId);
    expect(spec?.kindSpec.case).toBe("database");
    expect(spec?.devAccess?.timedExposes).toEqual([
      expect.objectContaining({ id: opened.body.id, containerPort: 5432, hostPort: 0, allowedSourceCidrs: ["198.51.100.24/32"] }),
    ]);

    const agent = fakeAgent(panel, node.id, {}, [], [enginesCapability, exposureCapability]);
    reportTimed(agent, serviceId, 1n, [{ hostPort: 41000, containerPort: 5432, expiresAt: opened.body.expiresAt }]);
    const listed = await callOp(panel, exposureOps.get, { serviceId }, { cookie });
    expect(listed.body.timed[0]).toMatchObject({
      port: 41000,
      database: {
        tls: "none",
        url: "postgresql://postgres@203.0.113.10:41000/shop_db",
        command: "psql postgresql://postgres@203.0.113.10:41000/shop_db",
      },
    });
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    expect(conn.body.timed).toEqual([
      {
        exposureId: opened.body.id,
        host: "203.0.113.10",
        port: 41000,
        url: `postgresql://postgres:${conn.body.internal.password}@203.0.113.10:41000/shop_db`,
      },
    ]);

    // exposures.edit opens and lists it; without databases.credentials the password is nowhere.
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", serviceId, ["services.view", "exposures.view", "exposures.edit"]);
    const theirs = await callOp(
      panel,
      exposureOps.openTimed,
      { serviceId, durationMinutes: 15, allowedCidrs: ["198.51.100.25"] },
      { cookie: member.cookie },
    );
    expect(theirs.status).toBe(200);
    const seen = await callOp(panel, exposureOps.get, { serviceId }, { cookie: member.cookie });
    expect(seen.status).toBe(200);
    expect(seen.body.timed).toHaveLength(2);
    expect(JSON.stringify(seen.body)).not.toContain(conn.body.internal.password);
    expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie: member.cookie })).status).toBe(403);
    const viewer = await createUser(panel, "member");
    grant(panel, viewer.user.id, "service", serviceId, ["services.view", "exposures.view"]);
    expect(
      (
        await callOp(
          panel,
          exposureOps.openTimed,
          { serviceId, durationMinutes: 15, allowedCidrs: ["198.51.100.26"] },
          { cookie: viewer.cookie },
        )
      ).status,
    ).toBe(403);

    // Every open, extend and close is in the audit log under the database.
    await callOp(panel, exposureOps.extendTimed, { serviceId, exposureId: opened.body.id, durationMinutes: 120 }, { cookie });
    await callOp(panel, exposureOps.close, { serviceId, exposureId: theirs.body.id }, { cookie });
    const audited = panel.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, serviceId), eq(auditLog.outcome, "ok")))
      .all()
      .map((row) => row.opId)
      .filter((id) => id.startsWith("exposures."));
    expect(audited).toEqual(["exposures.openTimed", "exposures.openTimed", "exposures.extendTimed", "exposures.close"]);
    agent.disconnect();
  });

  test("next to a permanent exposure: its own port, no clash either way, and Postgres' TLS is asked for", async () => {
    const { node, serviceId } = await createDb("postgres");
    const agent = fakeAgent(panel, node.id, {}, [], [enginesCapability, exposureCapability]);
    await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, port: 45432 }, { cookie });
    // The exposed port is taken; the timed one gets another.
    expect((await open(serviceId, { port: 45432 })).status).toBe(409);
    const opened = await open(serviceId, { port: 41000 });
    expect(opened.status).toBe(200);
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, port: 41000 }, { cookie })).status).toBe(409);
    reportTimed(agent, serviceId, 1n, [
      { hostPort: 45432, containerPort: 5432 },
      { hostPort: 41000, containerPort: 5432, expiresAt: opened.body.expiresAt },
    ]);
    // The agent turned TLS on in the exposed Postgres: the timed URL asks for it too.
    const listed = await callOp(panel, exposureOps.get, { serviceId }, { cookie });
    expect(listed.body.database).toMatchObject({ port: 45432 });
    expect(listed.body.timed[0].database).toMatchObject({
      tls: "database",
      url: "postgresql://postgres@203.0.113.10:41000/shop_db?sslmode=require",
      command: "psql 'postgresql://postgres@203.0.113.10:41000/shop_db?sslmode=require'",
    });
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    expect(conn.body.exposed).toMatchObject({ port: 45432 });
    expect(conn.body.timed.map((t: { port: number }) => t.port)).toEqual([41000]);
    // The exposed URL stays the permanent port's.
    expect(conn.body.exposed.url).toContain(":45432/");
    const state = compileDesiredState(panel.deps.db, node.id, {
      revision: 1n,
      secrets: panel.deps.secrets,
      contributors: panel.deps.agents.desired.contributors(),
    });
    const spec = state.services.find((s) => s.id === serviceId);
    expect(spec?.kindSpec.case === "database" && spec.kindSpec.value.exposure).toMatchObject({ enabled: true, hostPort: 45432 });
    expect(spec?.devAccess?.timedExposes.map((t) => t.hostPort)).toEqual([41000]);
    agent.disconnect();
  });

  test("each engine's command and URL, TLS where the database serves it", async () => {
    const cases: { engine: Engine; extra?: Record<string, unknown>; port: number; tls: string; url: string; command: string }[] = [
      {
        engine: "mysql",
        port: 3306,
        tls: "database",
        url: "mysql://root@203.0.113.10:41000/shop_db?ssl-mode=REQUIRED",
        command: "mysql -h 203.0.113.10 -P 41000 -u root -p --ssl-mode=REQUIRED shop_db",
      },
      {
        engine: "mariadb",
        port: 3306,
        tls: "database",
        url: "mysql://root@203.0.113.10:41000/shop_db?ssl-mode=REQUIRED",
        command: "mariadb -h 203.0.113.10 -P 41000 -u root -p --ssl shop_db",
      },
      // MariaDB 10.11 has no TLS.
      {
        engine: "mariadb",
        extra: { version: "10.11" },
        port: 3306,
        tls: "none",
        url: "mysql://root@203.0.113.10:41000/shop_db",
        command: "mariadb -h 203.0.113.10 -P 41000 -u root -p shop_db",
      },
      {
        engine: "mongo",
        port: 27017,
        tls: "none",
        url: "mongodb://root@203.0.113.10:41000/shop_db?authSource=admin",
        command: "mongosh 'mongodb://root@203.0.113.10:41000/shop_db?authSource=admin'",
      },
      {
        engine: "redis",
        port: 6379,
        tls: "none",
        url: "redis://default@203.0.113.10:41000",
        command: "redis-cli -h 203.0.113.10 -p 41000 --askpass",
      },
      {
        engine: "valkey",
        port: 6379,
        tls: "none",
        url: "redis://default@203.0.113.10:41000",
        command: "redis-cli -h 203.0.113.10 -p 41000 --askpass",
      },
      {
        engine: "dragonfly",
        port: 6379,
        tls: "none",
        url: "redis://default@203.0.113.10:41000",
        command: "redis-cli -h 203.0.113.10 -p 41000 --askpass",
      },
      {
        engine: "clickhouse",
        extra: { user: "ch_admin" },
        port: 9000,
        tls: "none",
        url: "clickhouse://ch_admin@203.0.113.10:41000/shop_db",
        command: "clickhouse-client --host 203.0.113.10 --port 41000 --user ch_admin --database shop_db --password",
      },
    ];
    for (const c of cases) {
      const { node, serviceId } = await createDb(c.engine, c.extra);
      const opened = await open(serviceId);
      expect(opened.body.targetPort).toBe(c.port);
      const agent = fakeAgent(panel, node.id, {}, [], [enginesCapability, exposureCapability]);
      reportTimed(agent, serviceId, 1n, [{ hostPort: 41000, containerPort: c.port, expiresAt: opened.body.expiresAt }]);
      const got = (await callOp(panel, exposureOps.get, { serviceId }, { cookie })).body.timed[0].database;
      expect({ engine: c.engine, ...got }).toMatchObject({ engine: c.engine, tls: c.tls, url: c.url, command: c.command });
      agent.disconnect();
      await settleDeploys(panel);
    }
  });

  test("ClickHouse's HTTP port too, and an IPv6 node", async () => {
    const { node, serviceId } = await createDb("clickhouse", { user: "ch_admin" }, { ipv4: null, ipv6: "2001:db8::10" });
    const opened = await open(serviceId, { targetPort: 8123 });
    expect(opened.status).toBe(200);
    const agent = fakeAgent(panel, node.id, {}, [], [enginesCapability, exposureCapability]);
    reportTimed(agent, serviceId, 1n, [{ hostPort: 48123, containerPort: 8123, expiresAt: opened.body.expiresAt }]);
    const got = (await callOp(panel, exposureOps.get, { serviceId }, { cookie })).body.timed[0];
    expect(got.host).toBe("[2001:db8::10]");
    expect(got.database).toMatchObject({
      tls: "none",
      url: "http://ch_admin@[2001:db8::10]:48123/shop_db",
      command: "curl --user ch_admin 'http://[2001:db8::10]:48123/?database=shop_db' --data-binary 'SELECT version()'",
    });
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    expect(conn.body.timed[0].url).toBe(`http://ch_admin:${conn.body.internal.password}@[2001:db8::10]:48123/shop_db`);
    // Flags take the bare address.
    const native = await open(serviceId);
    reportTimed(agent, serviceId, 2n, [
      { hostPort: 48123, containerPort: 8123, expiresAt: opened.body.expiresAt },
      { hostPort: 49000, containerPort: 9000, expiresAt: native.body.expiresAt },
    ]);
    const both = (await callOp(panel, exposureOps.get, { serviceId }, { cookie })).body.timed;
    expect(both.find((t: { targetPort: number }) => t.targetPort === 9000).database.command).toBe(
      "clickhouse-client --host 2001:db8::10 --port 49000 --user ch_admin --database shop_db --password",
    );
    agent.disconnect();
  });

  test("an ended expose is swept, and open screens read the access and the connection again", async () => {
    const { serviceId } = await createDb("valkey");
    await open(serviceId);
    const got: LiveServerMessage[] = [];
    panel.deps.live.subscribe({ id: crypto.randomUUID(), send: (m) => got.push(m) }, `service:${serviceId}`);
    expect(sweepAndMark(panel.deps, new Date(Date.now() + 2 * 3600_000))).toBe(1);
    const ops = got.flatMap((m) => (m.type === "event" && m.event.type === "invalidate" ? m.event.ops : []));
    expect(ops).toEqual(expect.arrayContaining([exposureOps.get.id, dbOps.connection.id]));
    expect((await callOp(panel, exposureOps.get, { serviceId }, { cookie })).body.timed).toEqual([]);
    expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.timed).toEqual([]);
  });
});

test("an app's timed expose defaults to its main port and has no database part", async () => {
  const project = seedProject(panel);
  const node = seedNode(panel);
  const app = seedService(panel, { projectId: project.id, name: "web", ports: [3000], nodeIds: [node.id] });
  const opened = await open(app.id);
  expect(opened.body).toMatchObject({ targetPort: 3000, database: null });
  const worker = seedService(panel, { projectId: project.id, name: "worker", ports: [], nodeIds: [node.id] });
  expect((await open(worker.id)).status).toBe(400);
  expect((await open(worker.id, { targetPort: 8080 })).status).toBe(200);
});
