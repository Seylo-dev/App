// Exposed databases that also take clients without TLS (0.2.16,
// databases.setExposure allowPlain): off by default, the owner's opt-in,
// audited, sent to the agent (DatabaseExposure.allow_plain) only when its
// agent advertises database.exposure.plain.v1, and reset when exposure is
// turned off. The exposed URL keeps asking for TLS.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { databases as dbOps } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { auditLog, nodes, portExposures } from "../src/db/schema";
import { databaseRuntime } from "../src/modules/databases/desired";
import { enginesCapability, exposureCapability, plainExposureCapability } from "../src/modules/databases/engines";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, settleDeploys } from "./seed-helpers";

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

const current = [enginesCapability, exposureCapability, plainExposureCapability];

/** Records that the node's agent advertised capabilities (as nodes.facts keeps them). */
function advertise(nodeId: string, capabilities: string[]) {
  panel.deps.db.update(nodes).set({ facts: { capabilities } }).where(eq(nodes.id, nodeId)).run();
}

async function exposedDb(engine: "postgres" | "mysql" | "valkey" = "postgres", capabilities = current) {
  const project = seedProject(panel);
  const node = seedNode(panel, { ipv4: "203.0.113.10" });
  advertise(node.id, capabilities);
  const created = await callOp(panel, dbOps.create, { projectId: project.id, name: "shop-db", engine, nodeId: node.id }, { cookie });
  expect(created.status).toBe(200);
  const serviceId: string = created.body.serviceId;
  expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie })).status).toBe(200);
  // The node reports the port it opened, so the exposed connection has an address.
  panel.deps.db
    .update(portExposures)
    .set({ listenPort: 41000 })
    .where(and(eq(portExposures.serviceId, serviceId), eq(portExposures.kind, "database")))
    .run();
  return { serviceId, node, project };
}

const audited = () =>
  panel.deps.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.opId, dbOps.setExposure.id))
    .all()
    .map((r) => r.input as Record<string, unknown>);

test("off by default; on and off again, read back by get and connection, sent to the agent", async () => {
  const { serviceId, node } = await exposedDb();
  const get = async () => (await callOp(panel, dbOps.get, { serviceId }, { cookie })).body;
  const conn = async () => (await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body;
  expect((await get()).exposure).toMatchObject({ enabled: true, allowPlain: false, plainNeedsNodeUpdate: false });
  expect((await conn()).exposed).toMatchObject({ allowPlain: false });
  expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ enabled: true, allowPlain: false });

  const on = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: true }, { cookie });
  expect(on.status).toBe(200);
  expect(on.body.exposure).toMatchObject({ allowPlain: true, plainNeedsNodeUpdate: false });
  const exposed = (await conn()).exposed;
  expect(exposed.allowPlain).toBe(true);
  // The URL keeps asking for TLS: it still works, and it is the one to hand out.
  expect(exposed.url).toContain("sslmode=require");
  expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ enabled: true, allowPlain: true });

  // Fields left out keep their value: a new allow list keeps it on.
  const narrowed = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: ["198.51.100.0/24"] }, { cookie });
  expect(narrowed.body.exposure).toMatchObject({ allowPlain: true, allowedCidrs: ["198.51.100.0/24"] });

  const off = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: false }, { cookie });
  expect(off.body.exposure.allowPlain).toBe(false);
  expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ allowPlain: false });
});

test("turning exposure off resets it; it needs exposure on", async () => {
  const { serviceId } = await exposedDb("mysql");
  await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: true }, { cookie });
  expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: false }, { cookie })).body.exposure.allowPlain).toBe(false);
  const again = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true }, { cookie });
  expect(again.body.exposure).toMatchObject({ enabled: true, allowPlain: false });
  const refused = await callOp(panel, dbOps.setExposure, { serviceId, enabled: false, allowPlain: true }, { cookie });
  expect(refused.status).toBe(400);
  expect(refused.body.error.details.field).toBe("allowPlain");
});

test("it is audited: the input, and what changed with it", async () => {
  const { serviceId } = await exposedDb("valkey");
  await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: true }, { cookie });
  await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: ["198.51.100.7"] }, { cookie });
  await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: ["198.51.100.7"], allowPlain: true }, { cookie });
  await callOp(panel, dbOps.setExposure, { serviceId, enabled: false }, { cookie });
  const rows = audited();
  // Exposing, then allowing plain with the port open to every IP, an allow list (no change to plain), a no-op, off.
  expect(rows).toHaveLength(5);
  expect(rows[0]).not.toHaveProperty("plainConnections");
  expect(rows[1]).toMatchObject({ allowPlain: true, plainConnections: "allowed", openToEveryone: true });
  expect(rows[2]).not.toHaveProperty("plainConnections");
  expect(rows[3]).not.toHaveProperty("plainConnections");
  expect(rows[4]).toMatchObject({ enabled: false, plainConnections: "tlsOnly" });
});

test("it needs databases.expose, like the rest of exposure", async () => {
  const { serviceId, project } = await exposedDb();
  const member = await createUser(panel, "member");
  grant(panel, member.user.id, "service", serviceId, ["services.view", "databases.credentials"]);
  const refused = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: true }, { cookie: member.cookie });
  expect(refused.status).toBe(403);
  expect((await callOp(panel, dbOps.get, { serviceId }, { cookie: member.cookie })).body.exposure.allowPlain).toBe(false);
  grant(panel, member.user.id, "project", project.id, ["databases.expose"]);
  const allowed = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: true }, { cookie: member.cookie });
  expect(allowed.status).toBe(200);
  expect(allowed.body.exposure.allowPlain).toBe(true);
});

test("an agent older than 0.2.16 keeps the port TLS only: refused there, kept and not sent when the node goes back", async () => {
  // An agent from 0.2.9 to 0.2.15: exposure works, plain clients do not.
  const { serviceId, node } = await exposedDb("postgres", [enginesCapability, exposureCapability]);
  const get = async () => (await callOp(panel, dbOps.get, { serviceId }, { cookie })).body;
  expect((await get()).exposure).toMatchObject({ allowPlain: false, plainNeedsNodeUpdate: true });
  const refused = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: true }, { cookie });
  expect(refused.status).toBe(409);
  expect(refused.body.error.details).toMatchObject({ reason: "agentTooOld", field: "allowPlain" });
  expect(refused.body.error.message).toContain("0.2.16");
  // Other changes still go through, and turning it off is never refused.
  expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: ["198.51.100.7"] }, { cookie })).status).toBe(
    200,
  );
  expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: false }, { cookie })).status).toBe(200);

  // A live agent's own capabilities count.
  const newer = fakeAgent(panel, node.id, {}, [], current);
  expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: true }, { cookie })).status).toBe(200);
  newer.disconnect();
  advertise(node.id, current);
  expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ allowPlain: true });

  // The node went back to an older agent: the setting stays, the port is TLS only, nothing says plain works.
  advertise(node.id, [enginesCapability, exposureCapability]);
  expect(databaseRuntime(panel.deps, serviceId, node.id)?.database.exposure).toMatchObject({ enabled: true, allowPlain: false });
  expect((await get()).exposure).toMatchObject({ allowPlain: true, plainNeedsNodeUpdate: true });
  expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.exposed.allowPlain).toBe(false);
  // Changing something else keeps it, without asking for the update again.
  const kept = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: [] }, { cookie });
  expect(kept.status).toBe(200);
  expect(kept.body.exposure.allowPlain).toBe(true);
});
