// Every node gets a load-balancer certificate from the panel's LB CA in its
// settings, so nodes accept LB traffic only from each other.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { compileDesiredState } from "../src/desired";
import { ensureNodeCertificate, lbServerName } from "../src/modules/nodes/lb-tls";
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
  expect(ensureNodeCertificate(panel.deps, agent.nodeId, Date.now() + 340 * 86_400_000)).toBe(true);
});
