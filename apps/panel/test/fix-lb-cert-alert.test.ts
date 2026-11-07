// Agents turn load balancing to a node off while it has no LB certificate,
// so the owner must see why: a node whose certificate cannot be issued (for
// example the LB CA key does not open with this master.key) gets one alert,
// and the alert is resolved once a certificate is issued.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { alerts } from "../src/db/schema";
import { issueNodeCertificate } from "../src/modules/nodes/lb-tls";
import { createSecretBox } from "../src/security/secret-box";
import { getSetting, setSetting } from "../src/settings";
import type { FakeAgent } from "./fake-agent";
import { type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

let panel: TestPanel;
let url: string;
const agents: FakeAgent[] = [];
beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

const openAlerts = (nodeId: string) =>
  panel.deps.db
    .select()
    .from(alerts)
    .where(and(eq(alerts.nodeId, nodeId), isNull(alerts.resolvedAt)))
    .all()
    .filter((a) => a.eventKey.startsWith(`lb-certificate:${nodeId}:`));

/** A CA whose key was sealed with another master key, as after a restore with the wrong master.key. */
function breakCa() {
  const ca = getSetting(panel.deps.db, "lbTlsCa");
  if (!ca) throw new Error("no CA yet");
  const other = createSecretBox(crypto.getRandomValues(new Uint8Array(32)));
  setSetting(panel.deps.db, "lbTlsCa", { ...ca, keySealed: other.seal("not this panel's key", "lb.key") });
  setSetting(panel.deps.db, "lbTlsNodes", {});
}

test("a node that cannot get a certificate raises one alert on connect, resolved once one is issued", async () => {
  const first = await joinAgent(panel, url);
  agents.push(first);
  breakCa();
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  // Before: the failure was only a log line (or nothing, when the key did not open) and LB silently stayed off.
  const raised = openAlerts(agent.nodeId);
  expect(raised).toHaveLength(1);
  expect(raised[0]).toMatchObject({ event: "node_health_check_failed", severity: "error" });
  expect(raised[0]?.message).toContain("cannot be opened");
  // Again (the hourly job): still one open alert.
  expect(issueNodeCertificate(panel.deps, agent.nodeId)).toBe(false);
  expect(openAlerts(agent.nodeId)).toHaveLength(1);

  // A new CA (the owner dropped the unreadable one): the certificate is issued and the alert resolved.
  setSetting(panel.deps.db, "lbTlsCa", null as never);
  expect(issueNodeCertificate(panel.deps, agent.nodeId)).toBe(true);
  expect(openAlerts(agent.nodeId)).toHaveLength(0);
  expect(getSetting(panel.deps.db, "lbTlsNodes")?.[agent.nodeId]).toBeDefined();
});
