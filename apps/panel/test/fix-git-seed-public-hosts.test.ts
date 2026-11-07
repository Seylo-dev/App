// agentio-2, review round 2. Two ways allow_internal_host still went to a
// node for the wrong host, or could not go to it for the right one:
//
// - The first-start seed recorded every host of a git source saved before
//   0.2 as an approved internal host, public ones included. A member who had
//   saved a source on a name they control got allow_internal_host=true for
//   it, so after rebinding the name (public at the panel, internal at the
//   node) the node accepted the internal address. The seed now records only
//   hosts the panel resolves to internal addresses, or internal IP addresses.
//   Round 3: names the panel could not resolve were still recorded (a
//   member's own name, NXDOMAIN at the first start, pointed at 10.x
//   afterwards), and panels that ran the first features-1 seed kept its rows.
// - An admin could not allow a split-horizon git host (public at the panel,
//   internal at the nodes): saving the source records a host only when the
//   panel sees it as internal. git.allowInternalHost records it explicitly.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { git as gitOps, projects, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { gitInternalHosts } from "../src/db/schema";
import { resolveBuild } from "../src/modules/deployments/source";
import { seedInternalGitHosts } from "../src/modules/git/targets";
import { loadService } from "../src/modules/services/rows";
import { readSpec } from "../src/modules/services/spec";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { deleteSetting, getSetting, setSetting } from "../src/settings";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let owner: string;
let member: string;
let projectId: string;
let nodeA: string;
/** The panel's DNS. A host maps to addresses, or to an error code the lookup fails with. */
const dns = new Map<string, string[] | { code: string }>();
/** Lookups held until released, to see what waits for the seed. */
const held = new Map<string, () => void>();

beforeEach(async () => {
  dns.clear();
  held.clear();
  dns.set("git.member.example", ["93.184.216.34"]);
  dns.set("gitea.lan", ["10.0.0.7"]);
  dns.set("gitea.corp.example", ["93.184.216.50"]);
  setTargetResolver(async (host) => {
    const hold = held.get(host);
    if (hold) await new Promise<void>((release) => held.set(host, release));
    const found = dns.get(host);
    if (!found) throw Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" });
    if (!Array.isArray(found)) throw Object.assign(new Error(found.code), { code: found.code });
    return found;
  });
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a", { canBuild: true });
  ({ cookie: owner } = await createUser(panel, "owner"));
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

/** Sources as a pre-0.2 panel stored them: no git_internal_hosts rows, and neither seed run yet. */
function asBeforeTheUpgrade() {
  panel.deps.db.delete(gitInternalHosts).run();
  deleteSetting(panel.deps.db, "gitInternalHostsSeeded");
  setSetting(panel.deps.db, "gitInternalHostsSeededV2", false);
}

test("the seed does not turn a member's public host into an approved internal host", async () => {
  // Before the upgrade: a member saved a source on a public host they control.
  const svc = await callOp(panel, serviceOps.create, gitService("https://git.member.example/x.git", "mine"), { cookie: member });
  expect(svc.status).toBe(200);
  asBeforeTheUpgrade();

  // The upgrade's first start seeds the table from stored sources.
  await seedInternalGitHosts(panel.deps.db);
  // Before: one row (project, git.member.example, approvedBy null).
  expect(rowsFor("git.member.example")).toHaveLength(0);
  expect(getSetting(panel.deps.db, "gitInternalHostsSeededV2")).toBe(true);

  // The member rebinds the name for the node (the panel still sees the public address):
  // the node is not told to accept an internal one. Before: allowInternalHost true.
  expect((await built(svc.body.id)).allowInternalHost).toBe(false);
  // And when the panel sees the internal address too, the build is refused before it goes out.
  dns.set("git.member.example", ["10.0.0.7"]);
  await expect(built(svc.body.id)).rejects.toThrow("Only an admin can use an internal git host");
});

test("the seed keeps internal hosts and internal IP addresses, and skips names the panel cannot resolve", async () => {
  const lan = await callOp(panel, serviceOps.create, gitService("https://gitea.lan/a.git", "lan"), { cookie: owner });
  const ip = await callOp(panel, serviceOps.create, gitService("ssh://git@10.0.0.9:2222/b.git", "ip"), { cookie: owner });
  dns.set("git.home.arpa", ["10.0.0.8"]);
  const lanOnly = await callOp(panel, serviceOps.create, gitService("https://git.home.arpa/c.git", "lan-only"), { cookie: owner });
  dns.set("flaky.example", ["93.184.216.60"]);
  const flaky = await callOp(panel, serviceOps.create, gitService("https://flaky.example/d.git", "flaky"), { cookie: member });
  for (const r of [lan, ip, lanOnly, flaky]) expect(r.status).toBe(200);
  asBeforeTheUpgrade();

  // At the first start one name does not exist in the panel's DNS, and the other lookup times out.
  dns.delete("git.home.arpa");
  dns.set("flaky.example", { code: "ETIMEOUT" });
  const warnings: unknown[] = [];
  await seedInternalGitHosts(panel.deps.db, { info: () => {}, warn: (fields: unknown) => warnings.push(fields), error: () => {} } as never);

  expect(rowsFor("gitea.lan")).toMatchObject([{ projectId, approvedBy: null }]);
  expect(rowsFor("10.0.0.9:2222")).toHaveLength(1);
  // Neither says where the name points: not recorded, one warning each. Before: git.home.arpa was recorded.
  expect(rowsFor("git.home.arpa")).toHaveLength(0);
  expect(rowsFor("flaky.example")).toHaveLength(0);
  expect(warnings).toEqual([
    { host: "git.home.arpa", projectIds: [projectId], notFound: true },
    { host: "flaky.example", projectIds: [projectId], notFound: false },
  ]);

  expect((await built(lan.body.id)).allowInternalHost).toBe(true);
  expect((await built(ip.body.id)).allowInternalHost).toBe(true);
  // A LAN-only name the panel could not resolve needs an admin now.
  dns.set("git.home.arpa", ["10.0.0.8"]);
  await expect(built(lanOnly.body.id)).rejects.toThrow("Only an admin can use an internal git host");
  expect((await callOp(panel, gitOps.allowInternalHost, { projectId, url: "https://git.home.arpa/c.git" }, { cookie: owner })).status).toBe(
    200,
  );
  expect((await built(lanOnly.body.id)).allowInternalHost).toBe(true);
});

// The reviewer's PoC: a member's name answers NXDOMAIN at the first 0.2 start (their own zone, or an
// empty one), and points at an internal address afterwards.
test("a member's name that does not resolve at the seed gets no internal access later", async () => {
  const svc = await callOp(panel, serviceOps.create, gitService("https://git.member.example/x.git", "mine"), { cookie: member });
  expect(svc.status).toBe(200);
  asBeforeTheUpgrade();
  dns.delete("git.member.example");
  await seedInternalGitHosts(panel.deps.db);
  // Before: (project, git.member.example, approvedBy null).
  expect(rowsFor("git.member.example")).toHaveLength(0);
  dns.set("git.member.example", ["10.0.0.7"]);
  // Before: the build went out with allowInternalHost true.
  await expect(built(svc.body.id)).rejects.toThrow("Only an admin can use an internal git host");
  dns.set("git.member.example", ["127.0.0.1"]);
  await expect(built(svc.body.id)).rejects.toThrow("Only an admin can use an internal git host");
});

// A panel that ran the first features-1 seed recorded every host, public ones too, under the old
// setting key: the current seed never ran there. Its unapproved rows are dropped once, then it runs.
test("rows the first features-1 seed recorded are dropped once and the hosts seeded again", async () => {
  const pub = await callOp(panel, serviceOps.create, gitService("https://git.member.example/x.git", "mine"), { cookie: member });
  const lan = await callOp(panel, serviceOps.create, gitService("https://gitea.lan/a.git", "lan"), { cookie: owner });
  for (const r of [pub, lan]) expect(r.status).toBe(200);
  const admin = rowsFor("gitea.lan")[0]?.approvedBy;
  expect(admin).toBeTruthy();
  // As that seed left the panel: every host recorded with approvedBy null, the old key set, no new one.
  panel.deps.db.delete(gitInternalHosts).run();
  panel.deps.db
    .insert(gitInternalHosts)
    .values([
      { projectId, host: "git.member.example", approvedBy: null },
      { projectId, host: "gitea.lan", approvedBy: null },
      // An admin's own approval since then stays.
      { projectId, host: "gitea.corp.example", approvedBy: admin },
    ])
    .run();
  setSetting(panel.deps.db, "gitInternalHostsSeeded", true);
  deleteSetting(panel.deps.db, "gitInternalHostsSeededV2");

  const infos: unknown[] = [];
  await seedInternalGitHosts(panel.deps.db, { info: (fields: unknown) => infos.push(fields), warn: () => {}, error: () => {} } as never);
  expect(infos).toEqual([{ removed: 2 }]);
  // Before: the seed returned at once and git.member.example kept its row.
  expect(rowsFor("git.member.example")).toHaveLength(0);
  expect(rowsFor("gitea.lan")).toMatchObject([{ approvedBy: null }]);
  expect(rowsFor("gitea.corp.example")).toMatchObject([{ approvedBy: admin }]);
  expect(getSetting(panel.deps.db, "gitInternalHostsSeeded")).toBeUndefined();
  expect(getSetting(panel.deps.db, "gitInternalHostsSeededV2")).toBe(true);
  // The member's public host goes out without the allowance. Before: true.
  expect((await built(pub.body.id)).allowInternalHost).toBe(false);
  expect((await built(lan.body.id)).allowInternalHost).toBe(true);

  // Only once.
  panel.deps.db.insert(gitInternalHosts).values({ projectId, host: "git.member.example", approvedBy: null }).run();
  await seedInternalGitHosts(panel.deps.db);
  expect(rowsFor("git.member.example")).toHaveLength(1);
});

test("builds wait for the seed, and the setting is written only once it is done", async () => {
  const lan = await callOp(panel, serviceOps.create, gitService("https://gitea.lan/a.git", "lan"), { cookie: owner });
  expect(lan.status).toBe(200);
  asBeforeTheUpgrade();

  held.set("gitea.lan", () => {});
  const seed = seedInternalGitHosts(panel.deps.db);
  // A build dispatched now (the panel just started) must not be refused for a host the seed is about to record.
  const build = built(lan.body.id);
  await Bun.sleep(20);
  expect(getSetting(panel.deps.db, "gitInternalHostsSeededV2")).toBe(false);
  (held.get("gitea.lan") as () => void)();
  held.delete("gitea.lan");
  await seed;
  expect(getSetting(panel.deps.db, "gitInternalHostsSeededV2")).toBe(true);
  expect((await build).allowInternalHost).toBe(true);
});

test("git.allowInternalHost lets an admin allow a host that is public at the panel", async () => {
  // gitea.corp.example answers the panel with a public address and the nodes with a LAN one.
  const saved = await callOp(panel, serviceOps.create, gitService("https://gitea.corp.example/app.git", "corp"), { cookie: owner });
  expect(saved.status).toBe(200);
  // Saving as an admin records nothing (the panel sees a public address), so the node would refuse the LAN one.
  expect(rowsFor("gitea.corp.example")).toHaveLength(0);
  expect((await built(saved.body.id)).allowInternalHost).toBe(false);

  // Members cannot allow hosts.
  const byMember = await callOp(
    panel,
    gitOps.allowInternalHost,
    { projectId, url: "https://gitea.corp.example/app.git" },
    { cookie: member },
  );
  expect(byMember.status).toBe(403);
  expect(rowsFor("gitea.corp.example")).toHaveLength(0);

  const res = await callOp(panel, gitOps.allowInternalHost, { projectId, url: "https://gitea.corp.example/app.git" }, { cookie: owner });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ host: "gitea.corp.example" });
  // Before: there was no way to get here; now the node accepts the LAN address for this host.
  expect((await built(saved.body.id)).allowInternalHost).toBe(true);
  // The project's members may use it too.
  const mine = await callOp(panel, serviceOps.create, gitService("https://gitea.corp.example/other.git", "member-corp"), {
    cookie: member,
  });
  expect(mine.status).toBe(200);
  expect((await built(mine.body.id)).allowInternalHost).toBe(true);
  // Again is fine (one row); the port is part of the host.
  expect(
    (await callOp(panel, gitOps.allowInternalHost, { projectId, url: "https://gitea.corp.example/x.git" }, { cookie: owner })).status,
  ).toBe(200);
  expect(rowsFor("gitea.corp.example")).toHaveLength(1);
  const ssh = await callOp(
    panel,
    gitOps.allowInternalHost,
    { projectId, url: "ssh://git@gitea.corp.example:2222/app.git" },
    { cookie: owner },
  );
  expect(ssh.body).toEqual({ host: "gitea.corp.example:2222" });

  // Never a metadata address, and only for a project that exists.
  const metadata = await callOp(panel, gitOps.allowInternalHost, { projectId, url: "https://169.254.169.254/x.git" }, { cookie: owner });
  expect(metadata.body.error?.details?.reason).toBe("internalTarget");
  dns.set("meta.example", ["169.254.169.254"]);
  expect((await callOp(panel, gitOps.allowInternalHost, { projectId, url: "https://meta.example/x.git" }, { cookie: owner })).status).toBe(
    400,
  );
  expect(rowsFor("169.254.169.254")).toHaveLength(0);
  expect(rowsFor("meta.example")).toHaveLength(0);
  const missing = await callOp(
    panel,
    gitOps.allowInternalHost,
    { projectId: "nopenopenopenope", url: "https://gitea.corp.example/a.git" },
    { cookie: owner },
  );
  expect(missing.status).toBe(404);
});
