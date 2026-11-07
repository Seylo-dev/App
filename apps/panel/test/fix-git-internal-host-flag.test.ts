// agentio-2, the rest of it. The panel vets a git host on save and before a
// build or FetchGitFile, but the node resolves the name again when it
// clones, so a name that answers the panel with a public address and the
// node with an internal one (rebinding, split-horizon DNS) still reached
// the node's network. The agent now checks every address it connects to and
// accepts internal ones only when the request says the host is allowed:
// GitSource.allow_internal_host, set exactly for hosts in git_internal_hosts
// (and git provider connections, tested in git-providers.test.ts).
//
// git.branches (the "check access" op of a generic git source) followed the
// uptime setting instead: a member could save a source on a host an admin
// allowed for the project but not check access to it, and the uptime switch
// let members list any internal host.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { compose, git as gitOps, projects, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { gitInternalHosts, nodes } from "../src/db/schema";
import { resolveBuild } from "../src/modules/deployments/source";
import { seedInternalGitHosts } from "../src/modules/git/targets";
import { loadService } from "../src/modules/services/rows";
import { readSpec } from "../src/modules/services/spec";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { setSetting } from "../src/settings";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let owner: string;
let member: string;
let projectId: string;
let nodeA: string;
const dns = new Map<string, string[]>();
const file = "services:\n  web:\n    image: nginx:1.27\n";

beforeEach(async () => {
  dns.clear();
  dns.set("git.example.com", ["93.184.216.34"]);
  dns.set("gitea.lan", ["10.0.0.7"]);
  dns.set("other.lan", ["10.0.0.8"]);
  setTargetResolver(async (host) => {
    const found = dns.get(host);
    if (!found) throw new Error("NXDOMAIN");
    return found;
  });
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a", { canBuild: true });
  fleet.answers.set("fetchGitFile", () => ({ content: new TextEncoder().encode(file), commit: "c".repeat(40), sizeBytes: 10n }));
  fleet.answers.set("parseCompose", () => ({
    projectJson: new TextEncoder().encode(JSON.stringify({ name: "stack", services: { web: { image: "nginx:1.27" } } })),
    warnings: [],
  }));
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

test("builds and FetchGitFile tell the node when the host may be internal, and only then", async () => {
  // An admin's internal host: recorded for the project, and the node is told.
  const internal = await callOp(panel, serviceOps.create, gitService("https://gitea.lan/a.git", "lan"), { cookie: owner });
  expect(internal.status).toBe(200);
  // Before: allowInternalHost was never sent, so a node that checks addresses would refuse the admin's LAN server.
  expect(await built(internal.body.id)).toMatchObject({ url: "https://gitea.lan/a.git", allowInternalHost: true });
  // Still true when the panel now sees a public address: the node may see the internal one (split horizon).
  dns.set("gitea.lan", ["93.184.216.40"]);
  expect((await built(internal.body.id)).allowInternalHost).toBe(true);

  // A member's public host: the node must not accept an internal answer for it.
  const pub = await callOp(panel, serviceOps.create, gitService("https://git.example.com/x.git", "pub"), { cookie: member });
  expect(pub.status).toBe(200);
  expect((await built(pub.body.id)).allowInternalHost).toBe(false);
  expect(panel.deps.db.select().from(gitInternalHosts).where(eq(gitInternalHosts.host, "git.example.com")).all()).toHaveLength(0);

  const preview = (url: string) =>
    callOp(
      panel,
      compose.preview,
      {
        projectId,
        name: "stack",
        nodeId: nodeA,
        source: { type: "git", url, branch: "main", path: "compose.yml", credentialId: null, deployOnPush: false },
      },
      { cookie: member },
    );
  expect((await preview("https://gitea.lan/stack.git")).status).toBe(200);
  expect((await preview("https://git.example.com/stack.git")).status).toBe(200);
  const sent = fleet.calls
    .filter((c) => c.method === "fetchGitFile")
    .map((c) => (c.request as { source: { url: string; allowInternalHost: boolean } }).source);
  expect(sent).toMatchObject([
    { url: "https://gitea.lan/stack.git", allowInternalHost: true },
    { url: "https://git.example.com/stack.git", allowInternalHost: false },
  ]);
});

// Hosts recorded on the first start (sources saved before 0.2) count like an admin's.
test("a seeded internal host builds with allowInternalHost", async () => {
  const svc = await callOp(panel, serviceOps.create, gitService("https://gitea.lan/seeded.git", "seeded"), { cookie: owner });
  expect(svc.status).toBe(200);
  // As if it had been saved before the check existed.
  panel.deps.db.delete(gitInternalHosts).run();
  await expect(built(svc.body.id)).rejects.toThrow("Only an admin can use an internal git host");
  setSetting(panel.deps.db, "gitInternalHostsSeededV2", false);
  await seedInternalGitHosts(panel.deps.db);
  // Before: allowInternalHost was never sent, so a 0.2 node refused a LAN git server an upgrade kept.
  expect((await built(svc.body.id)).allowInternalHost).toBe(true);
});

// Uptime checks may reach a node's own address (an admin set it), but for git that address is
// internal like any other: the node clones from it only for a host an admin allowed for the project.
test("a node's own private address is an internal git host", async () => {
  panel.deps.db.update(nodes).set({ publicAddress: "10.0.0.9" }).where(eq(nodes.id, nodeA)).run();
  dns.set("gitea.node", ["10.0.0.9"]);
  // Before: the member's source was saved (the uptime exception), and the node was never told the host is allowed.
  const byMember = await callOp(panel, serviceOps.create, gitService("https://gitea.node:3000/a.git", "member-src"), { cookie: member });
  expect(byMember.body.error?.details?.reason).toBe("internalTarget");
  const byOwner = await callOp(panel, serviceOps.create, gitService("https://gitea.node:3000/a.git", "owner-src"), { cookie: owner });
  expect(byOwner.status).toBe(200);
  expect(panel.deps.db.select().from(gitInternalHosts).where(eq(gitInternalHosts.host, "gitea.node:3000")).all()).toHaveLength(1);
  // Before: allowInternalHost was false, so a 0.2 node refused the admin's git server on its own LAN address.
  expect((await built(byOwner.body.id)).allowInternalHost).toBe(true);
});

/** A smart-HTTP ref advertisement with main as the default branch. */
function advertisement(): Response {
  const line = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
  const sha = "b".repeat(40);
  const body = `${line("# service=git-upload-pack\n")}0000${line(`${sha} HEAD\0symref=HEAD:refs/heads/main\n`)}${line(`${sha} refs/heads/main\n`)}0000`;
  return new Response(body, { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
}

test("git.branches follows the project's internal hosts, not the uptime setting", async () => {
  const seen: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return advertisement();
  }) as typeof fetch);
  try {
    const branches = (url: string, cookie: string) => callOp(panel, gitOps.branches, { projectId, url }, { cookie });
    // Not allowed yet: refused.
    expect((await branches("https://gitea.lan/a.git", member)).body.error?.details?.reason).toBe("internalTarget");
    // An admin saves a source on it: the project's members may now check access to it, at the vetted address.
    expect((await callOp(panel, serviceOps.create, gitService("https://gitea.lan/a.git", "lan"), { cookie: owner })).status).toBe(200);
    const res = await branches("https://gitea.lan/b.git", member);
    // Before: 400 internalTarget for the member, although the member could save this very source.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ branches: ["main"], defaultBranch: "main" });
    expect(seen.at(-1)).toStartWith("https://10.0.0.7/b.git/info/refs");

    // The uptime switch is for uptime checks: it does not open other internal hosts to members.
    setSetting(panel.deps.db, "uptimeAllowInternalTargets", true);
    const before = seen.length;
    const other = await branches("https://other.lan/x.git", member);
    // Before: 200, the panel listed the internal host by name.
    expect(other.body.error?.details?.reason).toBe("internalTarget");
    expect(seen.length).toBe(before);
    // Metadata never, also for admins.
    const metadata = await branches("https://169.254.169.254/x.git", owner);
    expect(metadata.status).toBe(400);
    expect(seen.length).toBe(before);
  } finally {
    fetchSpy.mockRestore();
  }
});

// Round 3: an admin's "Check access" on a LAN-only name (one the panel's DNS does not know) failed
// with "did not resolve", although the admin can save a source with it. Admins read it by name;
// for anyone else the panel never asks DNS again unchecked.
test("git.branches reads a name the panel cannot resolve by name for admins only", async () => {
  const seen: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return advertisement();
  }) as typeof fetch);
  try {
    const branches = (url: string, cookie: string) => callOp(panel, gitOps.branches, { projectId, url }, { cookie });
    const byMember = await branches("https://git.home.arpa/a.git", member);
    expect(byMember.body.error?.details?.reason).toBe("unresolvable");
    expect(seen).toHaveLength(0);
    const byOwner = await branches("https://git.home.arpa/a.git", owner);
    // Before: 400 unresolvable.
    expect(byOwner.status).toBe(200);
    expect(byOwner.body).toEqual({ branches: ["main"], defaultBranch: "main" });
    expect(seen).toEqual(["https://git.home.arpa/a.git/info/refs?service=git-upload-pack"]);
    // A recorded host does not open the by-name read to members.
    expect(
      (await callOp(panel, gitOps.allowInternalHost, { projectId, url: "https://git.home.arpa/a.git" }, { cookie: owner })).status,
    ).toBe(200);
    expect((await branches("https://git.home.arpa/a.git", member)).body.error?.details?.reason).toBe("unresolvable");
    expect(seen).toHaveLength(1);
  } finally {
    fetchSpy.mockRestore();
  }
});
