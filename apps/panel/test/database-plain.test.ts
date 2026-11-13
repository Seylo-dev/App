// Exposed databases that also take clients without TLS (0.2.16,
// databases.setExposure allowPlain): off by default, the owner's opt-in,
// audited, sent to the agent (DatabaseExposure.allow_plain) only when its
// agent advertises database.exposure.plain.v1, and reset when exposure is
// turned off. The exposed URL keeps asking for TLS. A model (MCP, AI) that
// turns it on, or empties the allow list while it is on, waits for a
// person's approval (modelApproval "conditional").

import { afterEach, beforeEach, expect, test } from "bun:test";
import { allOps, approvals as approvalOps, databases as dbOps } from "@seylo/ops";
import { buildAiTools } from "@seylo/ops/generators";
import { and, eq } from "drizzle-orm";
import { authenticate } from "../src/auth/authenticate";
import { approvals, auditLog, nodes, portExposures } from "../src/db/schema";
import { runOpAs } from "../src/modules/approvals/run-as";
import { databaseRuntime } from "../src/modules/databases/desired";
import { enginesCapability, exposureCapability, plainExposureCapability } from "../src/modules/databases/engines";
import { callTool } from "../src/modules/mcp/tools";
import { setSetting } from "../src/settings";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, settleDeploys } from "./seed-helpers";

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

test("emptying the allow list while it is on is audited as opening it to every IP", async () => {
  const { serviceId } = await exposedDb("mysql");
  const set = async (input: Record<string, unknown>) =>
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, ...input }, { cookie })).status).toBe(200);
  await set({ allowedCidrs: ["203.0.113.7"] });
  await set({ allowPlain: true });
  await set({ allowedCidrs: [] });
  // Already open to every IP: nothing new about plain clients.
  await set({ allowedCidrs: [] });
  await set({ allowedCidrs: ["203.0.113.7"] });
  // TLS only: an empty allow list says nothing about plain clients either.
  await set({ allowPlain: false });
  await set({ allowedCidrs: [] });
  const rows = audited();
  expect(rows).toHaveLength(8);
  expect(rows[1]).not.toHaveProperty("plainConnections");
  expect(rows[2]).toMatchObject({ allowPlain: true, plainConnections: "allowed", openToEveryone: false });
  expect(rows[3]).toMatchObject({ allowedCidrs: [], plainConnections: "allowed", openToEveryone: true });
  expect(rows[4]).not.toHaveProperty("plainConnections");
  expect(rows[5]).not.toHaveProperty("plainConnections");
  expect(rows[6]).toMatchObject({ plainConnections: "tlsOnly" });
  expect(rows[7]).not.toHaveProperty("plainConnections");
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

const exposureOf = async (serviceId: string) => (await callOp(panel, dbOps.get, { serviceId }, { cookie })).body.exposure;

test("a model's call that lets clients in without TLS waits for a person; its other exposure changes run as before", async () => {
  const { serviceId } = await exposedDb();
  const mcp = createApiKey(panel, ownerId, { kind: "mcp" });
  const asModel = (input: Record<string, unknown>) =>
    callOp(panel, dbOps.setExposure, { serviceId, enabled: true, ...input }, { bearer: mcp });
  const waits = async (input: Record<string, unknown>) => {
    const asked = await asModel(input);
    expect(asked.status).toBe(403);
    expect(asked.body.error.code).toBe("APPROVAL_REQUIRED");
  };
  const runs = async (input: Record<string, unknown>) => {
    const ran = await asModel(input);
    expect(ran.status).toBe(200);
    return ran.body.exposure;
  };

  // Turning it on waits, and nothing changed.
  await waits({ allowPlain: true });
  expect(await exposureOf(serviceId)).toMatchObject({ allowPlain: false, allowedCidrs: [] });
  // TLS only, everything else is an ordinary change: an allow list, saying off, emptying the list, a host name.
  expect(await runs({ allowedCidrs: ["198.51.100.0/24"] })).toMatchObject({ allowedCidrs: ["198.51.100.0/24"] });
  expect(await runs({ allowPlain: false })).toMatchObject({ allowPlain: false });
  expect(await runs({ allowedCidrs: [] })).toMatchObject({ allowPlain: false, allowedCidrs: [] });
  expect(await runs({ allowedCidrs: ["198.51.100.0/24"], tlsHostname: null })).toMatchObject({ tlsHostname: null });

  // A person's own calls never wait: the session, and their plain API key (a script of theirs).
  expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: true }, { cookie })).status).toBe(200);
  const key = createApiKey(panel, ownerId);
  expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: [] }, { bearer: key })).status).toBe(200);
  expect(
    (await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowedCidrs: ["198.51.100.0/24"] }, { bearer: key })).status,
  ).toBe(200);

  // With it on, the model may change the list, and say on again (nobody new gets in), but not empty it.
  expect(await runs({ allowedCidrs: ["203.0.113.0/24"] })).toMatchObject({ allowPlain: true, allowedCidrs: ["203.0.113.0/24"] });
  expect(await runs({ allowPlain: true, port: 41000 })).toMatchObject({ allowPlain: true, allowedCidrs: ["203.0.113.0/24"] });
  await waits({ allowedCidrs: [] });
  await waits({ allowedCidrs: [], allowPlain: true });
  expect(await exposureOf(serviceId)).toMatchObject({ allowPlain: true, allowedCidrs: ["203.0.113.0/24"] });
  // Emptying it while turning plain clients off, or turning exposure off, lets nobody in without TLS.
  expect(await runs({ allowedCidrs: [], allowPlain: false })).toMatchObject({ allowPlain: false, allowedCidrs: [] });
  expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: false }, { bearer: mcp })).status).toBe(200);
  // Exposing again with plain clients from the start waits too.
  await waits({ allowPlain: true });
  expect(await exposureOf(serviceId)).toMatchObject({ enabled: false, allowPlain: false });

  // Every refusal is in the activity log, with what was asked.
  const refused = panel.deps.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.opId, dbOps.setExposure.id), eq(auditLog.errorCode, "APPROVAL_REQUIRED")))
    .all();
  expect(refused.map((row) => row.input)).toEqual([
    { serviceId, enabled: true, allowPlain: true },
    { serviceId, enabled: true, allowedCidrs: [] },
    { serviceId, enabled: true, allowedCidrs: [], allowPlain: true },
    { serviceId, enabled: true, allowPlain: true },
  ]);
});

test("the MCP tool queues it for a person, whose approval runs it; Ask before destructive actions off runs it right away", async () => {
  const { serviceId } = await exposedDb("mysql");
  const mcp = createApiKey(panel, ownerId, { kind: "mcp" });
  const tool = (args: Record<string, unknown>) => {
    const principal = authenticate(panel.deps.db, { bearerToken: mcp });
    if (principal.type !== "apiKey") throw new Error("not a key");
    const call = { name: "databases_setExposure", args: { serviceId, enabled: true, ...args }, bearerToken: mcp, principal };
    return callTool(panel.deps, { ...call, ip: null, userAgent: null });
  };
  const pending = () =>
    panel.deps.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.opId, dbOps.setExposure.id), eq(approvals.status, "pending")))
      .all();

  const asked = await tool({ allowPlain: true });
  expect(asked?.isError).toBe(true);
  expect(asked?.content[0]?.text).toContain("needs a person's approval");
  expect(pending()).toHaveLength(1);
  expect(pending()[0]).toMatchObject({ requestedByType: "mcp", targetType: "service", targetId: serviceId });
  expect((await exposureOf(serviceId)).allowPlain).toBe(false);
  // An ordinary change meanwhile runs at once and queues nothing.
  expect((await tool({ allowedCidrs: ["198.51.100.0/24"] }))?.isError).toBe(false);
  expect(pending()).toHaveLength(1);

  const approvalId = pending()[0]?.id as string;
  const approved = await callOp(panel, approvalOps.approve, { approvalId }, { cookie });
  expect(approved.status).toBe(200);
  expect(approved.body.status).toBe("executed");
  expect(await exposureOf(serviceId)).toMatchObject({ allowPlain: true, allowedCidrs: ["198.51.100.0/24"] });
  const ran = panel.deps.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.opId, dbOps.setExposure.id), eq(auditLog.approvalId, approvalId)))
    .get();
  expect(ran).toMatchObject({ outcome: "ok", input: { plainConnections: "allowed", openToEveryone: false } });

  // Emptying the list now waits too (the first approval ran, so it is the only one pending).
  expect((await tool({ allowedCidrs: [] }))?.content[0]?.text).toContain("needs a person's approval");
  expect(pending()).toHaveLength(1);
  expect((await exposureOf(serviceId)).allowedCidrs).toEqual(["198.51.100.0/24"]);

  // The switch off: an MCP token's call runs right away, still audited.
  setSetting(panel.deps.db, "mcpAskBeforeDestructive", false);
  expect((await tool({ allowedCidrs: [] }))?.isError).toBe(false);
  expect(await exposureOf(serviceId)).toMatchObject({ allowPlain: true, allowedCidrs: [] });
  expect(pending()).toHaveLength(1);
  const last = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, dbOps.setExposure.id)).all().at(-1);
  expect(last).toMatchObject({ actorType: "mcp", outcome: "ok", approvalId: null, input: { openToEveryone: true } });
});

test("the assistant's call waits for a person unless the person's auto mode is on, whatever the MCP switch says", async () => {
  const { serviceId } = await exposedDb();
  const asAssistant = (input: Record<string, unknown>, autoMode = false) =>
    runOpAs(panel.deps, {
      op: dbOps.setExposure,
      input: { serviceId, enabled: true, ...input },
      userId: ownerId,
      transport: "ai",
      autoMode,
    });
  const needsApproval = { ok: false, error: { code: "APPROVAL_REQUIRED" } };

  // Its loop asks for every change; the pipeline holds these ones even when it is told to run them.
  expect(buildAiTools(allOps).find((tool) => tool.opId === dbOps.setExposure.id)?.needsApproval).toBe(true);
  expect(await asAssistant({ allowPlain: true })).toMatchObject(needsApproval);
  expect(await asAssistant({ allowedCidrs: ["198.51.100.0/24"] })).toMatchObject({ ok: true });
  expect(await asAssistant({ allowPlain: false })).toMatchObject({ ok: true });
  expect((await exposureOf(serviceId)).allowPlain).toBe(false);

  // Auto mode runs it as the person, as it runs a destructive op.
  expect(await asAssistant({ allowPlain: true }, true)).toMatchObject({ ok: true });
  expect((await exposureOf(serviceId)).allowPlain).toBe(true);

  // "Ask before destructive actions" is for MCP tokens: the assistant still waits with it off.
  setSetting(panel.deps.db, "mcpAskBeforeDestructive", false);
  expect(await asAssistant({ allowedCidrs: [] })).toMatchObject(needsApproval);
  expect(await exposureOf(serviceId)).toMatchObject({ allowPlain: true, allowedCidrs: ["198.51.100.0/24"] });
});
