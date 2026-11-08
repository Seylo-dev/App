// Every node gets a load-balancer certificate from the panel's LB CA in its
// settings, so nodes accept LB traffic only from each other.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { compileDesiredState } from "../src/desired";
import { ensureNodeCertificate, lbServerName } from "../src/modules/nodes/lb-tls";
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

test("a connected node's settings carry its LB certificate, signed by the panel's CA", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  const state = compileDesiredState(panel.deps.db, agent.nodeId, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  });
  const tls = state.settings?.lbTls;
  expect(tls?.serverName).toBe(lbServerName);
  const ca = new X509Certificate(tls?.caPem ?? "");
  const cert = new X509Certificate(tls?.certPem ?? "");
  expect(cert.verify(ca.publicKey)).toBe(true);
  expect(cert.checkHost(lbServerName)).toBe(lbServerName);
  expect(tls?.keyPem).toContain("PRIVATE KEY");
  // Fresh certificates are kept; ones close to expiry are renewed.
  expect(ensureNodeCertificate(panel.deps, agent.nodeId)).toBe(false);
  expect(ensureNodeCertificate(panel.deps, agent.nodeId, Date.now() + 5 * 86_400_000)).toBe(false);
  expect(ensureNodeCertificate(panel.deps, agent.nodeId, Date.now() + 11 * 86_400_000)).toBe(true);
});

test("node certificates live 30 days, so a removed node's stops working soon; longer ones are replaced", async () => {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  const now = Date.now();
  const stored = () => getSetting(panel.deps.db, "lbTlsNodes")?.[agent.nodeId];
  const cert = new X509Certificate(stored()?.certPem ?? "");
  const days = (Date.parse(cert.validTo) - now) / 86_400_000;
  // Before: 365 days, and nothing revokes what a removed node keeps.
  expect(days).toBeGreaterThan(29);
  expect(days).toBeLessThanOrEqual(30);
  // A certificate from before (365 days) is replaced by a 30-day one.
  const all = getSetting(panel.deps.db, "lbTlsNodes") ?? {};
  setSetting(panel.deps.db, "lbTlsNodes", {
    ...all,
    [agent.nodeId]: { ...(stored() as NonNullable<ReturnType<typeof stored>>), notAfter: now + 300 * 86_400_000 },
  });
  expect(ensureNodeCertificate(panel.deps, agent.nodeId, now)).toBe(true);
  expect(stored()?.notAfter).toBeLessThanOrEqual(now + 30 * 86_400_000);
});
