// rc.1 -> rc.2 upgrade: the seed for git servers on the nodes' own addresses
// runs at panel start, before the nodes' rc.2 agents report
// NodeFacts.interface_addresses. A git server on a node's second public
// address was therefore not recorded and kept failing at the node (which
// refuses its own addresses) until an admin allowed it by hand (rc.2
// review). The seed now keeps the nodes it could not see and the hosts it
// saw as public (gitInternalHostsPending); when such a node connects with an
// agent that reports its addresses, those hosts are checked once more and
// recorded for the projects whose source from before the upgrade is still
// on them. Sources saved since are not the seed's to record.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { gitInternalHosts, services } from "../src/db/schema";
import { seedInternalGitHosts } from "../src/modules/git/targets";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { getSetting, setSetting } from "../src/settings";
import { FakeAgent } from "./fake-agent";
import { type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen, seedProject, seedService } from "./hub-helpers";

const NODE_EXTRA = "51.15.20.31";
const NODE_LATER = "51.15.20.32";
let panel: TestPanel;
let url: string;
let lookups: string[];

beforeEach(() => {
  const dns = new Map<string, string[]>([
    ["git2.example.com", [NODE_EXTRA]],
    ["git3.example.com", [NODE_LATER]],
    ["github.com", ["140.82.121.4"]],
  ]);
  lookups = [];
  setTargetResolver(async (host) => {
    lookups.push(host);
    const found = dns.get(host);
    if (!found) throw Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" });
    return found;
  });
  panel = testPanel();
  url = listen(panel);
});
afterEach(async () => {
  setTargetResolver(null);
  if (panel.app.server) await panel.app.stop(true);
  panel.close();
});

const gitSpec = (repo: string) => ({ source: { type: "git", url: repo, branch: "main", credentialId: null, deployOnPush: false } });
const rowsFor = (host: string) => panel.deps.db.select().from(gitInternalHosts).where(eq(gitInternalHosts.host, host)).all();

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

/** The same node connecting again, with another agent version and facts. */
async function reconnect(first: FakeAgent, agentVersion: string, facts: Record<string, unknown>): Promise<FakeAgent> {
  const agent = new FakeAgent({
    url,
    panelId: panel.deps.panelId,
    nodeId: first.nodeId,
    key: first.key,
    agentVersion,
    facts,
    capabilities: [],
  });
  await agent.connect();
  expect(agent.rejected).toBeNull();
  return agent;
}

test("a node's second address, reported after the upgrade, records the hosts of older sources on it once", async () => {
  // The node on its rc.1 agent: no interface addresses on record.
  const old = await joinAgent(panel, url, { agentVersion: "0.2.0-rc.1", capabilities: [] });
  const nodeId = old.nodeId;
  await old.close();
  const shop = seedProject(panel);
  const blog = seedProject(panel);
  // Sources saved under rc.1: a Gitea on the node's second address, in two projects, and github.com.
  seedService(panel, shop.id, nodeId, { spec: gitSpec("https://git2.example.com/me/shop.git") });
  const moved = seedService(panel, blog.id, nodeId, { spec: gitSpec("https://git2.example.com/me/blog.git") });
  seedService(panel, shop.id, nodeId, { spec: gitSpec("https://github.com/me/app.git") });

  // The panel's first start of rc.2 after the V2 seed of rc.1: nothing on the node's addresses yet.
  setSetting(panel.deps.db, "gitInternalHostsSeededV2", true);
  setSetting(panel.deps.db, "gitInternalHostsSeededNodes", false);
  await seedInternalGitHosts(panel.deps.db);
  expect(rowsFor("git2.example.com")).toHaveLength(0);
  // Before: no pending setting, so nothing was ever checked again.
  expect(getSetting(panel.deps.db, "gitInternalHostsPending")).toMatchObject({ nodeIds: [nodeId] });

  // Since then: the blog's source moved to github.com, and a source on another address of the node was saved (it went
  // through the check like any other).
  panel.deps.db
    .update(services)
    .set({ spec: gitSpec("https://github.com/me/blog.git") })
    .where(eq(services.id, moved.id))
    .run();
  seedService(panel, shop.id, nodeId, { spec: gitSpec("https://git3.example.com/me/later.git") });

  // The node connects again, still on rc.1: it stays pending.
  const still = await reconnect(old, "0.2.0-rc.1", {});
  await Bun.sleep(50);
  expect(rowsFor("git2.example.com")).toHaveLength(0);
  expect(getSetting(panel.deps.db, "gitInternalHostsPending")?.nodeIds).toEqual([nodeId]);
  await still.close();

  // Its rc.2 agent reports the addresses on its interfaces.
  const updated = await reconnect(old, "0.2.0-rc.2", { interfaceAddresses: [NODE_EXTRA, NODE_LATER] });
  await until(() => getSetting(panel.deps.db, "gitInternalHostsPending") === undefined);
  expect(rowsFor("git2.example.com")).toMatchObject([{ projectId: shop.id, approvedBy: null }]);
  expect(panel.deps.db.select().from(gitInternalHosts).where(eq(gitInternalHosts.projectId, blog.id)).all()).toHaveLength(0);
  expect(rowsFor("git3.example.com")).toHaveLength(0);
  expect(rowsFor("github.com")).toHaveLength(0);
  await updated.close();
});

test("a node that reports no interface addresses is done without lookups; the setting goes once no node is left", async () => {
  const a = await joinAgent(panel, url, { agentVersion: "0.1.1", capabilities: [] });
  await a.close();
  const shop = seedProject(panel);
  seedService(panel, shop.id, a.nodeId, { spec: gitSpec("https://github.com/me/app.git") });
  // A panel upgraded from 0.1 straight to rc.2: the full seed.
  setSetting(panel.deps.db, "gitInternalHostsSeededV2", false);
  setSetting(panel.deps.db, "gitInternalHostsSeededNodes", false);
  await seedInternalGitHosts(panel.deps.db);
  expect(getSetting(panel.deps.db, "gitInternalHostsPending")).toMatchObject({ nodeIds: [a.nodeId], hosts: [{ host: "github.com" }] });
  lookups.length = 0;
  const updated = await reconnect(a, "0.2.0-rc.2", {});
  await until(() => getSetting(panel.deps.db, "gitInternalHostsPending") === undefined);
  expect(lookups).toEqual([]);
  expect(rowsFor("github.com")).toHaveLength(0);
  await updated.close();
});
