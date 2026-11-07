// A git URL makes a node clone in its own network, and FetchGitFile hands
// the file back. Members may only use public addresses; an internal host
// works in a project once an admin saved a source with it there. Checked on
// save and again before a build or FetchGitFile goes out, and FetchGitFile
// only runs on the project's own nodes.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { compose, projects, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { deployments, gitInternalHosts, services } from "../src/db/schema";
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
let otherProjectId: string;
let nodeA: string;
let nodeB: string;
const dns = new Map<string, string[]>();

const file = "services:\n  web:\n    image: nginx:1.27\n";

beforeEach(async () => {
  dns.clear();
  dns.set("git.example.com", ["93.184.216.34"]);
  dns.set("gitea.lan", ["10.0.0.7"]);
  setTargetResolver(async (host) => {
    const found = dns.get(host);
    if (!found) throw new Error("NXDOMAIN");
    return found;
  });
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a", { canBuild: true });
  nodeB = fleet.addNode("node-b", { canBuild: true });
  fleet.answers.set("fetchGitFile", () => ({ content: new TextEncoder().encode(file), commit: "c".repeat(40), sizeBytes: 10n }));
  fleet.answers.set("parseCompose", () => ({
    projectJson: new TextEncoder().encode(JSON.stringify({ name: "stack", services: { web: { image: "nginx:1.27" } } })),
    warnings: [],
  }));
  ({ cookie: owner } = await createUser(panel, "owner"));
  const m = await createUser(panel, "member");
  member = m.cookie;
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie: owner })).body.id;
  otherProjectId = (await callOp(panel, projects.create, { name: "blog" }, { cookie: owner })).body.id;
  for (const id of [projectId, otherProjectId])
    grant(panel, m.user.id, "project", id, ["services.create", "services.view", "services.update"]);
});
afterEach(() => {
  setTargetResolver(null);
  panel.close();
});

const gitService = (url: string, name = "api", project = projectId) => ({
  projectId: project,
  name,
  kind: "app" as const,
  nodeId: nodeA,
  source: { type: "git" as const, url, branch: "main", credentialId: null, deployOnPush: false },
});

const composeSource = (url: string) => ({
  type: "git" as const,
  url,
  branch: "main",
  path: "compose.yml",
  credentialId: null,
  deployOnPush: false,
});

test("a member cannot point a service or a compose stack at loopback or a private address", async () => {
  for (const url of ["https://127.0.0.1:3000/x.git", "ssh://git@10.0.0.7/x.git", "https://gitea.lan/x.git", "git@10.1.2.3:x.git"]) {
    const res = await callOp(panel, serviceOps.create, gitService(url), { cookie: member });
    // Before: 200, and a build cloned it on the node.
    expect({ url, status: res.status, reason: res.body.error?.details?.reason }).toEqual({ url, status: 400, reason: "internalTarget" });
  }
  const unknown = await callOp(panel, serviceOps.create, gitService("https://nowhere.invalid/x.git"), { cookie: member });
  expect(unknown.body.error?.details?.reason).toBe("unresolvable");
  const stack = await callOp(
    panel,
    compose.preview,
    { projectId, name: "stack", nodeId: nodeA, source: composeSource("https://127.0.0.1:3000/internal.git") },
    { cookie: member },
  );
  // Before: the node fetched the file from its loopback and the response carried it.
  expect(stack.status).toBe(400);
  expect(fleet.calls.filter((c) => c.method === "fetchGitFile")).toHaveLength(0);
  expect((await callOp(panel, serviceOps.create, gitService("https://git.example.com/x.git"), { cookie: member })).status).toBe(200);
});

test("an admin's internal host is shared with the project's members, not with other projects; metadata never", async () => {
  expect((await callOp(panel, serviceOps.create, gitService("https://gitea.lan/a.git"), { cookie: owner })).status).toBe(200);
  expect(panel.deps.db.select().from(gitInternalHosts).all()).toMatchObject([{ projectId, host: "gitea.lan" }]);
  expect((await callOp(panel, serviceOps.create, gitService("https://gitea.lan/b.git", "web"), { cookie: member })).status).toBe(200);
  const elsewhere = await callOp(panel, serviceOps.create, gitService("https://gitea.lan/b.git", "web", otherProjectId), {
    cookie: member,
  });
  expect(elsewhere.body.error?.details?.reason).toBe("internalTarget");
  const metadata = await callOp(panel, serviceOps.create, gitService("https://169.254.169.254/x.git", "meta"), { cookie: owner });
  expect(metadata.status).toBe(400);
  expect(metadata.body.error.message).toContain("never clone");
});

test("a build is refused when the stored address is internal and not allowed, also after the name moved inside", async () => {
  const created = await callOp(panel, serviceOps.create, gitService("https://git.example.com/x.git"), { cookie: member });
  const service = loadService(panel.deps.db, created.body.id);
  const build = () =>
    resolveBuild(panel.deps, {
      service,
      spec: readSpec(service.spec),
      buildId: "b1",
      generation: 1,
      commitSha: "a".repeat(40),
      uploadId: null,
    });
  await expect(build()).resolves.toMatchObject({ commit: { sha: "a".repeat(40) } });
  // DNS rebinding: the name now answers with a private address.
  dns.set("git.example.com", ["192.168.1.10"]);
  await expect(build()).rejects.toThrow("192.168.1.10");
  // A source written before this check (or straight into the database) is checked too.
  panel.deps.db
    .update(services)
    .set({ spec: { ...readSpec(service.spec), source: { ...gitService("https://127.0.0.1:9/y.git").source } } })
    .where(eq(services.id, service.id))
    .run();
  const stored = loadService(panel.deps.db, service.id);
  await expect(
    resolveBuild(panel.deps, {
      service: stored,
      spec: readSpec(stored.spec),
      buildId: "b2",
      generation: 2,
      commitSha: null,
      uploadId: null,
    }),
  ).rejects.toThrow("loopback");
  expect(panel.deps.db.select().from(deployments).all()).toHaveLength(0);
});

test("FetchGitFile runs on the stack's own node, never on another online node", async () => {
  // node-b runs a service of the other project only.
  await callOp(
    panel,
    serviceOps.create,
    { ...gitService("https://git.example.com/z.git", "z", otherProjectId), nodeId: nodeB },
    { cookie: owner },
  );
  const source = composeSource("https://git.example.com/acme/shop.git");
  const res = await callOp(panel, compose.preview, { projectId, name: "stack", nodeId: nodeA, source }, { cookie: member });
  expect(res.status).toBe(200);
  expect(fleet.calls.filter((c) => c.method === "fetchGitFile").map((c) => c.nodeId)).toEqual([nodeA]);
  // A node that is not online (or does not exist): before, any online node that could (node-b) was used.
  fleet.calls.length = 0;
  const unknownNode = await callOp(
    panel,
    compose.preview,
    { projectId, name: "stack", nodeId: "n".repeat(16), source },
    { cookie: member },
  );
  expect(unknownNode.body.error?.details?.reason).toBe("offline");
  expect(fleet.calls.filter((c) => c.method === "fetchGitFile")).toHaveLength(0);
});

test("plain http:// git is refused at save and never sent: allow_plain_http stays off", async () => {
  // Every git source the panel can store is https://, ssh:// or git@ (services, compose stacks, providers, Boxes).
  const plain = await callOp(panel, serviceOps.create, gitService("http://git.example.com/x.git"), { cookie: owner });
  expect(plain.status).toBe(400);
  const stack = await callOp(
    panel,
    compose.preview,
    { projectId, name: "stack", nodeId: nodeA, source: composeSource("http://git.example.com/x.git") },
    { cookie: owner },
  );
  expect(stack.status).toBe(400);
  const created = await callOp(panel, serviceOps.create, gitService("https://git.example.com/x.git"), { cookie: owner });
  const service = loadService(panel.deps.db, created.body.id);
  const resolved = await resolveBuild(panel.deps, {
    service,
    spec: readSpec(service.spec),
    buildId: "b1",
    generation: 1,
    commitSha: "a".repeat(40),
    uploadId: null,
  });
  const git = resolved.request.source?.source;
  expect(git?.case).toBe("git");
  expect(git?.case === "git" && git.value.allowPlainHttp).toBe(false);
});

test("hosts of git sources saved before the check count as allowed once", async () => {
  const row = panel.deps.db
    .insert(services)
    .values({
      projectId,
      name: "old",
      nameKey: "old",
      kind: "app",
      spec: { source: { type: "git", url: "https://10.9.9.9:3000/old.git", branch: "main", credentialId: null, deployOnPush: false } },
    })
    .returning()
    .get();
  setSetting(panel.deps.db, "gitInternalHostsSeeded", false);
  // The seed looks the hosts up in the background (an address here, a private one: recorded).
  await seedInternalGitHosts(panel.deps.db);
  expect(panel.deps.db.select().from(gitInternalHosts).where(eq(gitInternalHosts.projectId, row.projectId)).all()).toMatchObject([
    { host: "10.9.9.9:3000" },
  ]);
  // Only once: later sources are vetted when saved.
  panel.deps.db.delete(gitInternalHosts).run();
  await seedInternalGitHosts(panel.deps.db);
  expect(panel.deps.db.select().from(gitInternalHosts).all()).toHaveLength(0);
});
