// A git server on one of the panel's nodes, reached by its public name (a
// Gitea service on a single-node VPS install: git.example.com -> the node's
// eth0 address). Nodes refuse their own addresses for git unless the host is
// allowed (netguard), so the panel counts a host whose every address is a
// node's (the admin-set public address, or what agents report: public_ipv4/
// public_ipv6 and NodeFacts.interface_addresses) as internal: an admin's
// save records it, members get the usual refusal until then, provider
// connections on it get the allowance and the first-start seed records such
// sources. Before, the panel saw the host as public: nothing was recorded,
// builds went out with allowInternalHost=false and the node refused them
// (round 3 regression of 835d106).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { git as gitOps, projects, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { gitInternalHosts, gitProviders, nodes, services } from "../src/db/schema";
import { resolveBuild } from "../src/modules/deployments/source";
import { providerGitVerdict, seedInternalGitHosts } from "../src/modules/git/targets";
import { loadService } from "../src/modules/services/rows";
import { readSpec } from "../src/modules/services/spec";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { getSetting, setSetting } from "../src/settings";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

const NODE_PUBLIC = "51.15.20.30";
const NODE_EXTRA = "51.15.20.31";
let panel: TestPanel;
let fleet: FakeFleet;
let owner: string;
let ownerName: string;
let member: string;
let projectId: string;
let nodeA: string;
const dns = new Map<string, string[]>();

beforeEach(async () => {
  dns.clear();
  dns.set("git.example.com", [NODE_PUBLIC]);
  dns.set("git2.example.com", [NODE_EXTRA]);
  dns.set("v6.example.com", [NODE_PUBLIC, "2a01:4f8::7"]);
  dns.set("mixed.example.com", [NODE_PUBLIC, "93.184.216.34"]);
  dns.set("gitea.lan", ["10.0.0.7"]);
  dns.set("github.com", ["140.82.121.4"]);
  setTargetResolver(async (host) => {
    const found = dns.get(host);
    if (!found) throw Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" });
    return found;
  });
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a", { canBuild: true, panelNode: true });
  // The admin set the node's public address at install (the single-node install does); the agent
  // reports a second address on its interfaces and an IPv6 one.
  panel.deps.db
    .update(nodes)
    .set({ publicAddress: NODE_PUBLIC, facts: { interfaceAddresses: [NODE_EXTRA, "2a01:4f8::7"] } })
    .where(eq(nodes.id, nodeA))
    .run();
  const o = await createUser(panel, "owner");
  owner = o.cookie;
  ownerName = o.user.name;
  const m = await createUser(panel, "member");
  member = m.cookie;
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie: owner })).body.id;
  grant(panel, m.user.id, "project", projectId, ["services.create", "services.view", "services.update"]);
});
afterEach(() => {
  setTargetResolver(null);
  panel.close();
});

const gitService = (url: string, name: string) => ({
  projectId,
  name,
  kind: "app" as const,
  nodeId: nodeA,
  source: { type: "git" as const, url, branch: "main", credentialId: null, deployOnPush: false },
});

async function built(serviceId: string) {
  const service = loadService(panel.deps.db, serviceId);
  const resolved = await resolveBuild(panel.deps, {
    service,
    spec: readSpec(service.spec),
    buildId: "b1",
    generation: 1,
    commitSha: "a".repeat(40),
    uploadId: null,
  });
  const git = resolved.request.source?.source;
  if (git?.case !== "git") throw new Error("not a git build");
  return git.value;
}
const rowsFor = (host: string) => panel.deps.db.select().from(gitInternalHosts).where(eq(gitInternalHosts.host, host)).all();

test("an admin's save of a git server on a node's own public address allows it; a member's is refused until then", async () => {
  // A member first: refused, and the error names the host an admin can allow. Before: 200.
  const early = await callOp(panel, serviceOps.create, gitService("https://git.example.com/me/early.git", "early"), { cookie: member });
  expect(early.status).toBe(400);
  expect(early.body.error.details).toMatchObject({ reason: "internalTarget", host: "git.example.com" });
  expect(early.body.error.message).toContain("an address of one of this panel's nodes (51.15.20.30)");
  // Checking access is refused the same way.
  const check = await callOp(panel, gitOps.branches, { projectId, url: "https://git.example.com/me/early.git" }, { cookie: member });
  expect(check.status).toBe(400);
  expect(check.body.error.details).toMatchObject({ reason: "internalTarget", host: "git.example.com" });

  // The admin's save records the host. Before: no row, allowInternalHost false (the node refused).
  const svc = await callOp(panel, serviceOps.create, gitService("https://git.example.com/me/app.git", "app"), { cookie: owner });
  expect(svc.status).toBe(200);
  expect(rowsFor("git.example.com")).toHaveLength(1);
  expect((await built(svc.body.id)).allowInternalHost).toBe(true);
  // Then the project's members may use it.
  const mine = await callOp(panel, serviceOps.create, gitService("https://git.example.com/me/other.git", "mine"), { cookie: member });
  expect(mine.status).toBe(200);
  expect((await built(mine.body.id)).allowInternalHost).toBe(true);
});

test("addresses agents report count as the node's, and so does its admin-set host name", async () => {
  // NodeFacts.interface_addresses (a second address on the node), all of a name's addresses.
  for (const [host, name] of [
    ["git2.example.com", "two"],
    ["v6.example.com", "v6"],
  ]) {
    const r = await callOp(panel, serviceOps.create, gitService(`https://${host}/a.git`, name as string), { cookie: member });
    expect(r.status).toBe(400);
    expect(r.body.error.details.host).toBe(host);
  }
  // A name that also points somewhere else is public at the panel (the node refuses its own address, then dials the other).
  const mixed = await callOp(panel, serviceOps.create, gitService("https://mixed.example.com/a.git", "mixed"), { cookie: member });
  expect(mixed.status).toBe(200);
  expect((await built(mixed.body.id)).allowInternalHost).toBe(false);
  // The admin-set public address may be a host name.
  panel.deps.db.update(nodes).set({ publicAddress: "node-a.example.net" }).where(eq(nodes.id, nodeA)).run();
  dns.set("node-a.example.net", ["93.184.216.99"]);
  const byName = await callOp(panel, serviceOps.create, gitService("https://node-a.example.net:3000/a.git", "named"), { cookie: member });
  expect(byName.status).toBe(400);
  expect(byName.body.error.details.host).toBe("node-a.example.net:3000");
  // github.com stays public.
  expect((await callOp(panel, serviceOps.create, gitService("https://github.com/a/b.git", "gh"), { cookie: member })).status).toBe(200);
});

test("a git provider connection on a node's address gets the allowance", async () => {
  // Before: false, so a Gitea on the node connected as a provider stopped building.
  expect((await providerGitVerdict(panel.deps.db, { projectId, url: "https://git.example.com/me/app.git" })).allowInternalHost).toBe(true);
  expect((await providerGitVerdict(panel.deps.db, { projectId, url: "https://github.com/me/app.git" })).allowInternalHost).toBe(false);
});

test("the first-start seed records sources on the nodes' addresses; after an earlier seed only those", async () => {
  // Saved before the check existed (or under 0.2.0-rc.1, where the node did not refuse its own address).
  const onNode = await callOp(panel, serviceOps.create, gitService("https://git.example.com/me/app.git", "app"), { cookie: owner });
  const lan = await callOp(panel, serviceOps.create, gitService("https://gitea.lan/me/lan.git", "lan"), { cookie: owner });
  expect([onNode.status, lan.status]).toEqual([200, 200]);

  // A panel upgraded from 0.1: the full seed records both.
  panel.deps.db.delete(gitInternalHosts).run();
  setSetting(panel.deps.db, "gitInternalHostsSeededV2", false);
  setSetting(panel.deps.db, "gitInternalHostsSeededNodes", false);
  const infos: unknown[] = [];
  await seedInternalGitHosts(panel.deps.db, { info: (f: unknown) => infos.push(f), warn: () => {}, error: () => {} } as never);
  expect(rowsFor("git.example.com")).toMatchObject([{ projectId, approvedBy: null }]);
  expect(rowsFor("gitea.lan")).toHaveLength(1);
  expect(infos).toContainEqual({ hosts: ["git.example.com"] });
  expect(getSetting(panel.deps.db, "gitInternalHostsSeededNodes")).toBe(true);

  // A panel that ran the V2 seed under rc.1: once more, for the nodes' own addresses only (other
  // internal hosts went through the check since). Before: never, so git.example.com stopped building.
  panel.deps.db.delete(gitInternalHosts).run();
  setSetting(panel.deps.db, "gitInternalHostsSeededNodes", false);
  await seedInternalGitHosts(panel.deps.db);
  expect(rowsFor("git.example.com")).toHaveLength(1);
  expect(rowsFor("gitea.lan")).toHaveLength(0);
  expect((await built(onNode.body.id)).allowInternalHost).toBe(true);
  // Once.
  panel.deps.db.delete(gitInternalHosts).run();
  await seedInternalGitHosts(panel.deps.db);
  expect(rowsFor("git.example.com")).toHaveLength(0);
});

test("admins list a project's internal git hosts and take one off", async () => {
  const svc = await callOp(panel, serviceOps.create, gitService("https://git.example.com/me/app.git", "app"), { cookie: owner });
  expect(svc.status).toBe(200);
  expect(
    (await callOp(panel, gitOps.allowInternalHost, { projectId, url: "https://gitea.lan:3000/x.git" }, { cookie: owner })).status,
  ).toBe(200);
  const mine = await callOp(panel, serviceOps.create, gitService("https://git.example.com/me/other.git", "mine"), { cookie: member });
  expect(mine.status).toBe(200);

  const list = await callOp(panel, gitOps.listInternalHosts, { projectId }, { cookie: owner });
  expect(list.status).toBe(200);
  expect(list.body.items).toMatchObject([
    { host: "git.example.com", approvedBy: { name: ownerName }, usedBy: 2 },
    { host: "gitea.lan:3000", approvedBy: { name: ownerName }, usedBy: 0 },
  ]);
  // Members neither see nor change the list.
  expect((await callOp(panel, gitOps.listInternalHosts, { projectId }, { cookie: member })).status).toBe(403);
  expect((await callOp(panel, gitOps.removeInternalHost, { projectId, host: "git.example.com" }, { cookie: member })).status).toBe(403);

  // Taken off: the member's source no longer builds, until an admin allows the host again.
  expect((await callOp(panel, gitOps.removeInternalHost, { projectId, host: "Git.Example.com" }, { cookie: owner })).status).toBe(200);
  expect(rowsFor("git.example.com")).toHaveLength(0);
  await expect(built(mine.body.id)).rejects.toThrow("Only an admin can use an internal git host");
  const again = await callOp(panel, gitOps.removeInternalHost, { projectId, host: "git.example.com" }, { cookie: owner });
  expect(again.status).toBe(404);
  expect((await callOp(panel, gitOps.listInternalHosts, { projectId: "0000000000000000" }, { cookie: owner })).status).toBe(404);
});

test("GitHub and git provider sources count toward the hosts they clone from", async () => {
  const { db, secrets } = panel.deps;
  const gitlab = db
    .insert(gitProviders)
    .values({ kind: "gitlab", name: "Corp GitLab", url: "https://GitLab.corp.example:8443", tokenSealed: secrets.seal("t", "git.provider") })
    .returning()
    .get();
  const source = (name: string, spec: unknown) =>
    db.insert(services).values({ projectId, name, nameKey: name, kind: "app", spec }).run();
  source("from-github", { source: { type: "github", installationId: "i1", repo: "acme/shop", branch: "main", deployOnPush: true } });
  source("from-gitlab", {
    source: { type: "provider", providerId: gitlab.id, provider: "gitlab", repo: "acme/shop", branch: "main", deployOnPush: true },
  });
  source("from-gitlab-2", {
    source: { type: "provider", providerId: gitlab.id, provider: "gitlab", repo: "acme/api", branch: "main", deployOnPush: true },
  });
  // What "Allow this host" under a failed deployment of those sources records.
  for (const url of ["https://github.com/", "https://gitlab.corp.example:8443/"])
    expect((await callOp(panel, gitOps.allowInternalHost, { projectId, url }, { cookie: owner })).status).toBe(200);

  const list = await callOp(panel, gitOps.listInternalHosts, { projectId }, { cookie: owner });
  expect(list.status).toBe(200);
  const usedBy = Object.fromEntries(list.body.items.map((h) => [h.host, h.usedBy]));
  // Taking either off changes their builds (gitHostRecorded, providerGitVerdict), so the list must not call them unused.
  expect(usedBy).toEqual({ "github.com": 1, "gitlab.corp.example:8443": 2 });
});
