// A node's Panel address (agent-hub/panel-address.ts): "follow" names the
// live panel domain in HelloAccepted.panel_url, "stay" never does. The
// owner picks it in the node's settings; `seylo set-panel` and a join with
// --pin at an IP address (while the panel has a domain) ask for "stay"
// through ClientHello.stay_on_address; an open move alert about an
// inspected certificate counts as "stay" until someone chooses. Also what
// an offline node's row and page say about why: its last refused hello,
// and the reason its agent reports once it is back.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { nodes as nodeOps } from "@seylo/ops";
import { HelloRejectReason, NodeAlertKind, PanelAddressChoice, ReportEventRequestSchema, ReportEventResponseSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { agentMoveTarget, askNodesToMove } from "../src/agent-hub/move-target";
import { panelAddressChoice } from "../src/agent-hub/panel-address";
import { auditLog, nodes } from "../src/db/schema";
import { compileNodeSettings } from "../src/desired/compile";
import { toNode, toNodeDetail } from "../src/modules/nodes/view";
import { setSetting } from "../src/settings";
import { agentKey, type FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

let panel: TestPanel;
let url: string;
beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
});
afterEach(() => panel.close());

function liveDomain(domain = "panel.example.com") {
  setSetting(panel.deps.db, "panelDomain", domain);
  setSetting(panel.deps.db, "panelDomainStatus", { domain, state: "active", message: "", checkedAt: Date.now() });
}

async function reconnect(agent: FakeAgent, options: Parameters<typeof joinAgent>[2] = {}): Promise<FakeAgent> {
  await agent.close();
  await Bun.sleep(20);
  return joinAgent(panel, url, { nodeId: agent.nodeId, key: agent.key, ...options });
}

function row(nodeId: string) {
  const found = panel.deps.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!found) throw new Error("node row missing");
  return found;
}

/** The panel node joins first; the node under test second. */
async function twoNodes(): Promise<FakeAgent> {
  await joinAgent(panel, url);
  return joinAgent(panel, url);
}

function reportMoveAlert(
  agent: FakeAgent,
  outboxId: bigint,
  value: { message: string; inspectedCertificate?: boolean; resolved?: boolean },
) {
  return agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId,
    event: { payload: { case: "nodeAlert", value: { kind: NodeAlertKind.PANEL_MOVE_FAILED, resolved: false, ...value } } },
  });
}

test("a stay node never gets the domain; the owner's choice is audited and follow moves it again", async () => {
  const { cookie } = await createUser(panel, "owner");
  liveDomain();
  let agent = await twoNodes();
  expect(agent.accepted).toMatchObject({ panelUrl: "https://panel.example.com", panelAddress: PanelAddressChoice.FOLLOW });
  expect(toNodeDetail(panel.deps, row(agent.nodeId))).toMatchObject({ panelAddressChoice: "follow", panelAddressChoiceBy: "default" });

  const saved = await callOp(panel, nodeOps.updateSettings, { nodeId: agent.nodeId, panelAddressChoice: "stay" }, { cookie });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ panelAddressChoice: "stay", panelAddressChoiceBy: "owner" });
  expect(agentMoveTarget(panel.deps.db, agent.nodeId)).toBeNull();
  agent = await reconnect(agent);
  expect(agent.accepted).toMatchObject({ panelUrl: "", panelPin: "", panelAddress: PanelAddressChoice.STAY });
  // The domain going live again asks nobody that stays.
  expect(askNodesToMove({ db: panel.deps.db, agents: panel.deps.agents, logger: panel.deps.logger })).toBe(0);
  const audited = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "nodes.updateSettings")).all();
  expect(audited.at(-1)?.input).toMatchObject({ nodeId: agent.nodeId, panelAddressChoice: "stay" });

  // Back to follow: the connected node is asked to reconnect, and the domain is named again.
  let asked = 0;
  const original = panel.deps.agents.reconnect.bind(panel.deps.agents);
  panel.deps.agents.reconnect = (nodeId, reason) => {
    asked++;
    original(nodeId, reason);
  };
  await callOp(panel, nodeOps.updateSettings, { nodeId: agent.nodeId, panelAddressChoice: "follow" }, { cookie });
  expect(asked).toBe(1);
  agent = await reconnect(agent);
  expect(agent.accepted).toMatchObject({ panelUrl: "https://panel.example.com", panelAddress: PanelAddressChoice.FOLLOW });
});

test("the panel node has no Panel address to choose", async () => {
  const { cookie } = await createUser(panel, "owner");
  const panelNode = await joinAgent(panel, url);
  const res = await callOp(panel, nodeOps.updateSettings, { nodeId: panelNode.nodeId, panelAddressChoice: "stay" }, { cookie });
  expect(res.status).toBe(409);
  expect(res.body.error).toMatchObject({ code: "CONFLICT", details: { reason: "panelNode" } });
  expect(toNodeDetail(panel.deps, row(panelNode.nodeId)).panelAddressChoice).toBeUndefined();
});

test("set-panel's stay request is recorded before HelloAccepted names an address", async () => {
  liveDomain();
  const agent = await twoNodes();
  const again = await reconnect(agent, { stayOnAddress: true });
  expect(again.accepted).toMatchObject({ panelUrl: "", panelAddress: PanelAddressChoice.STAY });
  expect(panelAddressChoice(panel.deps.db, agent.nodeId)).toMatchObject({ choice: "stay", by: "node" });
  const audit = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "nodes.panelAddressRequest")).all();
  expect(audit).toHaveLength(1);
  expect(audit[0]?.input).toMatchObject({ nodeId: agent.nodeId, panelAddressChoice: "stay", by: "seylo set-panel" });
  // Asked again (an agent that did not see the answer): nothing new to store or audit.
  await reconnect(again, { stayOnAddress: true });
  expect(panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "nodes.panelAddressRequest")).all()).toHaveLength(1);
});

test("a join with --pin at an IP stays only when the panel has a domain the owner passed over", async () => {
  await joinAgent(panel, url);
  const before = await joinAgent(panel, url, { stayOnAddress: true });
  // No domain: the IP command was the only one; the node follows a domain set later.
  expect(before.accepted?.panelAddress).toBe(PanelAddressChoice.FOLLOW);
  expect(panelAddressChoice(panel.deps.db, before.nodeId)).toMatchObject({ choice: "follow", by: "default" });

  liveDomain();
  const after = await joinAgent(panel, url, { stayOnAddress: true });
  expect(after.accepted).toMatchObject({ panelUrl: "", panelAddress: PanelAddressChoice.STAY });
  expect(panelAddressChoice(panel.deps.db, after.nodeId)).toMatchObject({ choice: "stay", by: "join" });
  // The node that joined earlier is told to move.
  const moved = await reconnect(before);
  expect(moved.accepted?.panelUrl).toBe("https://panel.example.com");
});

test("an open move alert about an inspected certificate keeps the node on its address until the owner chooses", async () => {
  const { cookie } = await createUser(panel, "owner");
  liveDomain();
  let agent = await twoNodes();

  // A move that failed for another reason changes nothing.
  await reportMoveAlert(agent, 1n, { message: "Could not move to the panel address https://panel.example.com: connection refused" });
  expect(panelAddressChoice(panel.deps.db, agent.nodeId).choice).toBe("follow");
  await reportMoveAlert(agent, 2n, { message: "moved", resolved: true });

  await reportMoveAlert(agent, 3n, { message: "Could not move ... TLS inspection ...", inspectedCertificate: true });
  expect(panelAddressChoice(panel.deps.db, agent.nodeId)).toMatchObject({ choice: "stay", by: "inspectedCertificate" });
  expect(agentMoveTarget(panel.deps.db, agent.nodeId)).toBeNull();
  agent = await reconnect(agent);
  expect(agent.accepted).toMatchObject({ panelUrl: "", panelAddress: PanelAddressChoice.STAY });
  expect(toNodeDetail(panel.deps, row(agent.nodeId))).toMatchObject({
    panelAddressChoice: "stay",
    panelAddressChoiceBy: "inspectedCertificate",
  });

  // The owner chooses follow: that wins over the open alert.
  await callOp(panel, nodeOps.updateSettings, { nodeId: agent.nodeId, panelAddressChoice: "follow" }, { cookie });
  expect(agentMoveTarget(panel.deps.db, agent.nodeId)).not.toBeNull();
});

test("an agent before 0.2.14 says so in the message only", async () => {
  liveDomain();
  const agent = await twoNodes();
  await reportMoveAlert(agent, 1n, {
    message:
      "Could not move to the panel address https://panel.example.com: dial panel: tls: failed to verify certificate: x509: certificate signed by unknown authority\nThe node keeps connecting through https://203.0.113.4:3443.",
  });
  expect(panelAddressChoice(panel.deps.db, agent.nodeId)).toMatchObject({ choice: "stay", by: "inspectedCertificate" });
  await reportMoveAlert(agent, 2n, { message: "The node connects through https://panel.example.com now", resolved: true });
  expect(panelAddressChoice(panel.deps.db, agent.nodeId).choice).toBe("follow");
});

test("Traefik's own certificate at the domain is no inspected certificate, from any agent", async () => {
  liveDomain();
  const agent = await twoNodes();
  // A 0.2.13 agent moving from a pinned address: Go's error, conn's hint and its own sentence about TLS inspection.
  await reportMoveAlert(agent, 1n, {
    message:
      "Could not move to the panel address https://panel.example.com: dial panel: tls: failed to verify certificate: x509: certificate signed by unknown authority. " +
      "panel.example.com answers with Traefik's own certificate: the panel's server has no certificate for that name yet (see the panel domain's status)\n" +
      "The node keeps connecting through https://203.0.113.4:3443 and tries again in 24 hours or when the agent restarts. " +
      "If the node's network decrypts HTTPS (TLS inspection), it cannot use that address and stays on its pinned one.",
  });
  expect(panelAddressChoice(panel.deps.db, agent.nodeId)).toMatchObject({ choice: "follow", by: "default" });
  await reportMoveAlert(agent, 2n, { message: "moved", resolved: true });
  // The same in place of a pin.
  await reportMoveAlert(agent, 3n, {
    message:
      "Could not move to the panel address https://panel.example.com: dial panel: conn: panel certificate does not match the pinned key " +
      '(the certificate presented says it was issued by "TRAEFIK DEFAULT CERT"). panel.example.com did not present the panel\'s pinned key: ' +
      "a firewall or proxy on this server's network may decrypt HTTPS (TLS inspection), or the address leads to another server",
  });
  expect(panelAddressChoice(panel.deps.db, agent.nodeId).choice).toBe("follow");
  expect(agentMoveTarget(panel.deps.db, agent.nodeId)).not.toBeNull();
});

test("HelloAccepted and the desired state carry the panel's name for the node", async () => {
  const { cookie } = await createUser(panel, "owner");
  let agent = await twoNodes();
  const name = row(agent.nodeId).name;
  expect(agent.accepted?.nodeName).toBe(name);
  await callOp(panel, nodeOps.rename, { nodeId: agent.nodeId, name: "edge-east" }, { cookie });
  const settings = compileNodeSettings(panel.deps.db, row(agent.nodeId), { revision: 1n, secrets: panel.deps.secrets });
  expect(settings.nodeName).toBe("edge-east");
  agent = await reconnect(agent);
  expect(agent.accepted?.nodeName).toBe("edge-east");
});

test("an offline node's row says why the panel refused it, and only with the node's own signature", async () => {
  const agent = await twoNodes();
  const nodeId = agent.nodeId;
  await agent.close();
  await Bun.sleep(20);
  expect(toNode(panel.deps, row(nodeId)).rejectedHello).toBeUndefined();

  // Somebody else's key: a too-old hello in the node's name is not recorded.
  panel.deps.agents.setAgentVersionPolicy(() => "1.4.0");
  const stranger = await joinAgent(panel, url, { nodeId, key: agentKey(), agentVersion: "1.2.9" });
  expect(stranger.rejected?.reason).toBe(HelloRejectReason.AGENT_TOO_OLD);
  expect(toNode(panel.deps, row(nodeId)).rejectedHello).toBeUndefined();

  // The node's own too-old agent: the row says so, with the panel's message.
  const old = await joinAgent(panel, url, { nodeId, key: agent.key, agentVersion: "1.2.9" });
  expect(old.rejected?.reason).toBe(HelloRejectReason.AGENT_TOO_OLD);
  expect(toNode(panel.deps, row(nodeId)).rejectedHello).toMatchObject({
    reason: "AGENT_TOO_OLD",
    message: "This agent (1.2.9) is too old for this panel. It needs 1.4.0 or newer.",
  });

  // A key that does not match is a refusal of its own.
  panel.deps.agents.setAgentVersionPolicy(() => null);
  const wrongKey = await joinAgent(panel, url, { nodeId, key: agentKey() });
  expect(wrongKey.rejected?.reason).toBe(HelloRejectReason.BAD_SIGNATURE);
  expect(toNode(panel.deps, row(nodeId)).rejectedHello).toMatchObject({ reason: "BAD_SIGNATURE" });

  // A connect clears it: offline again later, the row shows only when it was last seen.
  const back = await joinAgent(panel, url, { nodeId, key: agent.key });
  expect(back.rejected).toBeNull();
  expect(toNode(panel.deps, row(nodeId)).rejectedHello).toBeUndefined();
  await back.close();
  await Bun.sleep(20);
  expect(toNode(panel.deps, row(nodeId))).toMatchObject({ status: "offline" });
  expect(toNode(panel.deps, row(nodeId)).rejectedHello).toBeUndefined();
});

test("the reason an agent was away is kept for the node's page", async () => {
  const agent = await twoNodes();
  expect(toNodeDetail(panel.deps, row(agent.nodeId)).lastOffline).toBeUndefined();
  const since = Date.now() - 7 * 60_000;
  const back = await reconnect(agent, {
    away: {
      lastError: 'dial panel: x509: certificate signed by unknown authority\n(issued by "Fortinet")\u001b[2K',
      sinceMs: since,
      failedAttempts: 9,
    },
  });
  const report = toNodeDetail(panel.deps, row(back.nodeId)).lastOffline;
  expect(report?.reason).toBe('dial panel: x509: certificate signed by unknown authority (issued by "Fortinet")[2K');
  expect(report?.failedAttempts).toBe(9);
  expect(Date.parse(report?.from ?? "")).toBe(since);
  expect(Date.parse(report?.to ?? "")).toBeGreaterThan(since);
  // A later connect without a report keeps the last one; a since in the future starts at the reconnect.
  const again = await reconnect(back, { away: { lastError: "dial panel: connection refused", sinceMs: Date.now() + 3_600_000 } });
  const next = toNodeDetail(panel.deps, row(again.nodeId)).lastOffline;
  expect(next?.reason).toBe("dial panel: connection refused");
  expect(next?.from).toBe(next?.to);
  const plain = await reconnect(again);
  expect(toNodeDetail(panel.deps, row(plain.nodeId)).lastOffline?.reason).toBe("dial panel: connection refused");
});
