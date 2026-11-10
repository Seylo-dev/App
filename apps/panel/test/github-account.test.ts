// The panel's connected GitHub account as a real source (github/account.ts,
// repo-hooks.ts): a pasted token checked before it is saved and sealed,
// device logins and tokens replacing each other in place, whose token a
// service uses, repository lists from GET /user/repos paged and searched,
// cloning with the account's token, a repository webhook when the token
// and the panel allow it and branch polling otherwise, deliveries to that
// webhook, sharing with members, disconnecting, and PORT for apps built
// from a repository.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { git, github, projects, services as serviceOps, webhooks } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { auditLog, deployments, gitCredentials, githubRepoWebhooks, services } from "../src/db/schema";
import type { JobContext } from "../src/jobs/queue";
import { resolveBuild } from "../src/modules/deployments/source";
import { deploymentEnv, sealDeploymentEnv, withPortEnv } from "../src/modules/env/desired";
import { userRepoPages } from "../src/modules/github/account";
import { pollBranches } from "../src/modules/github/poll";
import { removeAccountHooks, removeRepoHookJob, repairRepoHooks } from "../src/modules/github/repo-hooks";
import { loadService } from "../src/modules/services/rows";
import { readSpec } from "../src/modules/services/spec";
import { setSetting } from "../src/settings";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

const tokens = {
  classic: `ghp_${"a".repeat(36)}`,
  classicNoRepo: `ghp_${"b".repeat(36)}`,
  fine: `github_pat_${"c".repeat(40)}`,
  fineNoRepos: `github_pat_${"d".repeat(40)}`,
  fineNoContents: `github_pat_${"e".repeat(40)}`,
  rejected: `ghp_${"z".repeat(36)}`,
  device: `gho_${"f".repeat(36)}`,
  /** Another person's classic token (login sam), who administers none of acme's repositories. */
  sam: `ghp_${"g".repeat(36)}`,
};

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;
const realFetch = globalThis.fetch;
let calls: { method: string; path: string; search: string; auth: string; body: unknown }[];
let hookSecret: string | null;
/** How many repositories /user/repos holds besides acme/shop (paged by 100). */
let extraRepos: number;
const head = "1111111111111111111111111111111111111111";

function repoList(token: string) {
  if (token === tokens.fineNoRepos) return [];
  const shop = { full_name: "acme/shop", private: true, default_branch: "main", pushed_at: new Date().toISOString() };
  const rest = Array.from({ length: extraRepos }, (_, i) => ({
    full_name: `acme/repo-${String(i + 1).padStart(3, "0")}`,
    private: false,
    default_branch: "main",
    pushed_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
  }));
  return [shop, ...rest];
}

function fakeGithub() {
  calls = [];
  hookSecret = null;
  extraRepos = 2;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host !== "api.github.com") return realFetch(input, init);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = (headers.authorization ?? "").replace(/^Bearer /, "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, search: url.search, auth, body });
    const json = (status: number, data: unknown, extra: Record<string, string> = {}) =>
      new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });
    if (auth === tokens.rejected) return json(401, { message: "Bad credentials" });
    if (url.pathname === "/user") {
      const scopes: Record<string, string> = {
        [tokens.classic]: "repo, read:org",
        [tokens.classicNoRepo]: "read:user",
        [tokens.device]: "repo",
        [tokens.sam]: "repo",
      };
      return json(200, { login: auth === tokens.sam ? "sam" : "lee" }, auth in scopes ? { "x-oauth-scopes": scopes[auth] as string } : {});
    }
    if (url.pathname === "/user/repos") {
      expect(url.searchParams.get("affiliation")).toBe("owner,collaborator,organization_member");
      const all = repoList(auth);
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = all.slice((page - 1) * per, page * per);
      const more = all.length > page * per;
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return json(200, slice, more ? { link: `<${next.href}>; rel="next"` } : {});
    }
    if (method === "GET" && url.pathname === "/repos/acme/shop/commits" && url.searchParams.get("per_page") === "1") {
      return auth === tokens.fineNoContents ? json(403, { message: "Resource not accessible by personal access token" }) : json(200, []);
    }
    // Someone else's public repository: GitHub answers any token, with read access only.
    if (url.pathname === "/repos/louislam/uptime-kuma")
      return json(200, {
        full_name: "louislam/uptime-kuma",
        default_branch: "master",
        private: false,
        permissions: { admin: false, push: false, pull: true },
      });
    if (url.pathname === "/repos/louislam/uptime-kuma/branches") return json(200, [{ name: "master" }]);
    if (url.pathname.startsWith("/repos/louislam/uptime-kuma/branches/")) return json(200, { name: "master" });
    // A public fork lee may push to, and a public repository of lee's organization (in /user/repos).
    if (url.pathname === "/repos/lee/fork")
      return json(200, {
        full_name: "lee/fork",
        default_branch: "main",
        private: false,
        permissions: { admin: false, push: true, pull: true },
      });
    if (url.pathname === "/repos/acme/repo-001")
      return json(200, {
        full_name: "acme/repo-001",
        default_branch: "main",
        private: false,
        permissions: { admin: false, push: false, pull: true },
      });
    // acme/shop has a Dockerfile at its root on main; acme/repo-001 does not.
    if (url.pathname === "/repos/acme/shop/contents/Dockerfile")
      return url.searchParams.get("ref") === "main" ? json(200, { name: "Dockerfile", type: "file" }) : json(404, { message: "Not Found" });
    if (url.pathname === "/repos/acme/repo-001/contents/Dockerfile") return json(404, { message: "Not Found" });
    if (url.pathname === "/repos/lee/fork/branches" || url.pathname === "/repos/acme/repo-001/branches")
      return json(200, [{ name: "main" }]);
    // The token's hourly requests are used up (403) or a secondary limit hit (429).
    if (url.pathname.startsWith("/repos/acme/busy"))
      return json(
        403,
        { message: "API rate limit exceeded for user ID 1." },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" },
      );
    if (url.pathname.startsWith("/repos/acme/burst"))
      return json(429, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "60" });
    if (url.pathname.startsWith("/repos/acme/repo-")) return json(200, []);
    if (url.pathname === "/repos/acme/shop") return json(200, { default_branch: "main" });
    if (url.pathname === "/repos/acme/shop/branches") return json(200, [{ name: "main" }, { name: "dev" }]);
    if (url.pathname.startsWith("/repos/acme/shop/branches/")) return json(200, { name: "main" });
    if (url.pathname.startsWith("/repos/acme/shop/commits/")) {
      const ref = decodeURIComponent(url.pathname.split("/commits/")[1] ?? "");
      const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : head;
      return json(
        200,
        { sha, commit: { message: "Ship it\n\nbody", author: { name: "Dev" } }, author: { login: "dev" } },
        { etag: `"${sha}"` },
      );
    }
    if (method === "POST" && url.pathname === "/repos/acme/shop/hooks") {
      if (auth.startsWith("github_pat_")) return json(403, { message: "Resource not accessible by personal access token" });
      hookSecret = (body as { config: { secret: string } }).config.secret;
      return json(201, { id: auth === tokens.sam ? 992 : 991 });
    }
    // sam's token cannot see the hooks of a repository sam does not administer.
    if (method === "DELETE" && url.pathname.startsWith("/repos/acme/shop/hooks/") && auth === tokens.sam)
      return json(404, { message: "Not Found" });
    if (method === "DELETE" && url.pathname === "/repos/acme/shop/hooks/991") return json(204, null);
    return json(404, { message: "Not Found" });
  }) as typeof fetch;
}

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a", { canBuild: true, panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  fakeGithub();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  panel.close();
});

function loadAccount(id: string) {
  const row = panel.deps.db.select().from(gitCredentials).where(eq(gitCredentials.id, id)).get();
  if (!row) throw new Error("no account row");
  return row;
}

async function connect(token = tokens.classic) {
  const res = await callOp(panel, github.tokenConnect, { token }, { cookie });
  return res;
}

async function app(name = "web", ports = [{ containerPort: 8080, protocol: "tcp" as const }]) {
  return (await callOp(panel, serviceOps.create, { projectId, name, kind: "app", nodeId: nodeA, ports }, { cookie })).body.id as string;
}

async function connectRepo(serviceId: string, accountId: string, as = cookie) {
  return callOp(panel, github.connectRepo, { serviceId, accountId, repo: "acme/shop", branch: "main", deployOnPush: true }, { cookie: as });
}

describe("Use a token", () => {
  test("a classic token with the repo scope is checked, sealed and becomes the account card", async () => {
    const res = await connect();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ login: "lee", method: "token", tokenKind: "classic", scopes: ["repo", "read:org"] });
    expect(calls.some((c) => c.path === "/user" && c.auth === tokens.classic)).toBe(true);
    const row = panel.deps.db.select().from(gitCredentials).where(eq(gitCredentials.id, res.body.id)).get();
    expect(row).toMatchObject({ origin: "github_token", host: "github.com", githubLogin: "lee" });
    // Sealed with master.key: never stored as written, and it opens to the token.
    expect(row?.secretSealed).not.toContain(tokens.classic);
    expect(panel.deps.secrets.open(row?.secretSealed ?? "", "git.credential")).toBe(tokens.classic);
    expect((await callOp(panel, github.status, {}, { cookie })).body.account).toMatchObject({ id: res.body.id, method: "token" });
    // The audit log keeps the op, never the token.
    const audit = JSON.stringify(panel.deps.db.select().from(auditLog).all());
    expect(audit).toContain("github.tokenConnect");
    expect(audit).not.toContain(tokens.classic);
  });

  test("a fine-grained token that reads a repository's code is accepted without scopes", async () => {
    const res = await connect(tokens.fine);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ login: "lee", tokenKind: "fineGrained", scopes: [] });
    expect(calls.some((c) => c.path === "/repos/acme/shop/commits" && c.search.includes("per_page=1"))).toBe(true);
  });

  test("tokens GitHub refuses, without the repo scope, reaching no repository or no code are not saved", async () => {
    const cases: [string, string][] = [
      [tokens.rejected, "rejected"],
      [tokens.classicNoRepo, "scope"],
      [tokens.fineNoRepos, "noRepos"],
      [tokens.fineNoContents, "contents"],
    ];
    for (const [token, reason] of cases) {
      const res = await connect(token);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toMatchObject({ field: "token", reason });
    }
    expect(panel.deps.db.select().from(gitCredentials).all()).toHaveLength(0);
  });

  test("a token replaces a device login in place, so services keep their account", async () => {
    const device = panel.deps.db
      .insert(gitCredentials)
      .values({
        name: "GitHub (lee)",
        kind: "token",
        host: "github.com",
        username: "lee",
        secretSealed: panel.deps.secrets.seal(tokens.device, "git.credential"),
        origin: "device",
        githubLogin: "lee",
        scopes: "repo",
      })
      .returning()
      .get();
    const res = await connect(tokens.fine);
    expect(res.body.id).toBe(device.id);
    expect(panel.deps.db.select().from(gitCredentials).all()).toHaveLength(1);
    expect((await callOp(panel, github.status, {}, { cookie })).body.account).toMatchObject({ method: "token", tokenKind: "fineGrained" });
  });

  test("only github.manage connects a token; members see who the account is, never its token", async () => {
    const member = await createUser(panel, "member");
    expect((await callOp(panel, github.tokenConnect, { token: tokens.classic }, { cookie: member.cookie })).status).toBe(403);
    const { body } = await connect();
    // A member with no grants sees nothing; one who may create services somewhere sees the account's login.
    expect((await callOp(panel, github.installations, {}, { cookie: member.cookie })).body).toMatchObject({ account: null, hidden: true });
    grant(panel, member.user.id, "project", projectId, ["services.create", "services.update"]);
    expect((await callOp(panel, github.installations, {}, { cookie: member.cookie })).body.account).toEqual({ id: body.id, login: "lee" });
    expect((await callOp(panel, github.status, {}, { cookie: member.cookie })).body.account).toBeNull();
  });
});

describe("the account as a source", () => {
  test("repositories come from /user/repos, every page of 100, then 30 at a time and searchable", async () => {
    extraRepos = 249;
    const { body: account } = await connect();
    const first = await callOp(panel, github.repos, { projectId, accountId: account.id }, { cookie });
    expect(first.status).toBe(200);
    expect(first.body.repos).toHaveLength(30);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.repos[0]).toMatchObject({ fullName: "acme/shop", private: true, defaultBranch: "main" });
    const lists = calls.filter((c) => c.path === "/user/repos" && c.search.includes("per_page=100"));
    expect(lists.map((c) => new URLSearchParams(c.search).get("page") ?? "1")).toEqual(["1", "2", "3"]);
    const last = await callOp(panel, github.repos, { projectId, accountId: account.id, page: 9 }, { cookie });
    expect(last.body).toMatchObject({ hasMore: false });
    expect(last.body.repos).toHaveLength(10);
    // Answers are kept for a minute: a search reads no page again.
    const found = await callOp(panel, github.repos, { projectId, accountId: account.id, query: "repo-24" }, { cookie });
    expect(found.body.repos.map((r: { fullName: string }) => r.fullName)).toEqual([
      "acme/repo-240",
      "acme/repo-241",
      "acme/repo-242",
      "acme/repo-243",
      "acme/repo-244",
      "acme/repo-245",
      "acme/repo-246",
      "acme/repo-247",
      "acme/repo-248",
      "acme/repo-249",
    ]);
    expect(calls.filter((c) => c.path === "/user/repos" && c.search.includes("per_page=100"))).toHaveLength(3);
    expect(userRepoPages).toBe(10);
  });

  test("detectBuilder: a Dockerfile at the root on the branch, best effort", async () => {
    const { body: account } = await connect();
    const ask = (repo: string, branch: string) =>
      callOp(panel, github.detectBuilder, { projectId, accountId: account.id, repo, branch }, { cookie });
    expect((await ask("acme/shop", "main")).body).toEqual({ dockerfile: true });
    expect((await ask("acme/shop", "dev")).body).toEqual({ dockerfile: false });
    expect((await ask("acme/repo-001", "main")).body).toEqual({ dockerfile: false });
    // GitHub not answering (rate limited) is no Dockerfile, not an error for the form.
    expect((await ask("acme/busy", "main")).body).toEqual({ dockerfile: false });
    expect(calls.find((c) => c.path === "/repos/acme/shop/contents/Dockerfile")?.search).toBe("?ref=main");
  });

  test("branches and installationId or accountId, exactly one", async () => {
    const { body: account } = await connect();
    const res = await callOp(panel, github.branches, { projectId, accountId: account.id, repo: "acme/shop" }, { cookie });
    expect(res.body).toEqual({ defaultBranch: "main", branches: ["main", "dev"] });
    expect((await callOp(panel, github.branches, { projectId, repo: "acme/shop" }, { cookie })).status).toBe(400);
    const stale = await callOp(panel, github.branches, { projectId, accountId: "c000000000000000", repo: "acme/shop" }, { cookie });
    expect(stale.status).toBe(404);
    const missing = await callOp(panel, github.branches, { projectId, accountId: account.id, repo: "acme/gone" }, { cookie });
    expect(missing.status).toBe(404);
    expect(missing.body.error.details).toMatchObject({ field: "repo" });
    expect(missing.body.error.message).toContain("@lee");
  });

  test("a public repository that is not the account's is not read through it; its own, a fork it pushes to and its org's are", async () => {
    const { body: account } = await connect();
    const branchesOf = (repo: string) => callOp(panel, github.branches, { projectId, accountId: account.id, repo }, { cookie });
    const other = await branchesOf("louislam/uptime-kuma");
    expect(other.status).toBe(404);
    expect(other.body.error.details).toMatchObject({ field: "repo", reason: "notOwned" });
    expect(other.body.error.message).toContain("@lee");
    expect((await branchesOf("lee/fork")).body).toEqual({ defaultBranch: "main", branches: ["main"] });
    expect((await branchesOf("acme/repo-001")).body).toEqual({ defaultBranch: "main", branches: ["main"] });
    expect((await branchesOf("acme/shop")).status).toBe(200);
    // connectRepo makes the same check: no account source (and no webhook, no polling) for it.
    const id = await app();
    const refused = await callOp(
      panel,
      github.connectRepo,
      { serviceId: id, accountId: account.id, repo: "louislam/uptime-kuma", branch: "master", deployOnPush: true },
      { cookie },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toMatchObject({ field: "repo", reason: "notOwned" });
    expect(readSpec(loadService(panel.deps.db, id).spec).source.type).toBe("none");
  });

  test("a rate-limited token is UNAVAILABLE, never 'no such repository'", async () => {
    const { body: account } = await connect();
    for (const repo of ["acme/busy", "acme/burst"]) {
      const res = await callOp(panel, github.branches, { projectId, accountId: account.id, repo }, { cookie });
      expect(res.status).toBe(503);
      expect(res.body.error.details).toMatchObject({ field: "repo", reason: "rateLimited" });
      expect(res.body.error.message).toContain("rate limiting the connected GitHub account (@lee)");
      const id = await app(repo.replace("/", "-"));
      const connectRes = await callOp(
        panel,
        github.connectRepo,
        { serviceId: id, accountId: account.id, repo, branch: "main", deployOnPush: true },
        { cookie },
      );
      expect(connectRes.status).toBe(503);
      expect(connectRes.body.error.details).toMatchObject({ reason: "rateLimited" });
    }
    // A permission 403 still says the account cannot read it.
    const denied = await callOp(panel, github.branches, { projectId, accountId: account.id, repo: "acme/gone" }, { cookie });
    expect(denied.status).toBe(404);
  });

  test("a service stores the account on its source and clones with its token and login", async () => {
    const { body: account } = await connect();
    const id = await app();
    const res = await connectRepo(id, account.id);
    expect(res.status).toBe(200);
    expect(res.body.sourceConfig).toEqual({
      type: "github",
      installationId: null,
      accountId: account.id,
      repo: "acme/shop",
      branch: "main",
      deployOnPush: true,
    });
    const service = loadService(panel.deps.db, id);
    const resolved = await resolveBuild(panel.deps, {
      service,
      spec: readSpec(service.spec),
      buildId: "b1",
      generation: 1,
      commitSha: null,
      uploadId: null,
    });
    expect(resolved.request.source?.source).toMatchObject({
      case: "git",
      value: { url: "https://github.com/acme/shop.git", commit: head, token: tokens.classic, username: "lee" },
    });
    expect(resolved.commit).toMatchObject({ sha: head, message: "Ship it", branch: "main" });
  });

  test("with a panel domain and a token that may, a repository webhook takes the pushes", async () => {
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    const { body: account } = await connect();
    const id = await app();
    await connectRepo(id, account.id);
    const create = calls.find((c) => c.method === "POST" && c.path === "/repos/acme/shop/hooks");
    expect(create?.auth).toBe(tokens.classic);
    expect(create?.body).toMatchObject({ events: ["push", "pull_request"], config: { content_type: "json", insecure_ssl: "0" } });
    const row = panel.deps.db.select().from(githubRepoWebhooks).where(eq(githubRepoWebhooks.serviceId, id)).get();
    expect(row).toMatchObject({ remoteId: "991", error: null, url: `https://panel.example.com/api/hooks/github-repo/${row?.id}` });
    expect((await callOp(panel, github.repoWebhook, { serviceId: id }, { cookie })).body).toMatchObject({
      configured: true,
      created: true,
      error: null,
    });

    // A webhook that delivers leaves the branch to the 5-minute safety net.
    calls = [];
    await pollBranches(panel.deps, { safetyNet: false });
    expect(calls.filter((c) => c.path.startsWith("/repos/acme/shop/commits/"))).toHaveLength(0);

    // A signed delivery deploys the service; a wrong signature is refused.
    const sha = "2222222222222222222222222222222222222222";
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      after: sha,
      repository: { full_name: "acme/shop" },
      head_commit: { id: sha, message: "Fix\n\nmore", author: { username: "dev" } },
      sender: { login: "dev" },
    });
    const deliver = (secret: string) =>
      panel.app.handle(
        new Request(`http://panel.test/api/hooks/github-repo/${row?.id}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "push",
            "x-github-delivery": crypto.randomUUID(),
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
          },
          body: payload,
        }),
      );
    expect((await deliver("wrong")).status).toBe(401);
    const ok = await deliver(hookSecret ?? "");
    expect(await ok.json()).toMatchObject({ ok: true, deployed: 1 });
    await fleet.settle();
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).get()).toMatchObject({
      commitSha: sha,
      trigger: "push",
    });
    expect(fleet.builds[0]?.request).toMatchObject({ source: { source: { case: "git", value: { token: tokens.classic } } } });
  });

  test("without a panel domain, or when GitHub refuses the webhook, the branch is polled every minute", async () => {
    const { body: account } = await connect();
    const id = await app();
    await connectRepo(id, account.id);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/hooks"))).toBe(false);
    expect((await callOp(panel, github.repoWebhook, { serviceId: id }, { cookie })).body).toMatchObject({
      configured: true,
      created: false,
      error: expect.stringContaining("no domain"),
    });
    calls = [];
    await pollBranches(panel.deps, { safetyNet: false });
    expect(calls.filter((c) => c.path === "/repos/acme/shop/commits/main" && c.auth === tokens.classic)).toHaveLength(1);

    // A fine-grained token without Webhooks: Read and write: GitHub says no, the reason is kept, polling goes on.
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    await connect(tokens.fine);
    const other = await app("api");
    await connectRepo(other, account.id);
    const refused = await callOp(panel, github.repoWebhook, { serviceId: other }, { cookie });
    expect(refused.body).toMatchObject({ created: false, error: expect.stringContaining("Webhooks: Read and write") });
    calls = [];
    await pollBranches(panel.deps, { safetyNet: false });
    expect(calls.filter((c) => c.path === "/repos/acme/shop/commits/main")).toHaveLength(2);
  });

  test("a classic token without a hook scope never asks GitHub for a webhook", async () => {
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    // Stored as a device login with a narrower scope list, the way an older connect may have left it.
    const { body: account } = await connect();
    panel.deps.db.update(gitCredentials).set({ scopes: "read:org" }).where(eq(gitCredentials.id, account.id)).run();
    const id = await app();
    await connectRepo(id, account.id);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/hooks"))).toBe(false);
    expect((await callOp(panel, github.repoWebhook, { serviceId: id }, { cookie })).body.error).toContain("may not create webhooks");
  });

  test("members use the account only where an admin shared a repository through it", async () => {
    const { body: account } = await connect();
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "project", projectId, ["services.create", "services.update", "services.view"]);
    const refused = await callOp(panel, github.repos, { projectId, accountId: account.id }, { cookie: member.cookie });
    expect(refused.status).toBe(403);
    await connectRepo(await app(), account.id);
    const shared = await callOp(panel, github.repos, { projectId, accountId: account.id }, { cookie: member.cookie });
    expect(shared.body.repos.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/shop"]);
    const theirs = await app("theirs");
    expect((await connectRepo(theirs, account.id, member.cookie)).status).toBe(200);
  });

  test("disconnecting removes the webhooks it made; connecting again keeps services building", async () => {
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    const { body: account } = await connect();
    const id = await app();
    await connectRepo(id, account.id);
    expect((await callOp(panel, github.deviceDisconnect, {}, { cookie })).status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/repos/acme/shop/hooks/991" && c.auth === tokens.classic)).toBe(true);
    expect(panel.deps.db.select().from(githubRepoWebhooks).all()).toHaveLength(0);
    const build = async () => {
      const service = loadService(panel.deps.db, id);
      return resolveBuild(panel.deps, {
        service,
        spec: readSpec(service.spec),
        buildId: "b",
        generation: 1,
        commitSha: head,
        uploadId: null,
      });
    };
    await expect(build()).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "noGithubAccount" } });
    // A new account (another id): the source's stored id is gone, so the account connected now reads it.
    const again = await connect(tokens.fine);
    expect(again.body.id).not.toBe(account.id);
    expect((await build()).request.source?.source).toMatchObject({ case: "git", value: { token: tokens.fine } });
  });
});

describe("another GitHub login replacing the account", () => {
  test("removes the old login's webhooks with its token first, then creates them again with the new one", async () => {
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    const { body: account } = await connect();
    const id = await app();
    await connectRepo(id, account.id);
    expect(panel.deps.db.select().from(githubRepoWebhooks).get()).toMatchObject({ remoteId: "991", createdLogin: "lee" });

    calls = [];
    const replaced = await connect(tokens.sam);
    expect(replaced.body).toMatchObject({ id: account.id, login: "sam" });
    // lee's token removed lee's webhook while the panel still had it.
    expect(calls.filter((c) => c.method === "DELETE").map((c) => [c.path, c.auth])).toEqual([
      ["/repos/acme/shop/hooks/991", tokens.classic],
    ]);
    const waiting = panel.deps.db.select().from(githubRepoWebhooks).get();
    expect(waiting).toMatchObject({ credentialId: account.id, remoteId: null, createdLogin: null });
    expect(waiting?.error).toContain("@sam");
    expect((await callOp(panel, github.repoWebhook, { serviceId: id }, { cookie })).body).toMatchObject({ created: false });

    // The poll schedule creates it again with sam's token.
    expect(await repairRepoHooks(panel.deps)).toBe(1);
    expect(calls.find((c) => c.method === "POST" && c.path === "/repos/acme/shop/hooks")?.auth).toBe(tokens.sam);
    expect(panel.deps.db.select().from(githubRepoWebhooks).get()).toMatchObject({ remoteId: "992", createdLogin: "sam", error: null });

    // A new token of the same login keeps the webhooks as they are.
    calls = [];
    await connect(tokens.sam);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(panel.deps.db.select().from(githubRepoWebhooks).get()).toMatchObject({ remoteId: "992" });
  });

  test("a webhook another login created is never counted as removed by a 404 to the current token", async () => {
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    const { body: account } = await connect();
    const id = await app();
    await connectRepo(id, account.id);
    // The account row now holds sam's token without the hooks being released (a row an older panel left).
    panel.deps.db
      .update(gitCredentials)
      .set({ githubLogin: "sam", username: "sam", secretSealed: panel.deps.secrets.seal(tokens.sam, "git.credential") })
      .where(eq(gitCredentials.id, account.id))
      .run();
    const warnings: string[] = [];
    const logger = { ...panel.deps.logger, warn: (_meta: unknown, message: string) => void warnings.push(message) };
    calls = [];
    await removeRepoHookJob.run({ credentialId: account.id, repo: "acme/shop", remoteId: "991", login: "lee" }, {
      ...panel.deps,
      logger,
      jobId: "test",
      attempt: 1,
    } as JobContext);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(warnings.join(" ")).toContain("could not be removed");

    warnings.length = 0;
    await removeAccountHooks({ ...panel.deps, logger } as typeof panel.deps, loadAccount(account.id));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(warnings.join(" ")).toContain("could not be removed");
    expect(panel.deps.db.select().from(githubRepoWebhooks).all()).toHaveLength(0);
  });
});

describe("PORT for apps built from a repository", () => {
  const git = { type: "git" as const, url: "https://github.com/acme/shop.git", branch: "main", credentialId: null, deployOnPush: false };
  const ports = [{ containerPort: 80, protocol: "tcp" as const }];
  const plain = { kind: "app", parentId: null };

  test("gets its first port as PORT", () => {
    expect(withPortEnv([{ name: "A", value: "1", secret: false }], plain, { source: git, ports })).toEqual([
      { name: "A", value: "1", secret: false },
      { name: "PORT", value: "80", secret: false },
    ]);
    const github = { type: "github" as const, installationId: null, accountId: "a", repo: "acme/shop", branch: "main", deployOnPush: true };
    expect(withPortEnv([], plain, { source: github, ports: [{ containerPort: 3000, protocol: "tcp" }] })).toEqual([
      { name: "PORT", value: "3000", secret: false },
    ]);
  });

  test("80 when the app names no port, which is where a new domain points too", () => {
    expect(withPortEnv([], plain, { source: git, ports: [] })).toEqual([{ name: "PORT", value: "80", secret: false }]);
  });

  test("keeps a PORT the service sets, and leaves images, members and crons alone", () => {
    const own = [{ name: "PORT", value: "5000", secret: false }];
    expect(withPortEnv(own, plain, { source: git, ports })).toEqual(own);
    expect(withPortEnv([], plain, { source: { type: "image", image: "nginx:1.27", registryId: null }, ports })).toEqual([]);
    expect(withPortEnv([], { kind: "app", parentId: "stack" }, { source: git, ports })).toEqual([]);
    expect(withPortEnv([], { kind: "cron", parentId: null }, { source: git, ports })).toEqual([]);
  });

  test("is part of the env a deploy starts with", async () => {
    const { body: account } = await connect();
    const id = await app("site", [{ containerPort: 8080, protocol: "tcp" }]);
    await connectRepo(id, account.id);
    expect(deploymentEnv(panel.deps, sealDeploymentEnv(panel.deps, id))).toContainEqual({ name: "PORT", value: "8080", secret: false });
    // An image app gets none.
    const image = await app("img");
    await callOp(
      panel,
      serviceOps.setSource,
      { serviceId: image, source: { type: "image", image: "nginx:1.27", registryId: null } },
      { cookie },
    );
    expect(deploymentEnv(panel.deps, sealDeploymentEnv(panel.deps, image))?.some((v) => v.name === "PORT")).toBe(false);
  });

  test("an app created before 0.2.2 gets PORT on its next deploy too, 80 when it has no port", async () => {
    // Before (0.2.2): no PORT for it, so a Next.js app kept listening on 3000 behind a domain on 80.
    const { body: account } = await connect();
    const id = await app("old");
    await connectRepo(id, account.id);
    // A row an older panel wrote has no portEnv key.
    const { portEnv: _, ...older } = readSpec(loadService(panel.deps.db, id).spec);
    panel.deps.db
      .update(services)
      .set({ spec: { ...older, ports: [] } })
      .where(eq(services.id, id))
      .run();
    expect(readSpec(loadService(panel.deps.db, id).spec).portEnv).toBe(false);
    expect(deploymentEnv(panel.deps, sealDeploymentEnv(panel.deps, id))).toContainEqual({ name: "PORT", value: "80", secret: false });
  });
});

// Found by the 0.2.2 docs check: the account row is a git credential too, and
// Settings > Git providers offered Edit and Delete for a token-connected one,
// which skipped the GitHub check and the account's webhooks. And Retry failed
// on an account source's deliveries searched the App's and sent nothing again.
describe("the account is managed on Settings > GitHub only", () => {
  test("git.updateCredential and git.deleteCredential refuse the account row", async () => {
    const { body: account } = await connect();
    const update = await callOp(panel, git.updateCredential, { credentialId: account.id, token: "ghp_other" }, { cookie });
    expect(update.status).toBe(409);
    expect(update.body.error.details?.reason).toBe("githubAccount");
    const del = await callOp(panel, git.deleteCredential, { credentialId: account.id }, { cookie });
    expect(del.status).toBe(409);
    expect(panel.deps.secrets.open(loadAccount(account.id).secretSealed, "git.credential")).toBe(tokens.classic);
  });

  test("deliveries of an account source cannot be sent again, and say why", async () => {
    const { body: account } = await connect();
    const id = await app();
    await connectRepo(id, account.id);
    const list = await callOp(panel, webhooks.listDeliveries, { serviceId: id }, { cookie });
    expect(list.status).toBe(200);
    expect(list.body.deliveries.every((d: { canRedeliver: boolean }) => !d.canRedeliver)).toBe(true);
    const res = await callOp(panel, webhooks.redeliver, { serviceId: id }, { cookie });
    expect(res.status).toBe(409);
    expect(res.body.error.details?.reason).toBe("notApp");
  });
});
