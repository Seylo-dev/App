// GitLab, Gitea/Forgejo and Bitbucket connections through the real panel
// pipeline, with recorded provider answers: connecting a repository creates
// its webhook, signed deliveries deploy the branch head through the build
// (token and user name for the provider's host only), watch paths and
// [skip ci] skip, replays and bad signatures are refused, merge/pull
// requests open previews, polling catches missed pushes, commit statuses
// go back, and webhooks go away with the source or the service.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  deployments as deploymentOps,
  git as gitOps,
  previews as previewOps,
  projects,
  gitProviders as providerOps,
  services as serviceOps,
  webhooks,
} from "@seylo/ops";
import { DeployStage } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { freshSignInMs } from "../src/auth/fresh";
import { deploymentLogs, deployments, gitProviderWebhooks, services, sessions, webhookDeliveries } from "../src/db/schema";
import { resolveBuild } from "../src/modules/deployments/source";
import { gitlabNeedsHttps, repairHooks } from "../src/modules/gitProviders/hooks";
import { pollProviderBranches } from "../src/modules/gitProviders/poll";
import { loadService } from "../src/modules/services/rows";
import { readSpec } from "../src/modules/services/spec";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { setSetting } from "../src/settings";
import { FakeFleet } from "./fake-fleet";
import { FakeProviders, fakeAddress, payloadFixture, recorded } from "./git-provider-fakes";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let fake: FakeProviders;
let cookie: string;
let projectId: string;
let nodeA: string;

const giteaHead = "8d3f2e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e";
const gitlabHead = "da1560886d4f094c3e6c9ef40349f7d38b5d27d7";
const bitbucketHead = "9a6f3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a";

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a", { canBuild: true, panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  fake = new FakeProviders({
    "gitlab.com": recorded("gitlab"),
    "git.example.com": recorded("gitea"),
    "api.bitbucket.org": recorded("bitbucket"),
  });
  fake.install();
  setSetting(panel.deps.db, "panelDomain", "panel.example.com");
});
afterEach(() => {
  fake.uninstall();
  panel.close();
});

async function connection(kind: "gitlab" | "gitea" | "bitbucket") {
  const input =
    kind === "gitea"
      ? { kind, name: "Forge", url: "https://git.example.com", token: "gitea-token" }
      : kind === "gitlab"
        ? { kind, name: "GitLab", token: "glpat-token" }
        : { kind, name: "Bitbucket", workspace: "acme-ws", token: "bb-token" };
  const res = await callOp(panel, providerOps.create, input as never, { cookie });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function connectedService(kind: "gitlab" | "gitea" | "bitbucket", name = "web", existingProvider?: string) {
  const providerId = existingProvider ?? (await connection(kind));
  const repo = kind === "gitea" ? "acme/shop" : kind === "gitlab" ? "acme/platform/shop" : "acme-ws/shop";
  const id = (
    await callOp(
      panel,
      serviceOps.create,
      { projectId, name, kind: "app", nodeId: nodeA, ports: [{ containerPort: 3000, protocol: "tcp" }] },
      { cookie },
    )
  ).body.id as string;
  const res = await callOp(
    panel,
    providerOps.connectRepo,
    { serviceId: id, providerId, repo, branch: "main", deployOnPush: true },
    { cookie },
  );
  expect(res.status).toBe(200);
  expect(res.body.sourceConfig).toEqual({ type: "provider", providerId, provider: kind, repo, branch: "main", deployOnPush: true });
  expect(res.body.source).toMatchObject({ type: kind, label: repo, branch: "main" });
  const hook = panel.deps.db.select().from(gitProviderWebhooks).where(eq(gitProviderWebhooks.serviceId, id)).get();
  if (!hook) throw new Error("no webhook row");
  const secret = panel.deps.secrets.open(hook.secretSealed, "git.webhook") as string;
  return { id, providerId, repo, hook, secret };
}

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

async function deliver(
  kind: "gitlab" | "gitea" | "bitbucket",
  hook: { id: string },
  secret: string,
  event: string,
  payload: unknown,
  options: { delivery?: string; badSecret?: boolean } = {},
) {
  const body = JSON.stringify(payload);
  const key = options.badSecret ? "wrong" : secret;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const delivery = options.delivery ?? crypto.randomUUID();
  if (kind === "gitlab") Object.assign(headers, { "x-gitlab-token": key, "x-gitlab-event": event, "x-gitlab-event-uuid": delivery });
  if (kind === "gitea")
    Object.assign(headers, { "x-gitea-signature": sign(key, body), "x-gitea-event": event, "x-gitea-delivery": delivery });
  if (kind === "bitbucket")
    Object.assign(headers, { "x-hub-signature": `sha256=${sign(key, body)}`, "x-event-key": event, "x-request-uuid": delivery });
  const res = await panel.app.handle(new Request(`http://panel.test/api/hooks/${kind}/${hook.id}`, { method: "POST", headers, body }));
  await fleet.settle();
  return { status: res.status, body: (await res.json()) as any };
}

const deploymentsOf = (serviceId: string) => panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).all();
const deliveriesOf = async (serviceId: string) =>
  (await callOp(panel, webhooks.listDeliveries, { serviceId }, { cookie })).body.deliveries as {
    outcome: string;
    detail: string;
    source: string;
  }[];
const logOf = (deploymentId: string) =>
  panel.deps.db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, deploymentId))
    .all()
    .map((l) => l.text);

describe("connections", () => {
  test("a token is checked with the provider, sealed, and its account shown to managers only", async () => {
    const id = await connection("gitlab");
    expect(fake.calls("gitlab.com")).toEqual(["GET /api/v4/user"]);
    expect(fake.sent[0]?.headers["private-token"]).toBe("glpat-token");
    const list = await callOp(panel, providerOps.list, {}, { cookie });
    expect(list.body.items[0]).toMatchObject({
      id,
      kind: "gitlab",
      host: "gitlab.com",
      url: "https://gitlab.com",
      account: "project_42_bot_3f2a",
    });
    expect(JSON.stringify(list.body)).not.toContain("glpat-token");

    const member = await createUser(panel, "member");
    // People who may set a source somewhere pick connections (picker-lists.test.ts).
    grant(panel, member.user.id, "project", projectId, ["services.create"]);
    const seen = await callOp(panel, providerOps.list, {}, { cookie: member.cookie });
    expect(seen.body.items[0]).toMatchObject({ id, account: null, username: null });
    const denied = await callOp(panel, providerOps.create, { kind: "gitlab", name: "x", token: "t" }, { cookie: member.cookie });
    expect(denied.status).toBe(403);
  });

  test("bad input and refused tokens say why", async () => {
    const noUrl = await callOp(panel, providerOps.create, { kind: "gitea", name: "x", token: "t" }, { cookie });
    expect(noUrl.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "url" } });
    const noWorkspace = await callOp(panel, providerOps.create, { kind: "bitbucket", name: "x", token: "t" }, { cookie });
    expect(noWorkspace.body.error.details.field).toBe("workspace");
    const noUser = await callOp(
      panel,
      providerOps.create,
      { kind: "bitbucket", name: "x", workspace: "acme-ws", authKind: "appPassword", token: "t" },
      { cookie },
    );
    expect(noUser.body.error.details.field).toBe("username");
    const plain = await callOp(
      panel,
      providerOps.create,
      { kind: "gitea", name: "x", url: "http://git.example.com", token: "t" } as never,
      { cookie },
    );
    expect(plain.status).toBe(400);
    fake.override((r) => (r.path === "/api/v4/user" ? { status: 401, body: { message: "401 Unauthorized" } } : undefined));
    const refused = await callOp(panel, providerOps.create, { kind: "gitlab", name: "x", token: "t" }, { cookie });
    expect(refused.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "token", reason: "token" } });
  });

  test("check, rename and a new token (checked first)", async () => {
    const id = await connection("gitea");
    expect((await callOp(panel, providerOps.check, { providerId: id }, { cookie })).body).toMatchObject({ ok: true, account: "jdev" });
    const renamed = await callOp(
      panel,
      providerOps.update,
      { providerId: id, name: "Codeberg", token: "next", statusNotes: false },
      { cookie },
    );
    expect(renamed.body).toMatchObject({ name: "Codeberg", statusNotes: false });
    expect(fake.sent.at(-1)?.headers.authorization).toBe("token next");
  });
});

describe("fresh sign-in for connection tokens", () => {
  const stale = (userId: string) =>
    panel.deps.db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - freshSignInMs - 60_000), reauthAt: null })
      .where(eq(sessions.userId, userId))
      .run();

  test("a session left open cannot add a connection or swap its token; renaming and API keys need none", async () => {
    const id = await connection("gitea");
    const owner = panel.deps.db.select().from(sessions).all()[0];
    stale(owner?.userId as string);
    const created = await callOp(panel, providerOps.create, { kind: "gitlab", name: "Other", token: "glpat-x" }, { cookie });
    expect(created).toMatchObject({ status: 403, body: { error: { details: { reason: "reauth" } } } });
    const swapped = await callOp(panel, providerOps.update, { providerId: id, token: "attacker" }, { cookie });
    expect(swapped.body.error.details.reason).toBe("reauth");
    // Nothing was checked with the provider or stored by the refused calls.
    expect(fake.sent.some((r) => r.headers.authorization === "token attacker" || r.headers["private-token"] === "glpat-x")).toBe(false);
    expect((await callOp(panel, providerOps.update, { providerId: id, name: "Renamed" }, { cookie })).body.name).toBe("Renamed");

    const key = createApiKey(panel, owner?.userId as string);
    const viaKey = await callOp(panel, providerOps.update, { providerId: id, token: "rotated" }, { bearer: key });
    expect(viaKey.status).toBe(200);
    expect(fake.sent.at(-1)?.headers.authorization).toBe("token rotated");
  });
});

describe("connecting a repository", () => {
  test("creates a webhook with its own secret at the panel domain, and the pickers list repos and branches", async () => {
    const { id, hook, providerId } = await connectedService("gitea");
    expect(hook.remoteId).toBe("7");
    expect(hook.url).toBe(`https://panel.example.com/api/hooks/gitea/${hook.id}`);
    const created = fake.sent.find((r) => r.method === "POST" && r.path === "/api/v1/repos/acme/shop/hooks");
    expect(created?.body.config.url).toBe(hook.url);
    expect(created?.body.config.secret).toMatch(/^[0-9a-f]{64}$/);
    const status = await callOp(panel, providerOps.webhook, { serviceId: id }, { cookie });
    expect(status.body).toMatchObject({ configured: true, kind: "gitea", repo: "acme/shop", created: true, error: null, insecure: false });

    const repos = await callOp(panel, providerOps.repos, { projectId, providerId }, { cookie });
    expect(repos.body.repos.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/shop"]);
    const branches = await callOp(panel, providerOps.branches, { projectId, providerId, repo: "acme/shop" }, { cookie });
    expect(branches.body).toEqual({ defaultBranch: "main", branches: ["main", "feat/checkout"] });
  });

  test("a missing branch or an unreadable repo is refused before anything changes", async () => {
    const providerId = await connection("gitlab");
    const id = (await callOp(panel, serviceOps.create, { projectId, name: "api", kind: "app", nodeId: nodeA }, { cookie })).body.id;
    const branch = await callOp(
      panel,
      providerOps.connectRepo,
      { serviceId: id, providerId, repo: "acme/platform/shop", branch: "nope", deployOnPush: true },
      { cookie },
    );
    expect(branch.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "branch" } });
    const repo = await callOp(
      panel,
      providerOps.connectRepo,
      { serviceId: id, providerId, repo: "acme/missing", branch: "main", deployOnPush: true },
      { cookie },
    );
    expect(repo.body.error.details.field).toBe("repo");
    expect(panel.deps.db.select().from(gitProviderWebhooks).all()).toHaveLength(0);
  });

  test("setSource refuses provider sources; members may not attach a connection to a new project", async () => {
    const providerId = await connection("gitea");
    const id = (await callOp(panel, serviceOps.create, { projectId, name: "api", kind: "app", nodeId: nodeA }, { cookie })).body.id;
    const direct = await callOp(
      panel,
      serviceOps.setSource,
      { serviceId: id, source: { type: "provider", providerId, provider: "gitea", repo: "acme/shop", branch: "main", deployOnPush: true } },
      { cookie },
    );
    expect(direct.body.error.code).toBe("BAD_REQUEST");
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "project", projectId, ["*"]);
    const repos = await callOp(panel, providerOps.repos, { projectId, providerId }, { cookie: member.cookie });
    expect(repos.status).toBe(403);
    // Once an admin used it in the project, members of the project may pick it there.
    await callOp(
      panel,
      providerOps.connectRepo,
      { serviceId: id, providerId, repo: "acme/shop", branch: "main", deployOnPush: true },
      { cookie },
    );
    expect((await callOp(panel, providerOps.repos, { projectId, providerId }, { cookie: member.cookie })).status).toBe(200);
  });

  test("repository paths with dot segments are refused by the contract", async () => {
    const providerId = await connection("gitea");
    const res = await callOp(panel, providerOps.branches, { projectId, providerId, repo: "acme/../admin" }, { cookie });
    expect(res.status).toBe(400);
    expect(fake.calls("git.example.com").some((c) => c.includes("admin"))).toBe(false);
  });

  test("without a domain, only a connection manager's address is used for the webhook", async () => {
    setSetting(panel.deps.db, "panelDomain", null);
    const providerId = await connection("gitea");
    const id = (await callOp(panel, serviceOps.create, { projectId, name: "api", kind: "app", nodeId: nodeA }, { cookie })).body.id;
    // An admin used the connection in the project, so a member of the project may connect a repo with it.
    const other = (await callOp(panel, serviceOps.create, { projectId, name: "api2", kind: "app", nodeId: nodeA }, { cookie })).body.id;
    await callOp(
      panel,
      providerOps.connectRepo,
      { serviceId: other, providerId, repo: "acme/shop", branch: "main", deployOnPush: true },
      { cookie },
    );
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "project", projectId, ["*"]);
    const res = await callOp(
      panel,
      providerOps.connectRepo,
      { serviceId: id, providerId, repo: "acme/shop", branch: "main", deployOnPush: true },
      { cookie: member.cookie, headers: { host: "attacker.example" } },
    );
    expect(res.status).toBe(200);
    const hook = await callOp(panel, providerOps.webhook, { serviceId: id }, { cookie });
    expect(hook.body).toMatchObject({ created: false, url: null });
    expect(fake.sent.some((r) => JSON.stringify(r.body ?? "").includes("attacker.example"))).toBe(false);
  });

  test("without a panel address the source is saved and the webhook says what to do", async () => {
    setSetting(panel.deps.db, "panelDomain", null);
    const providerId = await connection("gitea");
    const id = (await callOp(panel, serviceOps.create, { projectId, name: "api", kind: "app", nodeId: nodeA }, { cookie })).body.id;
    // The address the caller reached the panel at is the fallback: a provider on the same network reaches it.
    await callOp(
      panel,
      providerOps.connectRepo,
      { serviceId: id, providerId, repo: "acme/shop", branch: "main", deployOnPush: true },
      { cookie },
    );
    const status = await callOp(panel, providerOps.webhook, { serviceId: id }, { cookie });
    expect(status.body).toMatchObject({ created: true, insecure: true });
    expect(status.body.url).toStartWith("http://panel.test/api/hooks/gitea/");
    // Without either (an MCP or AI call has no origin) the hook waits for an address and says so.
    const row = panel.deps.db.select().from(gitProviderWebhooks).where(eq(gitProviderWebhooks.serviceId, id)).get();
    const { ensureHook } = await import("../src/modules/gitProviders/hooks");
    const { loadProvider } = await import("../src/modules/gitProviders/rows");
    panel.deps.db
      .update(gitProviderWebhooks)
      .set({ url: null })
      .where(eq(gitProviderWebhooks.id, row?.id as string))
      .run();
    const waiting = await ensureHook(panel.deps, {
      serviceId: id,
      provider: loadProvider(panel.deps.db, providerId),
      repo: "acme/shop",
      force: true,
    });
    expect(waiting).toMatchObject({ remoteId: null, url: null });
    expect(waiting.error).toContain("no public address");
  });
});

describe("GitLab webhook address", () => {
  test("GitLab's hook is never created at a plain http:// address: its token travels with every delivery", async () => {
    setSetting(panel.deps.db, "panelDomain", null);
    const { id } = await connectedService("gitlab");
    const status = await callOp(panel, providerOps.webhook, { serviceId: id }, { cookie });
    expect(status.body).toMatchObject({ created: false, url: null, error: gitlabNeedsHttps });
    expect(fake.sent.some((r) => r.method === "POST" && r.path.endsWith("/hooks"))).toBe(false);
    // Once the panel has a domain, the repair creates it there.
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    expect(await repairHooks(panel.deps)).toBe(1);
    const created = await callOp(panel, providerOps.webhook, { serviceId: id }, { cookie });
    expect(created.body).toMatchObject({ created: true, error: null, insecure: false });
    expect(created.body.url).toStartWith("https://panel.example.com/api/hooks/gitlab/");
  });
});

describe("Gitea pushes", () => {
  test("a signed push deploys the branch head with the provider's token and user name for its host", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    const res = await deliver("gitea", hook, secret, "push", payloadFixture("gitea-push"));
    expect(res).toMatchObject({ status: 200, body: { ok: true, deployed: 1 } });
    const [d] = deploymentsOf(id);
    expect(d).toMatchObject({
      trigger: "push",
      actor: "jdev",
      commitSha: giteaHead,
      commitMessage: "Fix the checkout total",
      branch: "main",
    });
    expect(fleet.builds[0]?.request).toMatchObject({
      source: {
        source: {
          case: "git",
          // git.example.com is public at the panel: the node accepts no internal answer for it.
          value: {
            url: "https://git.example.com/acme/shop.git",
            commit: giteaHead,
            token: "gitea-token",
            username: "jdev",
            allowInternalHost: false,
          },
        },
      },
    });
    const list = await deliveriesOf(id);
    expect(list[0]).toMatchObject({ source: "gitea", outcome: "deployed" });
  });

  // agentio-2: every provider build went out with allow_internal_host=true, github.com and other public
  // hosts included, so a rebinding answer at the node was accepted. The connection's host is an admin's
  // choice: on a LAN address it is allowed, on a public one only when recorded for the project.
  test("a provider build lets the node reach internal addresses only for a LAN host or a recorded one", async () => {
    const { id } = await connectedService("gitea");
    const built = async () => {
      const service = loadService(panel.deps.db, id);
      const resolved = await resolveBuild(panel.deps, {
        service,
        spec: readSpec(service.spec),
        buildId: "b1",
        generation: 1,
        commitSha: giteaHead,
        uploadId: null,
      });
      const git = resolved.request.source?.source;
      if (git?.case !== "git") throw new Error("not a git build");
      return git.value;
    };
    // Public at the panel. Before: true.
    expect(await built()).toMatchObject({ url: "https://git.example.com/acme/shop.git", allowInternalHost: false });

    // The same connection on a LAN address (a self-hosted Gitea) keeps building with the allowance.
    setTargetResolver(async () => ["10.0.0.5"]);
    expect(await built()).toMatchObject({ allowInternalHost: true });

    // A public host an admin recorded for the project (split-horizon DNS at the nodes).
    setTargetResolver(async () => [fakeAddress]);
    expect(
      (await callOp(panel, gitOps.allowInternalHost, { projectId, url: "https://git.example.com/acme/shop.git" }, { cookie })).status,
    ).toBe(200);
    expect(await built()).toMatchObject({ allowInternalHost: true });
    // Cloud metadata never.
    setTargetResolver(async () => ["169.254.169.254"]);
    expect(await built()).toMatchObject({ allowInternalHost: false });
  });

  test("bad signatures are rejected and logged; a replayed body and a repeated delivery deploy nothing", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    const bad = await deliver("gitea", hook, secret, "push", payloadFixture("gitea-push"), { badSecret: true });
    expect(bad.status).toBe(401);
    expect((await deliveriesOf(id))[0]).toMatchObject({ outcome: "rejected", detail: "The signature did not match." });

    await deliver("gitea", hook, secret, "push", payloadFixture("gitea-push"), { delivery: "d-1" });
    const again = await deliver("gitea", hook, secret, "push", payloadFixture("gitea-push"), { delivery: "d-1" });
    expect(again.body).toMatchObject({ duplicate: true });
    const replay = await deliver("gitea", hook, secret, "push", payloadFixture("gitea-push"), { delivery: "d-2" });
    expect(replay.body).toMatchObject({ duplicate: true });
    expect(deploymentsOf(id)).toHaveLength(1);
    expect((await deliveriesOf(id)).some((d) => d.detail.includes("replay"))).toBe(true);

    const unknown = await panel.app.handle(
      new Request("http://panel.test/api/hooks/gitea/zzzzzzzzzzzzzzzz", { method: "POST", body: "{}" }),
    );
    expect(unknown.status).toBe(404);
    // A Gitea hook id under the GitLab path is unknown there.
    const wrongKind = await panel.app.handle(new Request(`http://panel.test/api/hooks/gitlab/${hook.id}`, { method: "POST", body: "{}" }));
    expect(wrongKind.status).toBe(404);
  });

  test("watch paths: a matching file deploys and the log names it; other files skip; [skip ci] skips", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    const set = await callOp(
      panel,
      serviceOps.setWatchPaths,
      { serviceId: id, watchPaths: [" ./apps/web/ ", "!**/*.md", "apps/web/"] },
      { cookie },
    );
    expect(set.body.watchPaths).toEqual(["apps/web/**", "!**/*.md"]);
    expect((await callOp(panel, serviceOps.get, { serviceId: id }, { cookie })).body.watchPaths).toEqual(["apps/web/**", "!**/*.md"]);

    await deliver("gitea", hook, secret, "push", payloadFixture("gitea-push"));
    const [d] = deploymentsOf(id);
    expect(logOf(d?.id as string)).toContain("Watch paths: apps/web/src/checkout/total.ts matches apps/web/**.");

    const docs = payloadFixture("gitea-push");
    docs.after = "1".repeat(40);
    docs.commits = docs.commits.map((c: object) => ({
      ...c,
      id: "1".repeat(40),
      added: [],
      modified: ["apps/web/README.md", "apps/api/x.go"],
    }));
    docs.head_commit = docs.commits[0];
    await deliver("gitea", hook, secret, "push", docs);
    expect(deploymentsOf(id)).toHaveLength(1);
    expect((await deliveriesOf(id))[0]).toMatchObject({
      outcome: "ignored",
      detail: "Skipped by watch paths: none of the 2 changed files matches.",
    });

    const skip = payloadFixture("gitea-push");
    skip.after = "2".repeat(40);
    skip.head_commit = { ...skip.head_commit, id: "2".repeat(40), message: "Tidy up [skip ci]" };
    await deliver("gitea", hook, secret, "push", skip);
    expect(deploymentsOf(id)).toHaveLength(1);
    expect((await deliveriesOf(id))[0]?.detail).toBe("Skipped: the head commit message says [skip ci].");
  });

  test("a truncated list is completed with the compare API; when that fails the push deploys", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    await callOp(panel, serviceOps.setWatchPaths, { serviceId: id, watchPaths: ["apps/web/**"] }, { cookie });
    const truncated = payloadFixture("gitea-push");
    truncated.total_commits = 9;
    truncated.commits = truncated.commits.map((c: object) => ({ ...c, added: [], modified: ["README.md"] }));
    truncated.head_commit = truncated.commits[0];
    await deliver("gitea", hook, secret, "push", truncated);
    expect(fake.calls("git.example.com")).toContain(
      `GET /api/v1/repos/acme/shop/compare/4b2ae2a1f0d4c8b2d1f7e3c5a6b8d9e0f1a2b3c4...${giteaHead}`,
    );
    expect(deploymentsOf(id)).toHaveLength(1);

    fake.override((r) => (r.path.includes("/compare/") ? { status: 500, body: { message: "boom" } } : undefined));
    const next = { ...truncated, before: giteaHead, after: "3".repeat(40) };
    await deliver("gitea", hook, secret, "push", next);
    const all = deploymentsOf(id);
    expect(all).toHaveLength(2);
    const lines = logOf(all[1]?.id as string);
    expect(lines.some((l) => l.includes("asking Gitea for the changed files failed"))).toBe(true);
    expect(lines).toContain("Watch paths: none of the 1 changed files listed matches, but the list is incomplete, so this push deploys.");
  });

  test("a payload sha that is not the branch head is not built: the head is", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    const forged = payloadFixture("gitea-push");
    forged.after = "4".repeat(40);
    await deliver("gitea", hook, secret, "push", forged);
    const [d] = deploymentsOf(id);
    expect(d?.commitSha).toBe(giteaHead);
    expect(logOf(d?.id as string).some((l) => l.startsWith("The branch moved on"))).toBe(true);
  });

  test("other branches and deleted branches are ignored", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    await deliver("gitea", hook, secret, "push", { ...payloadFixture("gitea-push"), ref: "refs/heads/dev" });
    await deliver("gitea", hook, secret, "push", { ...payloadFixture("gitea-push"), after: "0".repeat(40) });
    expect(deploymentsOf(id)).toHaveLength(0);
    const details = (await deliveriesOf(id)).map((d) => d.detail);
    expect(details).toContain("Branch deleted.");
    expect(details.some((d) => d.startsWith("Branch dev is not deployed"))).toBe(true);
  });

  test("pull requests open previews (same env acknowledgement), and closing is checked with Gitea", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    const refused = await callOp(panel, previewOps.updateSettings, { serviceId: id, enabled: true }, { cookie });
    expect(refused.body.error.details.field).toBe("acknowledgeSharedEnv");
    await callOp(panel, previewOps.updateSettings, { serviceId: id, enabled: true, acknowledgeSharedEnv: true }, { cookie });
    await deliver("gitea", hook, secret, "pull_request", payloadFixture("gitea-pull-request"));
    const list = (await callOp(panel, previewOps.list, { serviceId: id }, { cookie })).body.previews;
    expect(list[0]).toMatchObject({ prNumber: 3, branch: "feat/checkout", commitSha: "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e" });
    const previewId = list[0].previewServiceId as string;
    expect(panel.deps.db.select().from(services).where(eq(services.id, previewId)).get()?.name).toBe("web-pr-3");
    // The preview has no webhook of its own.
    expect(panel.deps.db.select().from(gitProviderWebhooks).where(eq(gitProviderWebhooks.serviceId, previewId)).get()).toBeUndefined();

    // A "closed" payload for a request Gitea still shows open removes nothing.
    await deliver("gitea", hook, secret, "pull_request", { ...payloadFixture("gitea-pull-request"), action: "closed" });
    expect(panel.deps.db.select().from(services).where(eq(services.id, previewId)).get()).toBeDefined();
    fake.override((r) =>
      r.path === "/api/v1/repos/acme/shop/pulls/3" ? { body: { ...recordedPull(), state: "closed", merged: true } } : undefined,
    );
    await deliver("gitea", hook, secret, "pull_request", { ...payloadFixture("gitea-pull-request"), action: "closed", merged_at: "now" });
    expect(panel.deps.db.select().from(services).where(eq(services.id, previewId)).get()).toBeUndefined();
  });

  test("a pull request from a fork is not previewed", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    await callOp(panel, previewOps.updateSettings, { serviceId: id, enabled: true, acknowledgeSharedEnv: true }, { cookie });
    fake.override((r) =>
      r.path === "/api/v1/repos/acme/shop/pulls/3"
        ? { body: { ...recordedPull(), head: { ref: "main", sha: "6".repeat(40), repo: { full_name: "evil/shop" } } } }
        : undefined,
    );
    await deliver("gitea", hook, secret, "pull_request", payloadFixture("gitea-pull-request"));
    expect((await callOp(panel, previewOps.list, { serviceId: id }, { cookie })).body.previews).toHaveLength(0);
    expect((await deliveriesOf(id))[0]?.detail).toBe("Requests from forks are not previewed.");
  });
});

describe("one repository, several services", () => {
  test("the same signed body to each service's hook deploys each service; no replay is recorded", async () => {
    const first = await connectedService("gitea", "web");
    const second = await connectedService("gitea", "worker", first.providerId);
    expect(second.hook.id).not.toBe(first.hook.id);
    const body = payloadFixture("gitea-push");
    const a = await deliver("gitea", first.hook, first.secret, "push", body, { delivery: "gitea-delivery-1" });
    const b = await deliver("gitea", second.hook, second.secret, "push", body, { delivery: "gitea-delivery-2" });
    expect(a.body).toMatchObject({ ok: true, deployed: 1 });
    expect(b.body).toMatchObject({ ok: true, deployed: 1 });
    expect(deploymentsOf(first.id)).toHaveLength(1);
    expect(deploymentsOf(second.id)).toHaveLength(1);
    for (const id of [first.id, second.id]) {
      const list = await deliveriesOf(id);
      expect(list.some((d) => d.outcome === "rejected")).toBe(false);
      expect(list[0]).toMatchObject({ outcome: "deployed" });
    }
    // A real replay to one hook is still one.
    const again = await deliver("gitea", second.hook, second.secret, "push", body, { delivery: "gitea-delivery-3" });
    expect(again.body).toMatchObject({ duplicate: true });
    expect(deploymentsOf(second.id)).toHaveLength(1);
  });

  test("GitLab hooks of one push that share an event UUID (before 17.4) each deploy their service", async () => {
    const first = await connectedService("gitlab", "web");
    const second = await connectedService("gitlab", "worker", first.providerId);
    const body = payloadFixture("gitlab-push");
    await deliver("gitlab", first.hook, first.secret, "Push Hook", body, { delivery: "event-uuid-1" });
    await deliver("gitlab", second.hook, second.secret, "Push Hook", body, { delivery: "event-uuid-1" });
    expect(deploymentsOf(first.id)).toHaveLength(1);
    expect(deploymentsOf(second.id)).toHaveLength(1);
    // GitLab's own retry of the first hook's delivery is still a duplicate.
    const retry = await deliver("gitlab", first.hook, first.secret, "Push Hook", body, { delivery: "event-uuid-1" });
    expect(retry.body).toMatchObject({ duplicate: true });
  });
});

describe("pushes that come faster than deploys", () => {
  test("a push while a push deploy waits joins it: it builds the newest head, and nothing piles up", async () => {
    const { id, hook, secret } = await connectedService("gitlab");
    let head = gitlabHead;
    fake.override((r) =>
      r.path.endsWith("/repository/branches/main")
        ? { body: { name: "main", commit: { id: head, message: `Commit ${head.slice(0, 4)}\n`, author_name: "jdev" } } }
        : undefined,
    );
    const push = (sha: string) => {
      head = sha;
      return deliver("gitlab", hook, secret, "Push Hook", { ...payloadFixture("gitlab-push"), after: sha, checkout_sha: sha });
    };
    await push(gitlabHead);
    const [running] = deploymentsOf(id);
    expect(running?.status).not.toBe("queued");
    for (let i = 1; i <= 6; i++) await push(String(i).repeat(40));
    const all = deploymentsOf(id);
    expect(all).toHaveLength(2);
    const waiting = all.find((d) => d.id !== running?.id);
    expect(waiting).toMatchObject({ status: "queued", commitSha: "6".repeat(40), commitMessage: "Commit 6666" });
    expect(logOf(waiting?.id as string)).toContain(`A newer push arrived before this deploy started: it builds ${"6".repeat(7)} now.`);
    const details = (await deliveriesOf(id)).map((d) => d.detail);
    expect(details).toContain(`A deploy was already queued; it builds ${"6".repeat(7)} now.`);
  });

  test("a head polling finds while a deploy runs queues behind it, and a newer one takes the waiting deploy over", async () => {
    // No webhook: polling every minute is the only way pushes arrive.
    fake.override((r) => (r.method === "POST" && r.path.endsWith("/hooks") ? { status: 403, body: { message: "no" } } : undefined));
    const { id } = await connectedService("gitea");
    let head = giteaHead;
    fake.override((r) =>
      r.path === "/api/v1/repos/acme/shop/branches/main"
        ? { body: { name: "main", commit: { id: head, message: "Polled\n" } } }
        : undefined,
    );
    const start = Date.now();
    expect(await pollProviderBranches(panel.deps, start)).toBe(0);
    head = "5".repeat(40);
    expect(await pollProviderBranches(panel.deps, start + 61_000)).toBe(1);
    await fleet.settle();
    const [running] = deploymentsOf(id);
    expect(running).toMatchObject({ commitSha: head, trigger: "push" });
    expect(running?.status).not.toBe("queued");

    // The deploy of 5555555 still runs: the next head waits for it instead of being dropped.
    head = "6".repeat(40);
    expect(await pollProviderBranches(panel.deps, start + 122_000)).toBe(1);
    expect(deploymentsOf(id).find((d) => d.id !== running?.id)).toMatchObject({ status: "queued", commitSha: head });
    head = "7".repeat(40);
    expect(await pollProviderBranches(panel.deps, start + 183_000)).toBe(0);
    const all = deploymentsOf(id);
    expect(all).toHaveLength(2);
    expect(all.find((d) => d.id !== running?.id)).toMatchObject({ status: "queued", commitSha: head });
    expect((await deliveriesOf(id))[0]?.detail).toBe(`A deploy was already queued; it builds ${"7".repeat(7)} now.`);
  });

  test("checked deliveries are limited per hook far above a busy repository; past it they are answered 200 and left to polling", async () => {
    const { id, hook, secret } = await connectedService("gitlab");
    const other = await connectedService("gitlab", "worker");
    let head = gitlabHead;
    fake.override((r) =>
      r.path.endsWith("/repository/branches/main")
        ? { body: { name: "main", commit: { id: head, message: "Head\n", author_name: "jdev" } } }
        : undefined,
    );
    const headReads = () => fake.calls("gitlab.com").filter((c) => c.endsWith("/repository/branches/main")).length;
    // No refill while the test runs: every token is accounted for.
    const now = new Date("2026-11-07T12:00:00Z");
    setSystemTime(now);
    try {
      // Unchecked deliveries take no token (10: refused rows are kept 20 an hour, and the deferred ones below are counted too).
      for (let i = 0; i < 10; i++) {
        await deliver("gitlab", hook, secret, "Push Hook", payloadFixture("gitlab-push"), { badSecret: true });
      }
      // A bot rebasing a hundred merge requests, say. Before: 429 from the 121st on (from the 21st before that); GitLab does
      // not retry and turns a hook off after 4 failures in a row, after which every push is missed.
      const statuses: number[] = [];
      const bodies: unknown[] = [];
      const readsBefore = headReads();
      let readsHandled = 0;
      for (let i = 0; i < 124; i++) {
        if (i === 120) readsHandled = headReads() - readsBefore;
        if (i === 123) head = "7".repeat(40);
        const res = await deliver("gitlab", hook, secret, "Push Hook", { ...payloadFixture("gitlab-push"), event_n: i });
        statuses.push(res.status);
        bodies.push(res.body);
      }
      expect(statuses.filter((s) => s !== 200)).toEqual([]);
      expect(bodies.slice(120)).toEqual(Array(4).fill({ ok: true, deferred: true }));
      // Each handled push asked for the head; the deferred ones did not.
      expect(readsHandled).toBe(120);
      expect(headReads() - readsBefore).toBe(120);
      // The last push (7777777) was deferred: the next poll reads the head even though the hook just delivered.
      expect(deploymentsOf(id).some((d) => d.commitSha === head)).toBe(false);
      await pollProviderBranches(panel.deps, now.getTime() + 60_000);
      await fleet.settle();
      expect(deploymentsOf(id).some((d) => d.commitSha === head)).toBe(true);
      // Once: the turn after that is back to "the webhook works, no reads" (and the other hook's 5-minute safety net).
      const readsAfterPoll = headReads();
      await pollProviderBranches(panel.deps, now.getTime() + 120_000);
      expect(headReads()).toBe(readsAfterPoll);
    } finally {
      setSystemTime();
    }
    const listed = await deliveriesOf(id);
    expect(listed.filter((d) => d.detail.startsWith("Too many deliveries")).map((d) => [d.outcome, d.detail])).toEqual(
      Array(4).fill(["ignored", "Too many deliveries to this webhook: not handled; the branch head is read again within a minute."]),
    );
    // At most one deploy runs and one waits.
    expect(deploymentsOf(id).length).toBeLessThanOrEqual(2);
    // Another service's hook has its own budget.
    const fresh = await deliver("gitlab", other.hook, other.secret, "Push Hook", payloadFixture("gitlab-push"));
    expect(fresh.body).toMatchObject({ ok: true, deployed: 1 });
  });
});

function recordedPull() {
  return recorded("gitea").find((e) => e.request === "GET /api/v1/repos/acme/shop/pulls/3")?.body as Record<string, unknown>;
}

describe("GitLab", () => {
  test("the secret token checks the delivery; the build clones as oauth2", async () => {
    const { id, hook, secret } = await connectedService("gitlab");
    expect(fake.sent.find((r) => r.method === "POST" && r.path.endsWith("/hooks"))?.body).toMatchObject({
      token: secret,
      push_events: true,
    });
    const bad = await deliver("gitlab", hook, secret, "Push Hook", payloadFixture("gitlab-push"), { badSecret: true });
    expect(bad.status).toBe(401);
    const ok = await deliver("gitlab", hook, secret, "Push Hook", payloadFixture("gitlab-push"));
    expect(ok.body.deployed).toBe(1);
    expect(deploymentsOf(id)[0]).toMatchObject({ commitSha: gitlabHead, actor: "jdev" });
    expect(fleet.builds[0]?.request).toMatchObject({
      source: { source: { value: { url: "https://gitlab.com/acme/platform/shop.git", token: "glpat-token", username: "oauth2" } } },
    });
  });

  test("when GitLab does not say the branch head, the token's payload sha is not trusted: the build resolves it", async () => {
    const { id, hook, secret } = await connectedService("gitlab");
    fake.override((r) => (r.path.endsWith("/repository/branches/main") ? { status: 503, body: { message: "down" } } : undefined));
    await deliver("gitlab", hook, secret, "Push Hook", payloadFixture("gitlab-push"));
    const [d] = deploymentsOf(id);
    // The payload's sha is not used; the build's own lookup of the head fails too, so nothing is built.
    expect(d).toMatchObject({ commitSha: null, status: "failed" });
    expect(fleet.builds).toHaveLength(0);
    expect(logOf(d?.id as string).some((l) => l.includes("did not say the branch head"))).toBe(true);
  });

  test("merge requests with new commits open a preview from GitLab's own data; forks do not", async () => {
    const { id, hook, secret } = await connectedService("gitlab");
    await callOp(panel, previewOps.updateSettings, { serviceId: id, enabled: true, acknowledgeSharedEnv: true }, { cookie });
    await deliver("gitlab", hook, secret, "Merge Request Hook", payloadFixture("gitlab-merge-request"));
    const list = (await callOp(panel, previewOps.list, { serviceId: id }, { cookie })).body.previews;
    expect(list[0]).toMatchObject({ prNumber: 7, commitSha: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00", branch: "feat/checkout" });
    // The same head again (another event, so another body): nothing to deploy.
    await deliver("gitlab", hook, secret, "Merge Request Hook", { ...payloadFixture("gitlab-merge-request"), event_id: 2 });
    expect((await deliveriesOf(id))[0]?.detail).toBe("#7 has no new commits.");

    const fork = payloadFixture("gitlab-merge-request");
    fork.object_attributes.iid = 8;
    await deliver("gitlab", hook, secret, "Merge Request Hook", fork);
    expect((await deliveriesOf(id))[0]?.detail).toBe("Requests from forks are not previewed.");
  });
});

describe("Bitbucket", () => {
  test("files come from the diffstat: watch paths skip or deploy by them", async () => {
    const { id, hook, secret } = await connectedService("bitbucket");
    await callOp(panel, serviceOps.setWatchPaths, { serviceId: id, watchPaths: ["apps/web/**"] }, { cookie });
    await deliver("bitbucket", hook, secret, "repo:push", payloadFixture("bitbucket-push"), { delivery: "b-1" });
    expect(deploymentsOf(id)).toHaveLength(0);
    expect((await deliveriesOf(id))[0]).toMatchObject({ source: "bitbucket", outcome: "ignored" });
    expect(fake.calls("api.bitbucket.org")).toContain(
      "GET /2.0/repositories/acme-ws/shop/diffstat/9a6f3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a..1e5d8f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e",
    );

    await callOp(panel, serviceOps.setWatchPaths, { serviceId: id, watchPaths: ["apps/api/**"] }, { cookie });
    await deliver("bitbucket", hook, secret, "repo:push", payloadFixture("bitbucket-push"), { delivery: "b-2" });
    // The same body under a new id is a replay; a new push is a new body.
    expect(deploymentsOf(id)).toHaveLength(0);
    const fresh = payloadFixture("bitbucket-push");
    fresh.push.changes[0].new.target.date = "2026-11-05T10:05:00+00:00";
    await deliver("bitbucket", hook, secret, "repo:push", fresh, { delivery: "b-3" });
    const [d] = deploymentsOf(id);
    expect(d).toMatchObject({ commitSha: bitbucketHead });
    expect(logOf(d?.id as string)).toContain("Watch paths: apps/api/main.go matches apps/api/**.");
    expect(fleet.builds[0]?.request).toMatchObject({
      source: { source: { value: { url: "https://bitbucket.org/acme-ws/shop.git", token: "bb-token", username: "x-token-auth" } } },
    });
  });

  test("pull requests open previews with the full head hash", async () => {
    const { id, hook, secret } = await connectedService("bitbucket");
    await callOp(panel, previewOps.updateSettings, { serviceId: id, enabled: true, acknowledgeSharedEnv: true }, { cookie });
    await deliver("bitbucket", hook, secret, "pullrequest:created", payloadFixture("bitbucket-pullrequest"));
    const list = (await callOp(panel, previewOps.list, { serviceId: id }, { cookie })).body.previews;
    expect(list[0]).toMatchObject({ prNumber: 5, commitSha: "4f2a9c1e7b3d5a6c8e0f1a2b3c4d5e6f7a8b9c0d" });
  });
});

describe("webhook lifecycle", () => {
  test("changing the source or deleting the service removes the webhook from the provider", async () => {
    const first = await connectedService("gitea", "web");
    const second = await connectedService("gitlab", "api");
    await callOp(
      panel,
      serviceOps.setSource,
      { serviceId: first.id, source: { type: "image", image: "nginx:1", registryId: null } },
      { cookie },
    );
    expect(panel.deps.db.select().from(gitProviderWebhooks).where(eq(gitProviderWebhooks.serviceId, first.id)).get()).toBeUndefined();
    await callOp(panel, serviceOps.remove, { serviceId: second.id, confirmName: "api" }, { cookie });
    await panel.runner.runDue(panel.deps);
    expect(fake.calls()).toContain("DELETE /api/v1/repos/acme/shop/hooks/7");
    expect(fake.calls()).toContain("DELETE /api/v4/projects/acme%2Fplatform%2Fshop/hooks/1001");
    // A delivery to the removed hook is unknown now.
    const late = await deliver("gitea", first.hook, first.secret, "push", payloadFixture("gitea-push"));
    expect(late.status).toBe(404);
  });

  test("connecting another repository replaces the webhook; repair makes a new one; a used connection cannot be deleted", async () => {
    const { id, hook, providerId } = await connectedService("gitea");
    const repaired = await callOp(panel, providerOps.repairWebhook, { serviceId: id }, { cookie });
    expect(repaired.body.created).toBe(true);
    const now = panel.deps.db.select().from(gitProviderWebhooks).where(eq(gitProviderWebhooks.serviceId, id)).get();
    expect(now?.id).not.toBe(hook.id);
    await panel.runner.runDue(panel.deps);
    expect(fake.calls().filter((c) => c === "DELETE /api/v1/repos/acme/shop/hooks/7")).toHaveLength(1);
    const del = await callOp(panel, providerOps.remove, { providerId }, { cookie });
    expect(del.body.error).toMatchObject({ code: "CONFLICT" });
  });

  test("a webhook the provider refused at connect time is created by the next repair, then left alone for an hour", async () => {
    let refuse = true;
    fake.override((r) =>
      refuse && r.method === "POST" && r.path.endsWith("/hooks")
        ? { status: 403, body: { message: "token lacks write:repository" } }
        : undefined,
    );
    const { id } = await connectedService("gitea");
    expect((await callOp(panel, providerOps.webhook, { serviceId: id }, { cookie })).body).toMatchObject({ created: false });
    // Still refused: the try is spent, the next one waits an hour.
    const now = Date.now();
    expect(await repairHooks(panel.deps, now)).toBe(0);
    refuse = false;
    expect(await repairHooks(panel.deps, now + 60_000)).toBe(0);
    expect(await repairHooks(panel.deps, now + 61 * 60_000)).toBe(1);
    const status = await callOp(panel, providerOps.webhook, { serviceId: id }, { cookie });
    expect(status.body).toMatchObject({ created: true, error: null });
    expect(status.body.url).toStartWith("https://panel.example.com/api/hooks/gitea/");
    // A working hook on the domain is not touched again.
    const posts = fake.calls().filter((c) => c === "POST /api/v1/repos/acme/shop/hooks").length;
    expect(await repairHooks(panel.deps, now + 200 * 60_000)).toBe(0);
    expect(fake.calls().filter((c) => c === "POST /api/v1/repos/acme/shop/hooks")).toHaveLength(posts);
  });

  test("a working webhook is polled every 5 minutes as a safety net and not at all right after a delivery; a broken one every minute", async () => {
    const working = await connectedService("gitea", "web");
    const branchReads = () => fake.calls().filter((c) => c === "GET /api/v1/repos/acme/shop/branches/main").length;
    const start = Date.now();
    const before = branchReads();
    await pollProviderBranches(panel.deps, start);
    expect(branchReads()).toBe(before + 1);
    await pollProviderBranches(panel.deps, start + 60_000);
    expect(branchReads()).toBe(before + 1);
    await pollProviderBranches(panel.deps, start + 5 * 60_000);
    expect(branchReads()).toBe(before + 2);
    // A delivery proves the hook works: no poll inside the window after it.
    panel.deps.db
      .update(gitProviderWebhooks)
      .set({ lastDeliveryAt: new Date(start + 9 * 60_000) })
      .where(eq(gitProviderWebhooks.id, working.hook.id))
      .run();
    await pollProviderBranches(panel.deps, start + 11 * 60_000);
    expect(branchReads()).toBe(before + 2);

    // Without a created hook the branch is read every minute.
    panel.deps.db.update(gitProviderWebhooks).set({ remoteId: null }).where(eq(gitProviderWebhooks.id, working.hook.id)).run();
    await pollProviderBranches(panel.deps, start + 12 * 60_000);
    await pollProviderBranches(panel.deps, start + 13 * 60_000);
    expect(branchReads()).toBe(before + 4);
  });

  test("a provider that refuses the webhook leaves the reason; polling deploys missed pushes with watch paths", async () => {
    fake.override((r) =>
      r.method === "POST" && r.path.endsWith("/hooks") ? { status: 403, body: { message: "token lacks write:repository" } } : undefined,
    );
    const { id } = await connectedService("gitea");
    const status = await callOp(panel, providerOps.webhook, { serviceId: id }, { cookie });
    expect(status.body).toMatchObject({ created: false });
    expect(status.body.error).toContain("token lacks write:repository");

    await callOp(panel, serviceOps.setWatchPaths, { serviceId: id, watchPaths: ["apps/web/**"] }, { cookie });
    // The first poll only records the head.
    expect(await pollProviderBranches(panel.deps)).toBe(0);
    let head = giteaHead;
    fake.override((r) =>
      r.path === "/api/v1/repos/acme/shop/branches/main"
        ? { body: { name: "main", commit: { id: head, message: "Polled\n" } } }
        : undefined,
    );
    head = "5".repeat(40);
    fake.override((r) =>
      r.path.includes("/compare/")
        ? { body: { total_commits: 1, commits: [{ sha: head, files: [{ filename: "apps/web/a.ts", status: "modified" }] }] } }
        : undefined,
    );
    expect(await pollProviderBranches(panel.deps, Date.now() + 61_000)).toBe(1);
    await fleet.settle();
    expect(fake.calls()).toContain(`GET /api/v1/repos/acme/shop/compare/${giteaHead}...${head}`);
    expect(deploymentsOf(id)[0]).toMatchObject({ commitSha: head, trigger: "push" });
  });
});

describe("commit statuses", () => {
  test("a push deploy posts pending, running and success on the commit", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    await deliver("gitea", hook, secret, "push", payloadFixture("gitea-push"));
    const [d] = deploymentsOf(id);
    await panel.runner.runDue(panel.deps);
    fleet.deployProgress(nodeA, id, d?.generation as number, DeployStage.SUCCEEDED);
    await fleet.settle();
    await panel.runner.runDue(panel.deps);
    const live = (await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId: d?.id as string }, { cookie })).body.deployment;
    expect(live.status).toBe("live");
    const posted = fake.sent
      .filter((r) => r.method === "POST" && r.path === `/api/v1/repos/acme/shop/statuses/${giteaHead}`)
      .map((r) => r.body);
    expect(posted.at(-1)).toEqual({
      state: "success",
      context: "seylo/web",
      description: "Deployed",
      target_url: `https://panel.example.com/p/${projectId}/s/${id}/deployments`,
    });
    expect(posted.length).toBeGreaterThanOrEqual(1);
  });

  test("a failed deploy posts a fixed description, never the deploy's error", async () => {
    fleet.buildScript = () => ({ result: "failed", message: "node node-a: secret builder output" });
    const { id, hook, secret } = await connectedService("gitea");
    await deliver("gitea", hook, secret, "push", payloadFixture("gitea-push"));
    await panel.runner.runDue(panel.deps);
    const [d] = deploymentsOf(id);
    expect(d?.status).toBe("failed");
    const posted = fake.sent
      .filter((r) => r.method === "POST" && r.path === `/api/v1/repos/acme/shop/statuses/${giteaHead}`)
      .map((r) => r.body);
    expect(posted.at(-1)).toMatchObject({ state: "failure", description: "Deploy failed" });
    expect(JSON.stringify(posted)).not.toContain("secret builder output");
  });

  test("a queued deploy that a newer push took over marks its old commit superseded", async () => {
    const { id, hook, secret } = await connectedService("gitea");
    let head = giteaHead;
    fake.override((r) =>
      r.path === "/api/v1/repos/acme/shop/branches/main" ? { body: { name: "main", commit: { id: head, message: "x\n" } } } : undefined,
    );
    // Gitea answers a status on any commit.
    fake.override((r) => (r.method === "POST" && r.path.includes("/statuses/") ? { status: 201, body: { id: 1 } } : undefined));
    const push = (sha: string) => {
      head = sha;
      return deliver("gitea", hook, secret, "push", { ...payloadFixture("gitea-push"), after: sha });
    };
    await push(giteaHead);
    await push("7".repeat(40));
    const statusesOf = (sha: string) =>
      fake.sent.filter((r) => r.method === "POST" && r.path === `/api/v1/repos/acme/shop/statuses/${sha}`).map((r) => r.body);
    for (let i = 0; i < 50 && statusesOf("7".repeat(40)).length === 0; i++) {
      await panel.runner.runDue(panel.deps);
      await Bun.sleep(5);
    }
    expect(statusesOf("7".repeat(40)).at(-1)).toMatchObject({ state: "pending", description: "Deploy queued" });
    await push("8".repeat(40));
    // The status job may still be posting the first state; it picks the change up when it looks again.
    for (let i = 0; i < 50 && statusesOf("8".repeat(40)).length === 0; i++) {
      await panel.runner.runDue(panel.deps);
      await Bun.sleep(5);
    }
    expect(statusesOf("7".repeat(40)).at(-1)).toMatchObject({ state: "error", description: "Superseded by a newer push" });
    expect(statusesOf("8".repeat(40)).at(-1)).toMatchObject({ state: "pending" });
    expect(deploymentsOf(id)).toHaveLength(2);
  });

  test("a connection with statuses off posts none", async () => {
    const { id, hook, secret, providerId } = await connectedService("gitea");
    await callOp(panel, providerOps.update, { providerId, statusNotes: false }, { cookie });
    await deliver("gitea", hook, secret, "push", payloadFixture("gitea-push"));
    await panel.runner.runDue(panel.deps);
    expect(fake.sent.filter((r) => r.path.includes("/statuses/"))).toHaveLength(0);
    expect(deploymentsOf(id)).toHaveLength(1);
  });
});

describe("deploy trigger URL with watch paths", () => {
  test("a push payload in the body is checked; a matching one deploys with the reason in the log", async () => {
    const id = (
      await callOp(
        panel,
        serviceOps.create,
        { projectId, name: "api", kind: "app", nodeId: nodeA, source: { type: "image", image: "nginx:1", registryId: null } },
        { cookie },
      )
    ).body.id;
    await callOp(panel, serviceOps.setWatchPaths, { serviceId: id, watchPaths: ["services/api/**"] }, { cookie });
    const { url } = (await callOp(panel, webhooks.rotateTrigger, { serviceId: id }, { cookie })).body;
    const path = new URL(url, "http://panel.test").pathname;
    const post = (body: unknown) =>
      panel.app.handle(
        new Request(`http://panel.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    const skipped = await post({ changedFiles: ["web/index.html"] });
    expect(await skipped.json()).toMatchObject({
      queued: false,
      skipped: "Skipped by watch paths: the one changed file matches no pattern.",
    });
    const gitlabShaped = payloadFixture("gitlab-push");
    gitlabShaped.commits[1].added = ["services/api/main.go"];
    const deployed = (await (await post(gitlabShaped)).json()) as { deploymentId: string; queued: boolean };
    expect(deployed.queued).toBe(true);
    expect(logOf(deployed.deploymentId)).toContain("Watch paths: services/api/main.go matches services/api/**.");
    // A plain POST (no body) knows no files and deploys, as before.
    await fleet.settle();
    const rows = panel.deps.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.serviceId, id), eq(webhookDeliveries.outcome, "ignored")))
      .all();
    expect(rows).toHaveLength(1);
  });
});
