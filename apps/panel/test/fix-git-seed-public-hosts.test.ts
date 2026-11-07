// agentio-2, review round 2. Two ways allow_internal_host still went to a
// node for the wrong host, or could not go to it for the right one:
//
// - The first-start seed recorded every host of a git source saved before
//   0.2 as an approved internal host, public ones included. A member who had
//   saved a source on a name they control got allow_internal_host=true for
//   it, so after rebinding the name (public at the panel, internal at the
//   node) the node accepted the internal address. The seed now records only
//   hosts the panel sees as internal (or that do not exist in its DNS).
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
import { getSetting, setSetting } from "../src/settings";
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

/** Sources as a pre-0.2 panel stored them: no git_internal_hosts rows, and the seed not run yet. */
function asBeforeTheUpgrade() {
  panel.deps.db.delete(gitInternalHosts).run();
  setSetting(panel.deps.db, "gitInternalHostsSeeded", false);
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
  expect(getSetting(panel.deps.db, "gitInternalHostsSeeded")).toBe(true);

  // The member rebinds the name for the node (the panel still sees the public address):
  // the node is not told to accept an internal one. Before: allowInternalHost true.
  expect((await built(svc.body.id)).allowInternalHost).toBe(false);
  // And when the panel sees the internal address too, the build is refused before it goes out.
  dns.set("git.member.example", ["10.0.0.7"]);
  await expect(built(svc.body.id)).rejects.toThrow("Only an admin can use an internal git host");
});

test("the seed keeps internal hosts and LAN-only names, and skips names it could not look up", async () => {
  const lan = await callOp(panel, serviceOps.create, gitService("https://gitea.lan/a.git", "lan"), { cookie: owner });
  const ip = await callOp(panel, serviceOps.create, gitService("ssh://git@10.0.0.9:2222/b.git", "ip"), { cookie: owner });
  dns.set("git.home.arpa", ["10.0.0.8"]);
  const lanOnly = await callOp(panel, serviceOps.create, gitService("https://git.home.arpa/c.git", "lan-only"), { cookie: owner });
  dns.set("flaky.example", ["93.184.216.60"]);
  const flaky = await callOp(panel, serviceOps.create, gitService("https://flaky.example/d.git", "flaky"), { cookie: member });
  for (const r of [lan, ip, lanOnly, flaky]) expect(r.status).toBe(200);
  asBeforeTheUpgrade();

  // At the first start the LAN-only name does not exist in the panel's DNS, and the other lookup times out.
  dns.delete("git.home.arpa");
  dns.set("flaky.example", { code: "ETIMEOUT" });
  const warnings: unknown[] = [];
  await seedInternalGitHosts(panel.deps.db, { warn: (fields: unknown) => warnings.push(fields), error: () => {} } as never);

  expect(rowsFor("gitea.lan")).toMatchObject([{ projectId, approvedBy: null }]);
  expect(rowsFor("10.0.0.9:2222")).toHaveLength(1);
  expect(rowsFor("git.home.arpa")).toHaveLength(1);
  // A failed lookup says nothing about the name: not recorded, and logged for an admin.
  expect(rowsFor("flaky.example")).toHaveLength(0);
  expect(warnings).toEqual([{ host: "flaky.example", projectIds: [projectId] }]);

  expect((await built(lan.body.id)).allowInternalHost).toBe(true);
  expect((await built(ip.body.id)).allowInternalHost).toBe(true);
  dns.set("git.home.arpa", ["10.0.0.8"]);
  expect((await built(lanOnly.body.id)).allowInternalHost).toBe(true);
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
  expect(getSetting(panel.deps.db, "gitInternalHostsSeeded")).toBe(false);
  (held.get("gitea.lan") as () => void)();
  held.delete("gitea.lan");
  await seed;
  expect(getSetting(panel.deps.db, "gitInternalHostsSeeded")).toBe(true);
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
