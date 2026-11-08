// Each node's LB certificate names that node and has a one-off issuer of
// its own, and every node's settings list the current nodes: their agents
// accept only those issuers on the LB entry point and check each peer by
// the name listed for it. Removing a node or giving up a replaced
// certificate takes it out of every node's list; a renewal keeps the old
// one accepted until the node confirmed the new one.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { nodes as nodeOps } from "@seylo/ops";
import type { LoadBalancerTls } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { nodes } from "../src/db/schema";
import { compileDesiredState } from "../src/desired";
import { flusherFor } from "../src/modules/nodes";
import {
  confirmGraceMs,
  confirmNodeCertificate,
  ensureNodeCertificate,
  forgetNodeCertificate,
  lbPeers,
  lbPeersCapability,
  lbServerName,
  nodeLbServerName,
  refreshLbPeers,
} from "../src/modules/nodes/lb-tls";
import { getSetting, setSetting } from "../src/settings";
import { allCapabilities, type FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
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

const newAgent = [...allCapabilities, lbPeersCapability];

async function join(capabilities = newAgent) {
  const agent = await joinAgent(panel, url, { capabilities });
  agents.push(agent);
  return agent;
}

function lbTlsOf(nodeId: string): LoadBalancerTls | undefined {
  return compileDesiredState(panel.deps.db, nodeId, {
    revision: 1n,
    secrets: panel.deps.secrets,
    contributors: panel.deps.agents.desired.contributors(),
  }).settings?.lbTls;
}

/** The lb_tls of the last full desired state the agent got. */
function lastSent(agent: FakeAgent): LoadBalancerTls | undefined {
  return agent.requests<{ state?: { settings?: { lbTls?: LoadBalancerTls } } }>("SyncDesired").at(-1)?.state?.settings?.lbTls;
}

const issuerOf = (certPem: string) => certPem.split(/(?<=-----END CERTIFICATE-----\n)/)[1] ?? "";
const stored = (nodeId: string) => getSetting(panel.deps.db, "lbTlsNodes")?.[nodeId];

test("every node lists the current nodes with their issuers, and goes by its own name once its agent answers it", async () => {
  const a = await join();
  const b = await join();
  const old = await join(allCapabilities); // an agent before 0.2
  // The connect sync confirmed each node's certificate.
  for (const agent of [a, b, old]) expect(stored(agent.nodeId)?.confirmedAt).toBeNumber();

  const tls = lbTlsOf(a.nodeId);
  const peers = new Map(tls?.peers.map((p) => [p.nodeId, p]));
  expect([...peers.keys()].sort()).toEqual([a.nodeId, b.nodeId, old.nodeId].sort());
  for (const agent of [a, b, old]) {
    const peer = peers.get(agent.nodeId);
    expect(peer?.legacy).toBe(false);
    expect(peer?.issuerPems).toEqual([issuerOf(lbTlsOf(agent.nodeId)?.certPem ?? "")]);
    // Right after the confirmation: still the shared name (its Traefik may not have loaded its own yet).
    expect(peer?.serverName).toBe(lbServerName);
  }
  const later = Date.now() + confirmGraceMs + 1000;
  const named = new Map(lbPeers(panel.deps.db, panel.deps.agents, later).map((p) => [p.nodeId, p.serverName]));
  expect(named.get(a.nodeId)).toBe(nodeLbServerName(a.nodeId));
  expect(named.get(b.nodeId)).toBe(nodeLbServerName(b.nodeId));
  // An agent before 0.2 answers only the shared name: by its own it would get Traefik's 421.
  expect(named.get(old.nodeId)).toBe(lbServerName);
});

test("a removed node's certificate leaves every other node's list at once", async () => {
  const owner = await createUser(panel, "owner");
  const a = await join();
  const b = await join();
  const before = a.requests("SyncDesired").length;
  const name = panel.deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, b.nodeId)).get()?.name ?? "";
  const res = await callOp(panel, nodeOps.remove, { nodeId: b.nodeId, confirmName: name }, { cookie: owner.cookie });
  expect(res.status).toBe(200);
  await flusherFor(panel.deps)?.flush();
  // Before: nothing told the other nodes, and they took any certificate of the CA for a year.
  await a.waitFor("SyncDesired", before + 1);
  expect(lastSent(a)?.peers.map((p) => p.nodeId)).toEqual([a.nodeId]);
  expect(stored(b.nodeId)).toBeUndefined();
});

test("a renewal keeps the old certificate accepted until the node confirmed the new one", async () => {
  const a = await join();
  const b = await join();
  const first = stored(a.nodeId);
  const firstIssuer = first?.issuerPem ?? "";
  // 11 days on: under 20 days left, renewed.
  const now = Date.now() + 11 * 86_400_000;
  expect(ensureNodeCertificate(panel.deps, a.nodeId, now)).toBe(true);
  const renewed = stored(a.nodeId);
  expect(renewed?.previous?.certPem).toBe(first?.certPem);
  expect(renewed?.confirmedAt).toBeUndefined();
  const peerA = (at: number) => lbPeers(panel.deps.db, panel.deps.agents, at).find((p) => p.nodeId === a.nodeId);
  expect(peerA(now)?.issuerPems).toEqual([renewed?.issuerPem ?? "", firstIssuer]);
  // The node itself gets both: it presents whichever a peer asks for.
  const mine = lbTlsOf(a.nodeId);
  expect(mine?.previousCertPem).toBe((first?.certPem ?? "") + firstIssuer);
  expect(mine?.previousKeyPem).toContain("PRIVATE KEY");

  // A state with another certificate confirms nothing.
  expect(confirmNodeCertificate(panel.deps, a.nodeId, (first?.certPem ?? "") + firstIssuer)).toBe(false);

  // Every node hears of it: a gets its new certificate, b a's new issuer.
  const before = b.requests("SyncDesired").length;
  expect(refreshLbPeers(panel.deps)).toBe(true);
  expect(refreshLbPeers(panel.deps)).toBe(false); // nothing new
  await flusherFor(panel.deps)?.flush();
  await b.waitFor("SyncDesired", before + 1);
  expect(lastSent(b)?.peers.find((p) => p.nodeId === a.nodeId)?.issuerPems).toContain(renewed?.issuerPem ?? "");
  expect(lastSent(a)?.certPem).toBe(mine?.certPem ?? "");
  // a took that state, which confirms its new certificate.
  const confirmedAt = stored(a.nodeId)?.confirmedAt ?? 0;
  expect(confirmedAt).toBeGreaterThan(0);
  expect(peerA(confirmedAt + confirmGraceMs - 1000)?.issuerPems).toHaveLength(2);
  // After the grace the replaced certificate is no longer accepted, but a still presents it until it
  // expires (a peer cut off from the panel may know only that one).
  expect(peerA(confirmedAt + confirmGraceMs + 1000)?.issuerPems).toEqual([renewed?.issuerPem ?? ""]);
  expect(lbTlsOf(a.nodeId)?.previousCertPem).not.toBe("");
});

test("a node that never got its renewal keeps the certificate it holds as the previous one", async () => {
  const a = await join();
  const held = stored(a.nodeId);
  const now = Date.now() + 11 * 86_400_000;
  ensureNodeCertificate(panel.deps, a.nodeId, now);
  // Renewed again before it confirmed the first renewal (its syncs failed): the one it holds stays.
  const all = getSetting(panel.deps.db, "lbTlsNodes") ?? {};
  const current = all[a.nodeId];
  if (current) all[a.nodeId] = { ...current, notAfter: now + 5 * 86_400_000 };
  setSetting(panel.deps.db, "lbTlsNodes", all);
  expect(ensureNodeCertificate(panel.deps, a.nodeId, now)).toBe(true);
  expect(stored(a.nodeId)?.previous?.certPem).toBe(held?.certPem);
});

test("certificates from before 0.2 are replaced at once, and while a node may hold one every CA certificate is accepted", async () => {
  const a = await join();
  // A node that has not connected since the panel's update still holds one straight from the CA.
  const all = getSetting(panel.deps.db, "lbTlsNodes") ?? {};
  const legacyCert = {
    certPem: all[a.nodeId]?.certPem ?? "",
    keySealed: all[a.nodeId]?.keySealed ?? "",
    notAfter: Date.now() + 25 * 86_400_000,
  };
  setSetting(panel.deps.db, "lbTlsNodes", { ...all, away0000000000000: legacyCert });
  const away = lbPeers(panel.deps.db, panel.deps.agents).find((p) => p.nodeId === "away0000000000000");
  expect(away).toMatchObject({ legacy: true, issuerPems: [], serverName: lbServerName });
  // Once it connects (here: issued again) it gets an issuer of its own, and the CA is accepted
  // only until it confirmed that.
  expect(ensureNodeCertificate(panel.deps, "away0000000000000")).toBe(true);
  const replaced = stored("away0000000000000");
  expect(replaced?.issuerPem).toBeString();
  expect(replaced?.previous?.issuerPem).toBeUndefined();
  const peer = (at: number) => lbPeers(panel.deps.db, panel.deps.agents, at).find((p) => p.nodeId === "away0000000000000");
  expect(peer(Date.now())?.legacy).toBe(true);
  // The legacy one is never presented: peers that ask for its issuer ask for the CA, which the new one also has.
  const chain = (replaced?.certPem ?? "") + (replaced?.issuerPem ?? "");
  expect(confirmNodeCertificate(panel.deps, "away0000000000000", chain)).toBe(true);
  expect(peer(Date.now() + confirmGraceMs + 1000)?.legacy).toBe(false);
  // An expired one is not listed at all.
  forgetNodeCertificate(panel.deps, "away0000000000000");
  setSetting(panel.deps.db, "lbTlsNodes", {
    ...(getSetting(panel.deps.db, "lbTlsNodes") ?? {}),
    gone00000000000000: { ...legacyCert, notAfter: Date.now() - 1000 },
  });
  expect(lbPeers(panel.deps.db, panel.deps.agents).map((p) => p.nodeId)).toEqual([a.nodeId]);
  // The issuer is a CA that signs end entities only.
  expect(new X509Certificate(stored(a.nodeId)?.issuerPem ?? "").ca).toBe(true);
});

test("the hourly job renews connected nodes only, and the others hear of it", async () => {
  const a = await join();
  const b = await join();
  const away = await join();
  await away.close();
  agents.splice(agents.indexOf(away), 1);
  for (let i = 0; i < 200 && panel.deps.agents.isOnline(away.nodeId); i++) await Bun.sleep(5);
  expect(panel.deps.agents.isOnline(away.nodeId)).toBe(false);
  // Ten days left on both: a is due, and so would the one that is away be.
  const all = getSetting(panel.deps.db, "lbTlsNodes") ?? {};
  for (const id of [a.nodeId, away.nodeId]) {
    const cert = all[id];
    if (cert) all[id] = { ...cert, notAfter: Date.now() + 10 * 86_400_000 };
  }
  setSetting(panel.deps.db, "lbTlsNodes", all);
  const awayBefore = stored(away.nodeId);
  const before = b.requests("SyncDesired").length;
  panel.runner.enqueue("nodes.pruneReports", {});
  await panel.runner.runDue(panel.deps);
  await flusherFor(panel.deps)?.flush();
  expect(stored(a.nodeId)?.previous).toBeDefined();
  // Away: it could not get a new one, and peers keep accepting the one it holds.
  expect(stored(away.nodeId)).toEqual(awayBefore);
  await b.waitFor("SyncDesired", before + 1);
  expect(lastSent(b)?.peers.find((p) => p.nodeId === a.nodeId)?.issuerPems).toContain(stored(a.nodeId)?.issuerPem ?? "");
  expect(lastSent(b)?.peers.map((p) => p.nodeId)).toContain(away.nodeId);
});
