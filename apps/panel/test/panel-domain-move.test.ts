// The moment the panel domain goes live: the domain check job
// asks every node that did not dial the domain to reconnect (so it reads
// panel_url and moves), never the panel node; and the HTTPS probe of a test
// build may trust the e2e's test CA from the data dir, a shipped build never.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askNodesToMove } from "../src/agent-hub/move-target";
import { nodes } from "../src/db/schema";
import type { JobContext } from "../src/jobs/queue";
import { defaultProbes, domainCheckJob, setDomainProbes, testCa, testCaFile } from "../src/modules/settings/domain";
import { issueCertificate, newKeyPair, toPem } from "../src/security/x509";
import { setSetting } from "../src/settings";
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
  setDomainProbes(null);
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

async function closedSoon(agent: FakeAgent): Promise<boolean> {
  for (let i = 0; i < 50 && !agent.closed; i++) await Bun.sleep(10);
  return agent.closed;
}

test("the domain going live asks other nodes to reconnect once, never the panel node", async () => {
  const panelNode = await joinAgent(panel, url);
  const other = await joinAgent(panel, url);
  agents.push(panelNode, other);
  setSetting(panel.deps.db, "panelDomain", "panel.example.com");
  setDomainProbes({ resolve: async () => ["203.0.113.7"], https: async () => true });
  panel.deps.db.update(nodes).set({ publicIpv4: "203.0.113.7" }).run();

  await domainCheckJob.run({}, panel.deps as JobContext);
  expect(await closedSoon(other)).toBe(true);
  expect(panelNode.closed).toBe(false);

  // Already active: the hourly re-check asks nobody again.
  const again = await joinAgent(panel, url, { nodeId: other.nodeId, key: other.key });
  agents.push(again);
  setSetting(panel.deps.db, "panelDomainStatus", {
    domain: "panel.example.com",
    state: "active",
    message: "",
    checkedAt: Date.now() - 2 * 60 * 60 * 1000,
  });
  await domainCheckJob.run({}, panel.deps as JobContext);
  await Bun.sleep(50);
  expect(again.closed).toBe(false);
});

test("nodes that already dialed the domain are left alone", async () => {
  setSetting(panel.deps.db, "panelDomain", "panel.example.com");
  setSetting(panel.deps.db, "panelDomainStatus", { domain: "panel.example.com", state: "active", message: "", checkedAt: Date.now() });
  const reconnected: string[] = [];
  const hosts: Record<string, string> = { a: "panel.example.com", b: "203.0.113.9:3000" };
  for (const id of ["a", "b"]) {
    panel.deps.db
      .insert(nodes)
      .values({ id: id.repeat(16), name: id, publicKey: Buffer.alloc(32, id.charCodeAt(0)) })
      .run();
  }
  const asked = askNodesToMove({
    db: panel.deps.db,
    logger: panel.deps.logger,
    agents: {
      onlineNodeIds: () => ["a".repeat(16), "b".repeat(16)],
      dialedHost: (nodeId) => hosts[nodeId[0] as string] ?? null,
      reconnect: (nodeId) => reconnected.push(nodeId),
    },
  });
  expect(asked).toBe(1);
  expect(reconnected).toEqual(["b".repeat(16)]);
});

test("only a test build trusts the data dir's test CA", () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-test-ca-"));
  try {
    expect(testCa(dir, true)).toBeNull();
    writeFileSync(join(dir, testCaFile), "-----BEGIN CERTIFICATE-----\n");
    expect(testCa(dir, false)).toBeNull();
    expect(testCa(dir, true)).toStartWith("-----BEGIN CERTIFICATE-----");
    // This test run is not a test release build.
    expect(testCa(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the HTTPS probe passes with a private CA only when it is given that CA", async () => {
  const ca = newKeyPair();
  const caCert = toPem(
    issueCertificate({
      commonName: "Test CA",
      publicKey: ca.publicKey,
      issuer: { commonName: "Test CA", privateKey: ca.privateKey },
      ca: true,
      notAfter: new Date(Date.now() + 86_400_000),
    }),
  );
  const leaf = newKeyPair();
  const leafCert = toPem(
    issueCertificate({
      commonName: "localhost",
      publicKey: leaf.publicKey,
      issuer: { commonName: "Test CA", privateKey: ca.privateKey },
      hosts: ["localhost"],
      notAfter: new Date(Date.now() + 86_400_000),
    }),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: leafCert, key: leaf.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    fetch: () => Response.json({ status: "ok" }),
  });
  try {
    const host = `localhost:${server.port}`;
    expect(await defaultProbes.https(host)).toBe(false);
    expect(await defaultProbes.https(host, caCert)).toBe(true);
  } finally {
    server.stop(true);
  }
});
