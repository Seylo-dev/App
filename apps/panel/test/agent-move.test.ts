// Once the panel domain is live, HelloAccepted tells nodes that
// joined over an IP address to dial https://<domain> (no pin: a live domain
// has a public certificate). The panel's own node keeps loopback, and a
// failed move reaches the alert feed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { NodeAlertKind, ReportEventRequestSchema, ReportEventResponseSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { agentMoveTarget } from "../src/agent-hub/move-target";
import { alerts, nodes } from "../src/db/schema";
import { toNodeDetail } from "../src/modules/nodes/view";
import { setSetting } from "../src/settings";
import type { FakeAgent } from "./fake-agent";
import { type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

let panel: TestPanel;
let url: string;
beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
});
afterEach(() => panel.close());

function liveDomain(domain: string, state: "active" | "issuing_certificate" = "active", statusDomain = domain) {
  setSetting(panel.deps.db, "panelDomain", domain);
  setSetting(panel.deps.db, "panelDomainStatus", { domain: statusDomain, state, message: "", checkedAt: Date.now() });
}

async function reconnect(agent: FakeAgent): Promise<FakeAgent> {
  await agent.close();
  await Bun.sleep(20);
  return joinAgent(panel, url, { nodeId: agent.nodeId, key: agent.key });
}

test("nodes are told to move only once the panel domain is live, and the panel node never", async () => {
  const panelNode = await joinAgent(panel, url);
  let other = await joinAgent(panel, url);
  expect(panel.deps.db.select().from(nodes).where(eq(nodes.id, panelNode.nodeId)).get()?.isPanelNode).toBe(true);
  expect(other.accepted).toMatchObject({ panelUrl: "", panelPin: "" });

  // A domain without a working certificate yet moves nobody.
  liveDomain("panel.example.com", "issuing_certificate");
  other = await reconnect(other);
  expect(other.accepted?.panelUrl).toBe("");

  liveDomain("Panel.Example.com");
  other = await reconnect(other);
  expect(other.accepted).toMatchObject({ panelUrl: "https://panel.example.com", panelPin: "" });
  const again = await reconnect(panelNode);
  expect(again.accepted?.panelUrl).toBe("");

  // A status left over from an earlier domain does not count for the new one.
  liveDomain("new.example.com", "active", "panel.example.com");
  expect(agentMoveTarget(panel.deps.db, other.nodeId)).toBeNull();
  // Unknown nodes get nothing either.
  liveDomain("panel.example.com");
  expect(agentMoveTarget(panel.deps.db, "nosuchnode000000")).toBeNull();
});

test("nodes.get names the panel address the node's agent dialed, and null while it is offline", async () => {
  const agent = await joinAgent(panel, url);
  const detail = () => {
    const row = panel.deps.db.select().from(nodes).where(eq(nodes.id, agent.nodeId)).get();
    if (!row) throw new Error("node row missing");
    return toNodeDetail(panel.deps, row);
  };
  expect(detail().panelAddress).toBe(url);
  await agent.close();
  await Bun.sleep(20);
  expect(detail().panelAddress).toBeNull();
});

test("a failed move raises one alert per streak and resolves when the move works", async () => {
  await joinAgent(panel, url);
  const agent = await joinAgent(panel, url);
  const report = (outboxId: bigint, resolved: boolean) =>
    agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
      outboxId,
      event: {
        payload: {
          case: "nodeAlert",
          value: {
            kind: NodeAlertKind.PANEL_MOVE_FAILED,
            message: "could not move to https://panel.example.com: x509: unknown authority",
            resolved,
          },
        },
      },
    });
  await report(1n, false);
  await report(2n, false);
  const open = panel.deps.db.select().from(alerts).where(eq(alerts.nodeId, agent.nodeId)).all();
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ event: "node_health_check_failed", resolvedAt: null });
  expect(open[0]?.title).toContain("could not move to https://panel.example.com");
  await report(3n, true);
  expect(panel.deps.db.select().from(alerts).where(eq(alerts.nodeId, agent.nodeId)).get()?.resolvedAt).not.toBeNull();
});
