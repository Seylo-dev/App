// The uptime checker's "own node" exception: an address that is not public
// is allowed only when it is a node's address as an admin set it. What an
// agent reports about itself (nodes.public_ipv4/public_ipv6, from its facts)
// never opens the panel's private network: a compromised agent could report
// 10.0.0.5 as its public address and let members probe the panel's LAN.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { nodes } from "../src/db/schema";
import { checkTarget, setTargetResolver } from "../src/modules/uptime/targets";
import { setSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ modules: [] });
  setSetting(panel.deps.db, "uptimeAllowInternalTargets", false);
  setTargetResolver(async (host) => ({ "lan.example.com": ["10.0.0.5"], "node.example.com": ["203.0.113.7"] })[host] ?? []);
});
afterEach(() => {
  setTargetResolver(null);
  panel.close();
});

const node = (values: Partial<typeof nodes.$inferInsert>) =>
  panel.deps.db
    .insert(nodes)
    .values({ name: `n-${crypto.randomUUID().slice(0, 6)}`, publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), ...values })
    .returning()
    .get();

test("a private address an agent reports as its public one does not make it a target", async () => {
  node({ publicIpv4: "10.0.0.5", publicIpv6: "fd00::5" });
  // Before: both were allowed.
  expect(await checkTarget(panel.deps, "http://10.0.0.5/")).toMatchObject({ ok: false, reason: "private" });
  expect(await checkTarget(panel.deps, "http://lan.example.com/")).toMatchObject({ ok: false, reason: "private" });
  expect(await checkTarget(panel.deps, "http://[fd00::5]/")).toMatchObject({ ok: false, reason: "private" });
});

test("the address an admin set for a node is allowed; a public reported address passes as public", async () => {
  const row = node({ publicIpv4: "203.0.113.7" });
  expect(await checkTarget(panel.deps, "http://node.example.com/")).toEqual({ ok: true, address: "203.0.113.7", byName: false });
  panel.deps.db.update(nodes).set({ publicAddress: "10.0.0.5" }).where(eq(nodes.id, row.id)).run();
  expect(await checkTarget(panel.deps, "http://10.0.0.5:8080/")).toEqual({ ok: true, address: "10.0.0.5", byName: false });
  expect(await checkTarget(panel.deps, "http://lan.example.com/")).toEqual({ ok: true, address: "10.0.0.5", byName: false });
  // Metadata stays refused even as a node's address.
  panel.deps.db.update(nodes).set({ publicAddress: "169.254.169.254" }).where(eq(nodes.id, row.id)).run();
  expect((await checkTarget(panel.deps, "http://169.254.169.254/")).ok).toBe(false);
});
