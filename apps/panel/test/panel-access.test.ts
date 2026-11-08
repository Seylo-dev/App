// settings.panelAccess and settings.updatePanelAccess (added in 0.2.1):
// who may turn "Serve on IP address" and "Agents' port" off, from where,
// and what blocks it. The panel domain here is panel.test, the host
// callOp talks to; "over the domain" means a trusted proxy said https
// (as the node's Traefik does), "over IP:port" means it did not.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { settings } from "@seylo/ops";
import { NodeFactsSchema } from "@seylo/proto";
import { desc, eq } from "drizzle-orm";
import { recordDialedUrl } from "../src/agent-hub/dialed";
import type { ConnectedAgent } from "../src/agent-hub/hub";
import { createSession } from "../src/auth/sessions";
import { auditLog, nodes, sessions, updateRuns, users } from "../src/db/schema";
import { createProxyTrust } from "../src/http/proxy-trust";
import { ensurePanelService } from "../src/modules/nodes/panel-service";
import {
  applyPanelIpAccess,
  panelPublishBindCapability,
  readIpAccessApplied,
  readPanelAccessWanted,
} from "../src/modules/settings/ip-access";
import { getSetting, setSetting } from "../src/settings";
import { callOp, createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { type FakeAgent, fakeAgent } from "./seed-helpers";

const domain = "panel.test";
const overDomain = { "x-forwarded-proto": "https" };
let panel: TestPanel;
let panelNode: string;
let agent: FakeAgent | null;
let owner: Awaited<ReturnType<typeof createUser>>;

function connect(capable = true) {
  agent?.disconnect();
  agent = fakeAgent(panel, panelNode, {}, [], capable ? [panelPublishBindCapability] : []);
}

function activeDomain() {
  setSetting(panel.deps.db, "panelDomain", domain);
  setSetting(panel.deps.db, "panelDomainStatus", {
    domain,
    state: "active",
    message: "",
    checkedAt: Date.now(),
    working: true,
    since: Date.now() - 3_600_000,
  });
}

function addNode(name: string) {
  return panel.deps.db
    .insert(nodes)
    .values({ name, publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) })
    .returning()
    .get().id;
}

/** An online node whose session dialed `address`. */
function onlineNode(nodeId: string, address: string): () => void {
  const session = {
    nodeId,
    sessionId: crypto.randomUUID(),
    facts: create(NodeFactsSchema, { hostname: "b", capabilities: [] }),
    host: new URL(address).host,
    address,
    transport: {
      call: async () => new Uint8Array(),
      open: () => {
        throw new Error("unused");
      },
    },
    close() {},
  } as unknown as ConnectedAgent;
  panel.deps.agents.register(session);
  return () => panel.deps.agents.unregister(session);
}

const update = (input: Parameters<typeof callOp<typeof settings.updatePanelAccess>>[2], cookie = owner.cookie, headers = overDomain) =>
  callOp(panel, settings.updatePanelAccess, input, { cookie, headers });

function ageSessions() {
  panel.deps.db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - 20 * 60_000), reauthAt: null })
    .run();
}

beforeEach(async () => {
  // The node's Traefik is the trusted proxy; trusting every peer stands in for it.
  panel = testPanel({ proxy: createProxyTrust({ always: true, proxies: [] }) });
  panel.deps.config.image = `ghcr.io/seylo-dev/seylo:0.2.1@sha256:${"d".repeat(64)}`;
  panel.deps.config.hostPort = 3000;
  setSetting(panel.deps.db, "panelAgentTlsPort", 3443);
  panelNode = panel.deps.db
    .insert(nodes)
    .values({ name: "here", publicKey: Buffer.alloc(32, 9), publicIpv4: "203.0.113.10", isPanelNode: true })
    .returning()
    .get().id;
  ensurePanelService(panel.deps);
  agent = null;
  connect();
  activeDomain();
  owner = await createUser(panel, "owner");
});
afterEach(() => {
  agent?.disconnect();
  panel.close();
});

test("the owner closes IP access over the domain; the panel rolls and the card says so", async () => {
  const view = await callOp(panel, settings.panelAccess, {}, { cookie: owner.cookie, headers: overDomain });
  expect(view.status).toBe(200);
  expect(view.body).toMatchObject({
    serveOnIp: true,
    agentPortOpen: true,
    onFailure: "reopen",
    panelPort: 3000,
    agentPort: 3443,
    actual: { ip: "open", agentPort: "open" },
    privatePaths: [{ kind: "domain", url: "https://panel.test", working: true, usingNow: true }],
    blocked: [],
    agentPortBlocked: [],
    reclosesAt: null,
    lastChange: null,
    recovery: { sshTunnel: "ssh -L 3000:127.0.0.1:3000 root@203.0.113.10", cli: "sudo seylo panel ip-access on" },
  });

  const closed = await update({ serveOnIp: false });
  expect(closed.status).toBe(200);
  expect(closed.body).toMatchObject({
    serveOnIp: false,
    actual: { ip: "unknown" },
    lastChange: { reason: "Serve on IP address turned off in Settings", by: owner.user.email },
  });
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: true, agentPortClosed: false, by: owner.user.email });
  const row = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "settings.updatePanelAccess")).orderBy(desc(auditLog.id)).get();
  expect(row).toMatchObject({ outcome: "ok", input: { serveOnIp: false, applied: { closed: true, agentPortClosed: false } } });
  // A person's change has their op's audit row, not a second one from the system.
  expect(panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "settings.ipAccessChanged")).all()).toEqual([]);
});

test("IP:port with a forged Host is refused: its origin is http://", async () => {
  const forged = await update({ serveOnIp: false }, owner.cookie, {} as typeof overDomain);
  expect(forged.status).toBe(409);
  expect(forged.body.error.details.reason).toBe("notOnPrivatePath");
  // A forged X-Forwarded-Proto from a peer the panel does not trust counts for nothing either.
  const untrusted = testPanel();
  try {
    untrusted.deps.config.image = panel.deps.config.image;
    setSetting(untrusted.deps.db, "panelDomain", domain);
    setSetting(untrusted.deps.db, "panelDomainStatus", { domain, state: "active", message: "", checkedAt: Date.now(), working: true });
    const user = await createUser(untrusted, "owner");
    const refused = await callOp(untrusted, settings.updatePanelAccess, { serveOnIp: false }, { cookie: user.cookie, headers: overDomain });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("notOnPrivatePath");
  } finally {
    untrusted.close();
  }
  expect(readPanelAccessWanted(panel.deps).serveOnIp).toBe(true);
});

test("only the owner's browser session turns it off: not an admin, an API key, MCP or the assistant", async () => {
  const admin = await createUser(panel, "admin");
  const byAdmin = await update({ serveOnIp: false }, admin.cookie);
  expect(byAdmin.status).toBe(409);
  expect(byAdmin.body.error.details.reason).toBe("notOwner");

  const key = createApiKey(panel, owner.user.id);
  const byKey = await callOp(panel, settings.updatePanelAccess, { serveOnIp: false }, { bearer: key, headers: overDomain });
  expect(byKey.status).toBe(409);
  expect(byKey.body.error.details.reason).toBe("notBrowserSession");

  const mcp = createApiKey(panel, owner.user.id, { kind: "mcp" });
  expect((await callOp(panel, settings.updatePanelAccess, { serveOnIp: false }, { bearer: mcp, headers: overDomain })).status).toBe(403);

  const row = panel.deps.db.select().from(users).where(eq(users.id, owner.user.id)).get();
  const session = createSession(panel.deps.db, row?.id ?? "", { ip: null, userAgent: null });
  const byAssistant = await panel.execute({
    op: settings.updatePanelAccess,
    rawInput: { serveOnIp: false },
    credentials: { sessionToken: session.token, sessionKey: session.key },
    transport: "ai",
    coerce: false,
    ip: null,
    userAgent: null,
    http: null,
    origin: "https://panel.test",
  });
  expect(byAssistant.ok).toBe(false);
  expect(readPanelAccessWanted(panel.deps).serveOnIp).toBe(true);
});

test("a stale sign-in asks to confirm it is you, after the other checks pass", async () => {
  ageSessions();
  const stale = await update({ serveOnIp: false });
  expect(stale.status).toBe(403);
  expect(stale.body.error.details.reason).toBe("reauth");
  // A refusal that re-auth would not fix comes first.
  const stalePort = await update({ serveOnIp: false }, owner.cookie, {} as typeof overDomain);
  expect(stalePort.body.error.details.reason).toBe("notOnPrivatePath");
});

test("a node on plain http:// blocks, online or offline, and is named with the fix", async () => {
  const b1 = addNode("b1");
  const offline = addNode("b2");
  recordDialedUrl(panel.deps.db, offline, "http://203.0.113.21:3000");
  const disconnect = onlineNode(b1, "http://203.0.113.20:3000");
  try {
    const refused = await update({ serveOnIp: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({ reason: "plainHttpNodes" });
    expect(refused.body.error.details.nodeIds.split(",").sort()).toEqual([b1, offline].sort());
    expect(refused.body.error.message).toContain("b1 and b2 connect over plain http://");
    expect(refused.body.error.message).toContain("--force");
    // The address it dials now is remembered for when it is offline.
    expect(getSetting(panel.deps.db, "nodeDialedUrls")?.[b1]?.url).toBe("http://203.0.113.20:3000");
  } finally {
    disconnect();
  }
  // Once both join again over https, nothing blocks.
  recordDialedUrl(panel.deps.db, b1, "https://203.0.113.10:3443");
  recordDialedUrl(panel.deps.db, offline, "https://panel.test");
  expect((await update({ serveOnIp: false })).status).toBe(200);
});

test("a node the panel never saw connect blocks too: it might dial plain http://", async () => {
  const b1 = addNode("b1");
  const refused = await update({ serveOnIp: false });
  expect(refused.body.error.details).toMatchObject({ reason: "plainHttpNodes", nodeIds: b1 });
  expect(refused.body.error.message).toContain("has not connected since");
  panel.deps.db.update(nodes).set({ disabledAt: new Date() }).where(eq(nodes.id, b1)).run();
  expect((await update({ serveOnIp: false })).status).toBe(200);
});

test("an update run, an offline panel node and an old agent block", async () => {
  const run = panel.deps.db.insert(updateRuns).values({ targetVersion: "0.2.2", trigger: "manual" }).returning().get();
  expect((await update({ serveOnIp: false })).body.error.details.reason).toBe("updateRunning");
  panel.deps.db.update(updateRuns).set({ status: "succeeded" }).where(eq(updateRuns.id, run.id)).run();

  connect(false);
  expect((await update({ serveOnIp: false })).body.error.details.reason).toBe("agentTooOld");
  agent?.disconnect();
  agent = null;
  expect((await update({ serveOnIp: false })).body.error.details.reason).toBe("panelNodeOffline");
  connect(true);
  expect((await update({ serveOnIp: false })).status).toBe(200);
});

test("without a working private path closing is refused, and the card says how to get one", async () => {
  setSetting(panel.deps.db, "panelDomainStatus", {
    domain,
    state: "pending_dns",
    message: "Add an A record.",
    checkedAt: Date.now(),
    working: false,
  });
  const refused = await update({ serveOnIp: false });
  expect(refused.body.error.details.reason).toBe("noPrivatePath");
  expect(refused.body.error.message).toContain("panel.test is not active yet");
});

test("the agents' port closes only once every other node dials the domain", async () => {
  const b1 = addNode("b1");
  recordDialedUrl(panel.deps.db, b1, "https://203.0.113.10:3443");
  const both = await update({ serveOnIp: false, agentPortOpen: false });
  expect(both.status).toBe(409);
  expect(both.body.error.details).toMatchObject({ reason: "nodesOnAgentPort", nodeIds: b1 });
  // Serving on IP alone is fine: b1 keeps the agents' port.
  expect((await update({ serveOnIp: false })).status).toBe(200);
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: true, agentPortClosed: false });

  recordDialedUrl(panel.deps.db, b1, "https://panel.test");
  expect((await update({ agentPortOpen: false })).status).toBe(200);
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: true, agentPortClosed: true });

  setSetting(panel.deps.db, "panelAgentTlsPort", null as never);
  const view = await callOp(panel, settings.panelAccess, {}, { cookie: owner.cookie, headers: overDomain });
  expect(view.body.agentPort).toBeNull();
  expect(view.body.agentPortBlocked.map((b: { code: string }) => b.code)).toContain("noAgentPort");
});

test("the panel node's own agent must dial loopback: a public address blocks, with the join command", async () => {
  recordDialedUrl(panel.deps.db, panelNode, "http://203.0.113.10:3000");
  const refused = await update({ serveOnIp: false });
  expect(refused.status).toBe(409);
  expect(refused.body.error.details).toMatchObject({ reason: "panelNodeNotLoopback", nodeIds: panelNode });
  expect(refused.body.error.message).toBe(
    "here, the panel's own node, connects over http://203.0.113.10:3000 instead of 127.0.0.1, so it can lose the panel once IP access closes. On the panel's server, join it again on 127.0.0.1 with a token from Nodes > Add node: sudo seylo join http://127.0.0.1:3000 --token '<token>' --force",
  );
  // Listed once for the agents' port too.
  const view = await callOp(panel, settings.panelAccess, {}, { cookie: owner.cookie, headers: overDomain });
  expect(view.body.agentPortBlocked.filter((b: { code: string }) => b.code === "panelNodeNotLoopback")).toHaveLength(1);

  // Over the agents' TLS port: IP access may close, the agents' port may not.
  recordDialedUrl(panel.deps.db, panelNode, "https://203.0.113.10:3443");
  expect((await update({ serveOnIp: false })).status).toBe(200);
  const port = await update({ agentPortOpen: false });
  expect(port.status).toBe(409);
  expect(port.body.error.details).toMatchObject({ reason: "panelNodeNotLoopback", nodeIds: panelNode });
  expect(port.body.error.message).toContain("so it can lose the panel once the agents' port closes");
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: true, agentPortClosed: false });

  // Back on loopback (or on the domain), nothing blocks.
  recordDialedUrl(panel.deps.db, panelNode, "https://panel.test");
  expect((await callOp(panel, settings.panelAccess, {}, { cookie: owner.cookie, headers: overDomain })).body.agentPortBlocked).toEqual([]);
  recordDialedUrl(panel.deps.db, panelNode, "http://127.0.0.1:3000");
  expect((await update({ agentPortOpen: false })).status).toBe(200);
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: true, agentPortClosed: true });
});

test("keep it closed needs the tick that the recovery commands are saved", async () => {
  const missing = await update({ onFailure: "stayClosed" });
  expect(missing.status).toBe(400);
  expect(missing.body.error.details.field).toBe("savedRecovery");
  const admin = await createUser(panel, "admin");
  expect((await update({ onFailure: "stayClosed", savedRecovery: true }, admin.cookie)).body.error.details.reason).toBe("notOwner");
  const saved = await update({ onFailure: "stayClosed", savedRecovery: true });
  expect(saved.status).toBe(200);
  expect(saved.body.onFailure).toBe("stayClosed");
  // Back to reopen is a turn-on: an admin may.
  expect((await update({ onFailure: "reopen" }, admin.cookie)).status).toBe(200);
});

test("turning things back on is always allowed: an admin, an API key, from IP:port, with a stale sign-in", async () => {
  expect((await update({ serveOnIp: false, agentPortOpen: false })).status).toBe(200);
  ageSessions();
  const admin = await createUser(panel, "admin");
  expect((await update({ agentPortOpen: true }, admin.cookie, {} as typeof overDomain)).status).toBe(200);
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: true, agentPortClosed: false });
  const key = createApiKey(panel, admin.user.id);
  const reopened = await callOp(panel, settings.updatePanelAccess, { serveOnIp: true }, { bearer: key });
  expect(reopened.status).toBe(200);
  expect(reopened.body.serveOnIp).toBe(true);
  expect(readIpAccessApplied(panel.deps).closed).toBe(false);
  // A member cannot change settings at all.
  const member = await createUser(panel, "member");
  expect((await update({ serveOnIp: true }, member.cookie)).status).toBe(403);
});

/** The domain fails its checks and IP access reopens by itself; then the domain works again. */
function reopenAutomatically() {
  setSetting(panel.deps.db, "panelDomainStatus", {
    domain,
    state: "issuing_certificate",
    message: "",
    checkedAt: Date.now(),
    working: false,
    since: Date.now(),
    failedChecks: 2,
  });
  expect(applyPanelIpAccess(panel.deps, "the panel domain stopped working")).toMatchObject({ closed: false });
  activeDomain();
}

test("after an automatic reopen, only the owner's turn-off skips the hour: not a re-save, reopen or a turn-on", async () => {
  expect((await update({ serveOnIp: false, agentPortOpen: false })).status).toBe(200);
  reopenAutomatically();
  const reopenedAt = readIpAccessApplied(panel.deps).reopenedAt;
  expect(reopenedAt).toBeNumber();

  ageSessions();
  const admin = await createUser(panel, "admin");
  const key = createApiKey(panel, admin.user.id);
  for (const [input, credentials] of [
    [{ onFailure: "reopen" }, { cookie: admin.cookie }],
    [{ agentPortOpen: true }, { cookie: admin.cookie }],
    [{}, { bearer: key }],
    [{ onFailure: "reopen" }, { cookie: owner.cookie }],
  ] as const) {
    const saved = await callOp(panel, settings.updatePanelAccess, input, credentials);
    expect(saved.status).toBe(200);
    expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: false, reopenedAt });
    expect(saved.body.reclosesAt).not.toBeNull();
  }

  // The owner, over the domain and freshly signed in, closes it now.
  const fresh = await createUser(panel, "owner");
  expect((await update({ serveOnIp: false }, fresh.cookie)).status).toBe(200);
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: true, by: fresh.user.email });
  expect(readIpAccessApplied(panel.deps).reopenedAt).toBeUndefined();
});

test("the card says why IP access stays open, and warns about Docker older than 28", async () => {
  expect((await update({ serveOnIp: false })).status).toBe(200);
  let view = await callOp(panel, settings.panelAccess, {}, { cookie: owner.cookie, headers: overDomain });
  expect(view.body).toMatchObject({ openReason: null, oldDocker: null });

  reopenAutomatically();
  const b2 = addNode("b2");
  recordDialedUrl(panel.deps.db, b2, "http://203.0.113.5:3000");
  view = await callOp(panel, settings.panelAccess, {}, { cookie: owner.cookie, headers: overDomain });
  expect(view.body.openReason).toContain("node b2 connects over http://203.0.113.5:3000 and closing would cut it off");
  expect(view.body.reclosesAt).toBeNull();

  const facts = panel.deps.agents.state.get(panelNode)?.facts;
  panel.deps.agents.state.setFacts(
    panelNode,
    create(NodeFactsSchema, { hostname: "fake", capabilities: facts?.capabilities ?? [], dockerVersion: "27.5.1" }),
  );
  view = await callOp(panel, settings.panelAccess, {}, { cookie: owner.cookie, headers: overDomain });
  expect(view.body.oldDocker).toBe("27.5.1");
});

test("from IP:port the card lists why closing is refused, with the domain to open", async () => {
  const view = await callOp(panel, settings.panelAccess, {}, { cookie: owner.cookie });
  expect(view.body.privatePaths[0].usingNow).toBe(false);
  expect(view.body.blocked).toEqual([
    {
      code: "notOnPrivatePath",
      message: "You opened the panel on http://panel.test. Open https://panel.test and sign in there, then turn this off from that page.",
    },
  ]);
});

test("removing the domain reopens at once; in keep-closed mode it is refused", async () => {
  expect((await update({ serveOnIp: false })).status).toBe(200);
  expect((await update({ onFailure: "stayClosed", savedRecovery: true })).status).toBe(200);
  const refused = await callOp(
    panel,
    settings.updateGeneral,
    { domain: null, name: "Not saved" },
    { cookie: owner.cookie, headers: overDomain },
  );
  expect(refused.status).toBe(409);
  expect(refused.body.error.details.reason).toBe("stayClosed");
  // Nothing of the refused save was written.
  expect(getSetting(panel.deps.db, "panelName")).toBeUndefined();

  expect((await update({ onFailure: "reopen" })).status).toBe(200);
  const removed = await callOp(panel, settings.updateGeneral, { domain: null }, { cookie: owner.cookie, headers: overDomain });
  expect(removed.status).toBe(200);
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: false, reason: "the panel domain was removed", by: owner.user.email });
  // The switch stays off: it closes again by itself once a private path has worked for an hour.
  expect(readPanelAccessWanted(panel.deps).serveOnIp).toBe(false);
});

test("removing or changing the domain while nodes connect over it needs acknowledgeNodesOffline, and names them", async () => {
  const b1 = addNode("b1");
  const c1 = addNode("c1");
  const d1 = addNode("d1");
  // Joined over the domain (Add node prints it once a domain is set), online or not.
  recordDialedUrl(panel.deps.db, b1, "https://panel.test");
  const disconnect = onlineNode(c1, "https://panel.test");
  // On the agents' port: not cut off by the domain.
  recordDialedUrl(panel.deps.db, d1, "https://203.0.113.10:3443");
  try {
    const view = await callOp(panel, settings.general, {}, { cookie: owner.cookie });
    expect(view.body.domainNodes).toEqual([
      { id: b1, name: "b1" },
      { id: c1, name: "c1" },
    ]);

    for (const domainInput of [null, "other.example.com"]) {
      const refused = await callOp(
        panel,
        settings.updateGeneral,
        { domain: domainInput, name: "Not saved" },
        { cookie: owner.cookie, headers: overDomain },
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error.details).toMatchObject({ reason: "nodesOnDomain", field: "acknowledgeNodesOffline" });
      expect(refused.body.error.details.nodeIds.split(",").sort()).toEqual([b1, c1].sort());
      expect(refused.body.error.message).toContain("b1 and c1 connect over https://panel.test and go offline without it.");
      expect(refused.body.error.message).toContain(domainInput ? "to change the domain anyway" : "to remove the domain anyway");
    }
    // Nothing of the refused saves was written, and the route stays.
    expect(getSetting(panel.deps.db, "panelName")).toBeUndefined();
    expect(getSetting(panel.deps.db, "panelDomain")).toBe(domain);
    // Saving the same domain again, or anything else, is not a change.
    expect((await callOp(panel, settings.updateGeneral, { domain, name: "Acme" }, { cookie: owner.cookie })).status).toBe(200);

    const removed = await callOp(
      panel,
      settings.updateGeneral,
      { domain: null, acknowledgeNodesOffline: true },
      { cookie: owner.cookie, headers: overDomain },
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ domain: null, domainNodes: [] });
    const row = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "settings.updateGeneral")).orderBy(desc(auditLog.id)).get();
    expect(row).toMatchObject({ outcome: "ok", input: { domain: null, acknowledgeNodesOffline: true } });
  } finally {
    disconnect();
  }
});

test("a disabled node on the domain does not count, and a node on the old domain does not hold up the next one", async () => {
  const b1 = addNode("b1");
  const c1 = addNode("c1");
  recordDialedUrl(panel.deps.db, b1, "https://panel.test");
  recordDialedUrl(panel.deps.db, c1, "https://panel.test");
  panel.deps.db.update(nodes).set({ disabledAt: new Date() }).where(eq(nodes.id, b1)).run();
  const view = await callOp(panel, settings.general, {}, { cookie: owner.cookie });
  expect(view.body.domainNodes).toEqual([{ id: c1, name: "c1" }]);
  const moved = await callOp(
    panel,
    settings.updateGeneral,
    { domain: "new.example.com", acknowledgeNodesOffline: true },
    { cookie: owner.cookie, headers: overDomain },
  );
  expect(moved.status).toBe(200);
  // c1 still dials panel.test, which is no longer the domain: nothing to ask about new.example.com.
  expect(moved.body.domainNodes).toEqual([]);
  expect((await callOp(panel, settings.updateGeneral, { domain: null }, { cookie: owner.cookie, headers: overDomain })).status).toBe(200);
});
