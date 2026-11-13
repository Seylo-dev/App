// Exposed databases that also take clients without TLS (0.2.16,
// databases.setExposure allowPlain): off by default, the owner's opt-in,
// audited, sent to the agent (DatabaseExposure.allow_plain) only when its
// agent advertises database.exposure.plain.v1, and reset when exposure is
// turned off. The exposed URL keeps asking for TLS. A model (MCP, AI) that
// turns it on, or empties or widens the allow list while it is on (0.0.0.0/0
// in place of a list, say), waits for a person's approval (modelApproval
// "conditional"), unless the handler would refuse it anyway (precheck:
// refused at once), and the waiting approval says what approving lets in
// (Approval.warning).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ai, allOps, approvals as approvalOps, databases as dbOps } from "@seylo/ops";
import { buildAiTools } from "@seylo/ops/generators";
import { and, eq } from "drizzle-orm";
import { authenticate } from "../src/auth/authenticate";
import { approvals, auditLog, nodes, portExposures } from "../src/db/schema";
import { setModelProvider } from "../src/modules/ai/client";
import { runOpAs } from "../src/modules/approvals/run-as";
import { databaseRuntime } from "../src/modules/databases/desired";
import { enginesCapability, exposureCapability, plainExposureCapability } from "../src/modules/databases/engines";
import { callTool } from "../src/modules/mcp/tools";
import { setSetting } from "../src/settings";
import { scriptedModel, settled } from "./ai-fake";
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

  // With it on, the model may narrow the list, and say on again (nobody new gets in), but not empty it or let in
  // addresses the list did not hold.
  expect(await runs({ allowedCidrs: ["198.51.100.0/25"] })).toMatchObject({ allowPlain: true, allowedCidrs: ["198.51.100.0/25"] });
  expect(await runs({ allowPlain: true, port: 41000 })).toMatchObject({ allowPlain: true, allowedCidrs: ["198.51.100.0/25"] });
  await waits({ allowedCidrs: [] });
  await waits({ allowedCidrs: [], allowPlain: true });
  await waits({ allowedCidrs: ["203.0.113.0/24"] });
  await waits({ allowedCidrs: ["198.51.100.0/24"] });
  expect(await exposureOf(serviceId)).toMatchObject({ allowPlain: true, allowedCidrs: ["198.51.100.0/25"] });
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
    { serviceId, enabled: true, allowedCidrs: ["203.0.113.0/24"] },
    { serviceId, enabled: true, allowedCidrs: ["198.51.100.0/24"] },
    { serviceId, enabled: true, allowPlain: true },
  ]);
});

test("a catch-all allow list in place of the person's waits like an empty one; a narrower one runs", async () => {
  const { serviceId } = await exposedDb();
  const asPerson = async (input: Record<string, unknown>) =>
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, ...input }, { cookie })).status).toBe(200);
  await asPerson({ allowedCidrs: ["203.0.113.7/32"], allowPlain: true });
  const mcp = createApiKey(panel, ownerId, { kind: "mcp" });
  const asModel = (input: Record<string, unknown>) =>
    callOp(panel, dbOps.setExposure, { serviceId, enabled: true, ...input }, { bearer: mcp });
  const waits = async (allowedCidrs: string[]) => {
    const asked = await asModel({ allowedCidrs });
    expect(asked.status).toBe(403);
    expect(asked.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(await exposureOf(serviceId)).toMatchObject({ allowPlain: true, allowedCidrs: ["203.0.113.7/32"] });
  };

  // Every IP, every IPv4 or IPv6 address, the same in two halves, or another address (the model's own).
  await waits(["0.0.0.0/0", "::/0"]);
  await waits(["0.0.0.0/0"]);
  await waits(["::/0"]);
  await waits(["0.0.0.0/1", "128.0.0.0/1"]);
  await waits(["198.51.100.9"]);
  await waits(["203.0.113.7/32", "198.51.100.9"]);
  await waits(["203.0.113.0/24"]);

  // Narrower or the same runs: the person's list, a range inside a wider one, an entry written without its /32.
  const runs = async (input: Record<string, unknown>) => {
    const ran = await asModel(input);
    expect(ran.status).toBe(200);
    return ran.body.exposure;
  };
  expect(await runs({ allowedCidrs: ["203.0.113.7"] })).toMatchObject({ allowPlain: true, allowedCidrs: ["203.0.113.7/32"] });
  await asPerson({ allowedCidrs: ["203.0.113.0/24"] });
  expect(await runs({ allowedCidrs: ["203.0.113.7/32", "203.0.113.128/25"] })).toMatchObject({
    allowedCidrs: ["203.0.113.7/32", "203.0.113.128/25"],
  });
  // A catch-all while turning plain clients off lets nobody in without TLS.
  expect(await runs({ allowedCidrs: ["0.0.0.0/0"], allowPlain: false })).toMatchObject({ allowPlain: false, allowedCidrs: ["0.0.0.0/0"] });
});

test("a catch-all allow list is audited as open to every IP, and widening one while plain clients are on is audited", async () => {
  const { serviceId } = await exposedDb("mysql");
  const set = async (input: Record<string, unknown>) =>
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, ...input }, { cookie })).status).toBe(200);
  await set({ allowedCidrs: ["0.0.0.0/0"], allowPlain: true });
  // Inside the old list: nothing new about plain clients.
  await set({ allowedCidrs: ["0.0.0.0/1", "128.0.0.0/1"] });
  await set({ allowedCidrs: ["203.0.113.7"] });
  // Wider again, in two halves, then to one more address.
  await set({ allowedCidrs: ["0.0.0.0/1", "128.0.0.0/1"] });
  await set({ allowedCidrs: ["203.0.113.7"] });
  await set({ allowedCidrs: ["203.0.113.7", "198.51.100.9"] });
  const rows = audited();
  expect(rows).toHaveLength(7);
  expect(rows[1]).toMatchObject({ allowPlain: true, plainConnections: "allowed", openToEveryone: true });
  expect(rows[2]).not.toHaveProperty("plainConnections");
  expect(rows[3]).not.toHaveProperty("plainConnections");
  expect(rows[4]).toMatchObject({ plainConnections: "allowed", openToEveryone: true });
  expect(rows[5]).not.toHaveProperty("plainConnections");
  expect(rows[6]).toMatchObject({ plainConnections: "allowed", openToEveryone: false });
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

/** The pending setExposure approvals. */
const pendingExposures = () =>
  panel.deps.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.opId, dbOps.setExposure.id), eq(approvals.status, "pending")))
    .all();

/** An MCP token's tool call to databases_setExposure, as an MCP host makes it. */
function mcpTool(serviceId: string) {
  const mcp = createApiKey(panel, ownerId, { kind: "mcp" });
  return (args: Record<string, unknown>) => {
    const principal = authenticate(panel.deps.db, { bearerToken: mcp });
    if (principal.type !== "apiKey") throw new Error("not a key");
    const call = { name: "databases_setExposure", args: { serviceId, enabled: true, ...args }, bearerToken: mcp, principal };
    return callTool(panel.deps, { ...call, ip: null, userAgent: null });
  };
}

test("a held call the handler would refuse is refused at once, with no approval to fail later", async () => {
  // An agent from 0.2.9 to 0.2.15: turning plain clients on is refused there.
  const old = await exposedDb("postgres", [enginesCapability, exposureCapability]);
  const mcp = createApiKey(panel, ownerId, { kind: "mcp" });
  const asModel = (serviceId: string, input: Record<string, unknown>) =>
    callOp(panel, dbOps.setExposure, { serviceId, enabled: true, ...input }, { bearer: mcp });
  const tooOld = await asModel(old.serviceId, { allowPlain: true });
  expect(tooOld.status).toBe(409);
  expect(tooOld.body.error.details).toMatchObject({ reason: "agentTooOld", field: "allowPlain" });
  const tool = await mcpTool(old.serviceId)({ allowPlain: true });
  expect(tool?.isError).toBe(true);
  expect(tool?.content[0]?.text).toStartWith("CONFLICT: The agent on");
  expect(tool?.content[0]?.text).toContain("0.2.16");

  // On a current agent: a TLS host name that is none, a port another database has open on the node.
  const { serviceId, node, project } = await exposedDb();
  const notAHost = await asModel(serviceId, { allowPlain: true, tlsHostname: "not a host" });
  expect(notAHost.status).toBe(400);
  expect(notAHost.body.error.details).toMatchObject({ field: "tlsHostname" });
  const other = await callOp(
    panel,
    dbOps.create,
    { projectId: project.id, name: "other-db", engine: "postgres", nodeId: node.id },
    { cookie },
  );
  const otherId: string = other.body.serviceId;
  expect((await callOp(panel, dbOps.setExposure, { serviceId: otherId, enabled: true, port: 41001 }, { cookie })).status).toBe(200);
  const taken = await asModel(serviceId, { allowPlain: true, port: 41001 });
  expect(taken.status).toBe(409);
  expect(taken.body.error.details).toMatchObject({ field: "port" });

  // MariaDB 10.11 has no TLS, so it is never exposed, with or without plain clients.
  const mariadb = await callOp(
    panel,
    dbOps.create,
    { projectId: project.id, name: "legacy-db", engine: "mariadb", version: "10.11", nodeId: node.id },
    { cookie },
  );
  const noTls = await asModel(mariadb.body.serviceId, { allowPlain: true });
  expect(noTls.status).toBe(409);
  expect(noTls.body.error.details).toMatchObject({ reason: "noTls" });

  // Nothing waits, nothing changed, and a call it takes still waits.
  expect(pendingExposures()).toHaveLength(0);
  expect(await exposureOf(serviceId)).toMatchObject({ allowPlain: false, port: 41000 });
  const waits = await asModel(serviceId, { allowPlain: true });
  expect(waits.status).toBe(403);
  expect(waits.body.error.code).toBe("APPROVAL_REQUIRED");
  // A person's own call gets the same refusals as before.
  const person = await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, allowPlain: true, port: 41001 }, { cookie });
  expect(person.status).toBe(409);
});

test("the assistant's change the handler would refuse fails at once instead of queuing an approval", async () => {
  const model = scriptedModel();
  setModelProvider(model.provider);
  try {
    const old = await exposedDb("postgres", [enginesCapability, exposureCapability]);
    const enabled = await callOp(
      panel,
      ai.updateSettings,
      { enabled: true, anthropicApiKey: "placeholder-model-key-for-tests" },
      { cookie },
    );
    expect(enabled.status).toBe(200);
    const tool = (id: string, input: Record<string, unknown>) => ({
      type: "tool_use" as const,
      id,
      name: "databases_setExposure",
      input: { serviceId: old.serviceId, ...input },
    });
    model.script = [
      [
        { type: "text", text: "I will let clients without TLS in." },
        // The node's agent is too old; plain clients with exposure off.
        tool("tu_old", { enabled: true, allowPlain: true }),
        tool("tu_off", { enabled: false, allowPlain: true }),
      ],
      // Told why at once, it narrows the list instead.
      [tool("tu_narrow", { enabled: true, allowedCidrs: ["198.51.100.0/24"] })],
      [{ type: "text", text: "Done." }],
    ];
    const sent = await callOp(panel, ai.send, { message: "Let my laptop connect without TLS" }, { cookie });
    await settled(panel, sent.body.conversationId);
    const reply = (await callOp(panel, ai.conversation, { conversationId: sent.body.conversationId }, { cookie })).body.messages[1];
    const calls = reply.parts.filter((p: { type: string }) => p.type === "tool_call");
    expect(calls[0]).toMatchObject({ toolCallId: "tu_old", status: "error", approvalId: null });
    expect(calls[0].resultPreview).toStartWith("CONFLICT: The agent on");
    expect(calls[1]).toMatchObject({
      toolCallId: "tu_off",
      status: "error",
      approvalId: null,
      resultPreview: "BAD_REQUEST: Connections without TLS need exposure on.",
    });
    // The model got both refusals as tool results in its next call, with nothing waiting for a person.
    const results = JSON.stringify(model.calls[1]?.messages.at(-1));
    expect(results).toContain("CONFLICT: The agent on");
    expect(results).toContain("BAD_REQUEST: Connections without TLS need exposure on.");
    // The assistant queues every change: this one waits, as an ordinary change with no warning.
    expect(calls[2]).toMatchObject({ toolCallId: "tu_narrow", status: "needs_approval" });
    expect(pendingExposures().map((row) => row.id)).toEqual([calls[2].approvalId]);
    const narrow = await callOp(panel, approvalOps.get, { approvalId: calls[2].approvalId }, { cookie });
    expect(narrow.body.status).toBe("pending");
    expect(narrow.body).not.toHaveProperty("warning");
  } finally {
    setModelProvider(null);
  }
});

test("a waiting approval that lets clients in without TLS says so, with the allow list it leaves, while approving would", async () => {
  const { serviceId } = await exposedDb();
  const set = async (input: Record<string, unknown>) =>
    expect((await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, ...input }, { cookie })).status).toBe(200);
  await set({ allowedCidrs: ["203.0.113.7/32"] });
  const tool = mcpTool(serviceId);
  const get = async (approvalId: string) => (await callOp(panel, approvalOps.get, { approvalId }, { cookie })).body;

  // Turning them on, the stored list kept: who gets in is that list.
  expect((await tool({ allowPlain: true }))?.content[0]?.text).toContain("needs a person's approval");
  const allowId = pendingExposures()[0]?.id as string;
  expect((await get(allowId)).warning).toEqual({
    kind: "plainConnections",
    change: "allow",
    allowedCidrs: ["203.0.113.7/32"],
    openToEveryone: false,
  });
  // The list says so too, for every viewer that may see it.
  const listed = (await callOp(panel, approvalOps.list, {}, { cookie })).body.approvals;
  expect(listed.find((a: { id: string }) => a.id === allowId)?.warning).toMatchObject({ change: "allow" });

  // Read as approving it would run now: the person turned them on and emptied the list meanwhile.
  await set({ allowPlain: true, allowedCidrs: [] });
  expect(await get(allowId)).not.toHaveProperty("warning");
  await set({ allowPlain: false, allowedCidrs: ["203.0.113.7/32"] });
  expect((await get(allowId)).warning).toMatchObject({ change: "allow", allowedCidrs: ["203.0.113.7/32"] });

  // While they are let in, a catch-all in place of the list: from more addresses, every IP.
  await set({ allowPlain: true });
  expect(await get(allowId)).not.toHaveProperty("warning");
  await tool({ allowedCidrs: ["0.0.0.0/1", "128.0.0.0/1"] });
  const widenId = pendingExposures().find((row) => row.id !== allowId)?.id as string;
  expect((await get(widenId)).warning).toEqual({
    kind: "plainConnections",
    change: "widen",
    allowedCidrs: ["0.0.0.0/1", "128.0.0.0/1"],
    openToEveryone: true,
  });

  // Decided: nothing more to warn about.
  const approved = await callOp(panel, approvalOps.approve, { approvalId: widenId }, { cookie });
  expect(approved.body.status).toBe("executed");
  expect(approved.body).not.toHaveProperty("warning");
  expect(await get(widenId)).not.toHaveProperty("warning");
  const denied = await callOp(panel, approvalOps.deny, { approvalId: allowId }, { cookie });
  expect(denied.body).not.toHaveProperty("warning");
});
