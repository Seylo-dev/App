// On clouds with 1:1 NAT (AWS, GCP, Azure, Oracle) a node only sees its
// private address and the panel node joins over loopback, so nothing told
// the panel its public one. nodes.publicAddress is the owner's override,
// preferred everywhere an address is handed out, never overwritten by a
// connect, and seeded for the panel node from where the owner opened the
// setup link.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodes as nodeOps, setup } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { issueSetupToken } from "../src/auth/setup-token";
import { nodes } from "../src/db/schema";
import { exposedAddress, type loadDatabase } from "../src/modules/databases/info";
import { nodeHost, placedNode } from "../src/modules/domains/lookup";
import { seedPanelNodeAddress, setupHostOf } from "../src/modules/nodes/address";
import { panelUrl } from "../src/modules/nodes/join-target";
import { addressCheck, checkPublicAddress } from "../src/modules/nodes/ops";
import { panelPublicUrl } from "../src/modules/settings/public-url";
import { getSetting, setSetting } from "../src/settings";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { noLimits } from "./people-helpers";

let panel: TestPanel;
let dataDir: string;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
  dataDir = mkdtempSync(join(tmpdir(), "seylo-public-address-"));
  (panel.deps.config as { dataDir: string }).dataDir = dataDir;
});
afterEach(() => {
  panel.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function panelNode(values: Partial<typeof nodes.$inferInsert> = {}) {
  return panel.deps.db
    .insert(nodes)
    .values({ name: "aws-1", publicKey: Buffer.alloc(32, 3), isPanelNode: true, facts: { privateIpv4: "10.0.1.5" }, ...values })
    .returning()
    .get();
}

test("the owner's address wins over detected and private addresses", async () => {
  const { cookie } = await createUser(panel, "owner");
  const node = panelNode();
  const { db, config } = panel.deps;
  const port = config.hostPort ?? config.port;
  expect(panelUrl({ db, config })).toBe(`http://10.0.1.5:${port}`);

  const saved = await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, publicAddress: " 54.12.0.9 " }, { cookie });
  expect(saved.status).toBe(200);
  expect(saved.body.publicAddress).toBe("54.12.0.9");
  const row = db.select().from(nodes).where(eq(nodes.id, node.id)).get();
  if (!row) throw new Error("no node");
  expect(nodeHost(placedNode(row))).toBe("54.12.0.9");
  expect(panelUrl({ db, config, origin: "http://192.168.1.5:3000" })).toBe(`http://54.12.0.9:${port}`);
  expect(panelPublicUrl({ db, config })).toBe(`http://54.12.0.9:${port}`);

  // IPv6 goes in brackets, names as they are; a connect never overwrites it.
  await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, publicAddress: "2600:1f18::9" }, { cookie });
  db.update(nodes).set({ publicIpv4: "198.51.100.1" }).where(eq(nodes.id, node.id)).run();
  expect(panelUrl({ db, config })).toBe(`http://[2600:1f18::9]:${port}`);
  await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, publicAddress: "node1.example.com" }, { cookie });
  expect(panelUrl({ db, config })).toBe(`http://node1.example.com:${port}`);
  // Null goes back to the detected address.
  await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, publicAddress: null }, { cookie });
  expect(panelUrl({ db, config })).toBe(`http://198.51.100.1:${port}`);

  for (const bad of ["127.0.0.1", "::1", "0.0.0.0", "localhost", "1.2.3.4:80", "a b", "http://x.example.com"]) {
    const res = await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, publicAddress: bad }, { cookie });
    expect([bad, res.status]).toEqual([bad, 400]);
  }
  expect(checkPublicAddress("[2001:db8::1]")).toBe("2001:db8::1");
  expect(checkPublicAddress("")).toBeNull();

  // Members cannot change it.
  const member = await createUser(panel, "member");
  expect(
    (await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, publicAddress: "1.1.1.1" }, { cookie: member.cookie })).status,
  ).toBe(403);
});

test("exposed databases use it (load balancing: desired-compile.test.ts)", () => {
  const placed = placedNode(panelNode({ publicAddress: "54.12.0.9" }));
  const info = (tlsHostname: string | null) =>
    ({ row: { tlsHostname }, node: placed, exposure: { listenPort: 15432 } }) as unknown as ReturnType<typeof loadDatabase>;
  expect(exposedAddress(info(null))).toEqual({ host: "54.12.0.9", port: 15432 });
  expect(exposedAddress(info("db.example.com"))).toEqual({ host: "db.example.com", port: 15432 });
});

test("the panel node is seeded from the setup link's host once, unless it knows a public address", async () => {
  const node = panelNode();
  const { token } = issueSetupToken(panel.deps.db);
  const created = await callOp(
    panel,
    setup.createOwner,
    { token, email: "o@example.com", password: "correct horse battery" },
    { headers: { host: "54.12.0.9:3000" } },
  );
  expect(created.status).toBe(200);
  expect(panel.deps.db.select().from(nodes).where(eq(nodes.id, node.id)).get()?.publicAddress).toBe("54.12.0.9");
  expect(getSetting(panel.deps.db, "panelSetupHost")).toBe("");
  // Once: clearing it later is not undone by the next connect.
  panel.deps.db.update(nodes).set({ publicAddress: null }).where(eq(nodes.id, node.id)).run();
  expect(seedPanelNodeAddress(panel.deps.db)).toBe(false);

  expect(setupHostOf("http://127.0.0.1:3000")).toBeNull();
  expect(setupHostOf("http://localhost:3000")).toBeNull();
  expect(setupHostOf("http://[2600:1f18::9]:3000")).toBe("2600:1f18::9");
});

test("a node with a public IPv4 is not seeded; one that joins after setup is", () => {
  const { db } = panel.deps;
  setSetting(db, "panelSetupHost", "54.12.0.9");
  // Setup before the panel node joined: kept for later.
  expect(seedPanelNodeAddress(db)).toBe(false);
  expect(getSetting(db, "panelSetupHost")).toBe("54.12.0.9");
  const node = panelNode({ publicIpv4: "198.51.100.4" });
  expect(seedPanelNodeAddress(db)).toBe(false);
  expect(db.select().from(nodes).where(eq(nodes.id, node.id)).get()?.publicAddress).toBeNull();
});

test("the health check warns when no public address is known", () => {
  expect(addressCheck({ publicAddress: null, publicIpv4: null, publicIpv6: null, facts: { privateIpv4: "10.0.1.5" } })).toMatchObject({
    id: "network.publicAddress",
    status: "warn",
  });
  expect(addressCheck({ publicAddress: "54.12.0.9", publicIpv4: null, publicIpv6: null, facts: null }).status).toBe("pass");
  expect(addressCheck({ publicAddress: null, publicIpv4: "198.51.100.4", publicIpv6: null, facts: null }).status).toBe("pass");
});

test("a domain's DNS check expects the owner's address when it is an IP", async () => {
  const { checkHost } = await import("../src/modules/domains/dns");
  const dns = {
    resolve4: async () => ["54.12.0.9"],
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveNs: async () => [],
  };
  const result = await checkHost("shop.example.com", [{ ipv4: null, ipv6: null, publicAddress: "54.12.0.9" }], dns);
  expect(result.status).toBe("ok");
  expect(result.expected).toEqual([expect.objectContaining({ type: "A", value: "54.12.0.9" })]);
});
