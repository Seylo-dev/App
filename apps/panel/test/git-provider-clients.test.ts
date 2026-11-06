// The GitLab, Gitea and Bitbucket API clients against recorded answers,
// and the HTTP rules every provider request follows (vetted and pinned
// address, no redirects, the connection's own host only).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gitProviders } from "../src/db/schema";
import { clientFor } from "../src/modules/gitProviders/client";
import { apiRequest, setProviderFetch } from "../src/modules/gitProviders/http";
import type { ProviderRow } from "../src/modules/gitProviders/rows";
import { setTargetResolver } from "../src/modules/uptime/targets";
import { FakeProviders, fakeAddress, recorded } from "./git-provider-fakes";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fake: FakeProviders;

beforeEach(() => {
  panel = testPanel();
  fake = new FakeProviders({
    "gitlab.com": recorded("gitlab"),
    "git.example.com": recorded("gitea"),
    "api.bitbucket.org": recorded("bitbucket"),
  });
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  panel.close();
});

function row(values: Partial<ProviderRow> & Pick<ProviderRow, "kind" | "url">): ProviderRow {
  return panel.deps.db
    .insert(gitProviders)
    .values({ name: values.kind, tokenSealed: panel.deps.secrets.seal("tok-secret", "git.provider"), ...values })
    .returning()
    .get();
}

describe("GitLab", () => {
  const client = () => clientFor(panel.deps, row({ kind: "gitlab", url: "https://gitlab.com" }));

  test("whoami, repositories and branches with PRIVATE-TOKEN on the API host", async () => {
    const c = client();
    expect(await c.whoami()).toBe("project_42_bot_3f2a");
    const sent = fake.sent[0];
    expect(sent).toMatchObject({ method: "GET", host: "gitlab.com", address: fakeAddress, path: "/api/v4/user" });
    expect(sent?.headers["private-token"]).toBe("tok-secret");
    const { repos, hasMore } = await c.repos("sh", 1, 30);
    expect(hasMore).toBe(false);
    expect(repos).toEqual([
      { fullName: "acme/platform/shop", private: true, defaultBranch: "main", updatedAt: "2026-11-05T10:01:44.120Z" },
      { fullName: "acme/site", private: false, defaultBranch: null, updatedAt: "2026-10-01T12:00:00.000Z" },
    ]);
    const list = fake.sent.at(-1);
    expect(Object.fromEntries(list?.query ?? [])).toMatchObject({ membership: "true", search: "sh", per_page: "30", page: "1" });
    expect(await c.branches("acme/platform/shop", "")).toEqual(["feat/checkout", "main"]);
  });

  test("branch heads, missing branches, compare with renames, merge requests and forks", async () => {
    const c = client();
    expect(await c.branchHead("acme/platform/shop", "main")).toEqual({
      sha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
      message: "Fix the checkout total\n\nRounds per line.\n",
      author: "Jane Dev",
    });
    expect(await c.branchHead("acme/platform/shop", "nope")).toBeNull();
    const changed = await c.compare(
      "acme/platform/shop",
      "95790bf891e76fee5e1747ab589903a6a1f80f22",
      "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
    );
    expect(changed.complete).toBe(true);
    expect(changed.files.sort()).toEqual(["README.md", "apps/web/src/checkout/old-total.ts", "apps/web/src/checkout/total.ts"]);
    expect(Object.fromEntries(fake.sent.at(-1)?.query ?? [])).toEqual({
      from: "95790bf891e76fee5e1747ab589903a6a1f80f22",
      to: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
      straight: "false",
    });
    expect(await c.mergeRequest("acme/platform/shop", 7)).toEqual({
      number: 7,
      title: "New checkout",
      state: "open",
      headBranch: "feat/checkout",
      headSha: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
      headRepo: "acme/platform/shop",
      baseBranch: "main",
      baseRepo: "acme/platform/shop",
    });
    expect((await c.mergeRequest("acme/platform/shop", 8)).headRepo).toBe("fork:99");
  });

  test("webhooks and commit statuses", async () => {
    const c = client();
    expect(await c.createHook("acme/platform/shop", { url: "https://panel.example.com/api/hooks/gitlab/h1", secret: "s3" })).toBe("1001");
    expect(fake.sent.at(-1)?.body).toEqual({
      url: "https://panel.example.com/api/hooks/gitlab/h1",
      token: "s3",
      push_events: true,
      merge_requests_events: true,
      tag_push_events: false,
      enable_ssl_verification: true,
    });
    await c.deleteHook("acme/platform/shop", "1001");
    expect(fake.calls().at(-1)).toBe("DELETE /api/v4/projects/acme%2Fplatform%2Fshop/hooks/1001");
    // A hook that is already gone is fine.
    await c.deleteHook("acme/platform/shop", "999");
    await c.setStatus("acme/platform/shop", "da1560886d4f094c3e6c9ef40349f7d38b5d27d7", {
      state: "cancelled",
      context: "seylo/web",
      description: "Deploy cancelled",
      targetUrl: "https://panel.example.com/p/a/s/b/deployments",
    });
    expect(fake.sent.at(-1)?.body).toEqual({
      state: "canceled",
      name: "seylo/web",
      description: "Deploy cancelled",
      target_url: "https://panel.example.com/p/a/s/b/deployments",
    });
    expect(c.cloneUrl("acme/platform/shop")).toBe("https://gitlab.com/acme/platform/shop.git");
    expect(c.gitUsername()).toBe("oauth2");
  });

  test("a self-managed GitLab under a path keeps the path", async () => {
    fake.override((r) => (r.path === "/gitlab/api/v4/user" ? { body: { username: "ops" } } : undefined));
    const c = clientFor(panel.deps, row({ kind: "gitlab", url: "https://code.example.com/gitlab" }));
    expect(await c.whoami()).toBe("ops");
    expect(fake.sent.at(-1)?.host).toBe("code.example.com");
    expect(c.cloneUrl("team/app")).toBe("https://code.example.com/gitlab/team/app.git");
  });
});

describe("Gitea and Forgejo", () => {
  const client = () => clientFor(panel.deps, row({ kind: "gitea", url: "https://git.example.com", account: "jdev" }));

  test("token auth, repositories of the token's user, branches and heads", async () => {
    const c = client();
    expect(await c.whoami()).toBe("jdev");
    expect(fake.sent[0]?.headers.authorization).toBe("token tok-secret");
    const { repos, hasMore } = await c.repos("", 1, 30);
    expect(repos).toEqual([{ fullName: "acme/shop", private: true, defaultBranch: "main", updatedAt: "2026-11-05T10:01:44.000Z" }]);
    expect(hasMore).toBe(false);
    expect(Object.fromEntries(fake.sent.at(-1)?.query ?? [])).toMatchObject({ uid: "4", sort: "updated", limit: "30" });
    expect(await c.branches("acme/shop", "feat")).toEqual(["feat/checkout"]);
    expect(await c.branchHead("acme/shop", "main")).toEqual({
      sha: "8d3f2e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e",
      message: "Fix the checkout total\n",
      author: "jdev",
    });
  });

  test("compare, pull requests, hooks and statuses", async () => {
    const c = client();
    const changed = await c.compare("acme/shop", "4b2ae2a1f0d4c8b2d1f7e3c5a6b8d9e0f1a2b3c4", "8d3f2e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e");
    expect(changed).toEqual({ files: ["apps/web/src/checkout/total.ts", "apps/web/package.json"], complete: true });
    expect(await c.mergeRequest("acme/shop", 3)).toMatchObject({
      state: "open",
      headRepo: "acme/shop",
      headSha: "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
    });
    expect(await c.createHook("acme/shop", { url: "https://panel.example.com/api/hooks/gitea/h2", secret: "s4" })).toBe("7");
    expect(fake.sent.at(-1)?.body).toEqual({
      type: "gitea",
      active: true,
      events: ["push", "pull_request"],
      branch_filter: "*",
      config: { url: "https://panel.example.com/api/hooks/gitea/h2", content_type: "json", secret: "s4" },
    });
    await c.setStatus("acme/shop", "8d3f2e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e", {
      state: "failed",
      context: "seylo/web",
      description: "Deploy failed",
      targetUrl: null,
    });
    expect(fake.sent.at(-1)?.body).toEqual({ state: "failure", context: "seylo/web", description: "Deploy failed" });
    expect(c.cloneUrl("acme/shop")).toBe("https://git.example.com/acme/shop.git");
    expect(c.gitUsername()).toBe("jdev");
  });

  test("an older Gitea without the compare API makes the files unknown, never empty", async () => {
    const c = client();
    fake.override((r) => (r.path.includes("/compare/") ? { status: 404, body: { message: "Not Found" } } : undefined));
    await expect(c.compare("acme/shop", "a".repeat(40), "b".repeat(40))).rejects.toThrow("Gitea answered 404");
  });
});

describe("Bitbucket Cloud", () => {
  const tokenRow = () => row({ kind: "bitbucket", url: "https://bitbucket.org", workspace: "acme-ws" });

  test("workspace tokens are bearer tokens and clone as x-token-auth", async () => {
    const c = clientFor(panel.deps, tokenRow());
    expect(await c.whoami()).toBe("acme-ws");
    expect(fake.sent[0]).toMatchObject({ host: "api.bitbucket.org", path: "/2.0/repositories/acme-ws" });
    expect(fake.sent[0]?.headers.authorization).toBe("Bearer tok-secret");
    const { repos, hasMore } = await c.repos("sh", 1, 30);
    expect(hasMore).toBe(true);
    expect(repos[1]).toEqual({ fullName: "acme-ws/empty", private: false, defaultBranch: null, updatedAt: "2026-01-02T00:00:00.000Z" });
    expect(fake.sent.at(-1)?.query.get("q")).toBe('name ~ "sh"');
    expect(c.gitUsername()).toBe("x-token-auth");
    expect(c.cloneUrl("acme-ws/shop")).toBe("https://bitbucket.org/acme-ws/shop.git");
  });

  test("app passwords sign in with the user name", async () => {
    const c = clientFor(
      panel.deps,
      row({ kind: "bitbucket", url: "https://bitbucket.org", workspace: "acme-ws", authKind: "appPassword", username: "jdev" }),
    );
    expect(await c.whoami()).toBe("jdev");
    expect(fake.sent[0]?.headers.authorization).toBe(`Basic ${Buffer.from("jdev:tok-secret").toString("base64")}`);
    expect(c.gitUsername()).toBe("jdev");
  });

  test("diffstat new..old, pull requests with the full head hash, hooks with a secret", async () => {
    const c = clientFor(panel.deps, tokenRow());
    const changed = await c.compare("acme-ws/shop", "1e5d8f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e", "9a6f3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a");
    expect(changed).toEqual({ files: ["apps/api/main.go", "docs/checkout.md"], complete: true });
    expect(fake.calls().at(-1)).toBe(
      "GET /2.0/repositories/acme-ws/shop/diffstat/9a6f3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a..1e5d8f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e",
    );
    expect(await c.mergeRequest("acme-ws/shop", 5)).toEqual({
      number: 5,
      title: "New checkout",
      state: "open",
      headBranch: "feat/checkout",
      headSha: "4f2a9c1e7b3d5a6c8e0f1a2b3c4d5e6f7a8b9c0d",
      headRepo: "acme-ws/shop",
      baseBranch: "main",
      baseRepo: "acme-ws/shop",
    });
    expect(await c.createHook("acme-ws/shop", { url: "https://panel.example.com/api/hooks/bitbucket/h3", secret: "s5" })).toBe(
      "{6a2c3e4f-8b9d-4c1a-9e7f-0b2d4f6a8c0e}",
    );
    expect(fake.sent.at(-1)?.body).toMatchObject({ url: "https://panel.example.com/api/hooks/bitbucket/h3", secret: "s5", active: true });
    expect(fake.sent.at(-1)?.body.events).toContain("repo:push");
    await c.deleteHook("acme-ws/shop", "{6a2c3e4f-8b9d-4c1a-9e7f-0b2d4f6a8c0e}");
    expect(fake.calls().at(-1)).toBe("DELETE /2.0/repositories/acme-ws/shop/hooks/%7B6a2c3e4f-8b9d-4c1a-9e7f-0b2d4f6a8c0e%7D");
  });

  test("a diffstat with more pages than read is incomplete; a next link to another host is not followed", async () => {
    const c = clientFor(panel.deps, tokenRow());
    let pages = 0;
    fake.override((r) => {
      if (!r.path.includes("/diffstat/")) return undefined;
      pages++;
      return {
        body: { values: [{ new: { path: `f${pages}.ts` }, old: null }], next: `https://api.bitbucket.org/2.0/x?page=${pages + 1}` },
      };
    });
    const capped = await c.compare("acme-ws/shop", "a".repeat(40), "b".repeat(40));
    expect(capped.complete).toBe(false);
    expect(pages).toBe(10);
    fake.override((r) =>
      r.path.includes("/diffstat/")
        ? { body: { values: [{ new: { path: "x.ts" } }], next: "https://evil.example/steal?page=2" } }
        : undefined,
    );
    const before = fake.sent.length;
    expect(await c.compare("acme-ws/shop", "a".repeat(40), "b".repeat(40))).toEqual({ files: ["x.ts"], complete: true });
    expect(fake.sent.slice(before).every((r) => r.host === "api.bitbucket.org")).toBe(true);
  });

  test("statuses need a link; without one nothing is posted", async () => {
    const c = clientFor(panel.deps, tokenRow());
    const sha = "9a6f3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a";
    await c.setStatus("acme-ws/shop", sha, { state: "running", context: "seylo/web", description: "Building", targetUrl: null });
    expect(fake.sent).toHaveLength(0);
    await c.setStatus("acme-ws/shop", sha, {
      state: "running",
      context: "seylo/web",
      description: "Building",
      targetUrl: "https://p.example/x",
    });
    expect(fake.sent.at(-1)?.body).toEqual({
      key: "seylo/web",
      name: "seylo/web",
      state: "INPROGRESS",
      description: "Building",
      url: "https://p.example/x",
    });
  });
});

describe("provider HTTP rules", () => {
  const target = { label: "Gitea", base: "https://git.example.com/api/v1", auth: { authorization: "token t" } };

  test("the request connects to the vetted address with the original Host and TLS name", async () => {
    let init: RequestInit | undefined;
    let url = "";
    setProviderFetch(async (u, i) => {
      url = u;
      init = i;
      return new Response("{}", { status: 200 });
    });
    await apiRequest(panel.deps, target, "/user");
    expect(url).toBe(`https://${fakeAddress}/api/v1/user`);
    expect((init?.headers ?? {}) as Record<string, string>).toMatchObject({ host: "git.example.com" });
    expect((init as { tls?: { serverName: string } }).tls).toEqual({ serverName: "git.example.com" });
    expect(init?.redirect).toBe("manual");
  });

  test("redirects are refused, so the token never follows one", async () => {
    setProviderFetch(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    await expect(apiRequest(panel.deps, target, "/user")).rejects.toThrow("redirect");
  });

  test("cloud metadata and names that do not resolve are never requested; private addresses are (admins add connections)", async () => {
    let requests = 0;
    setProviderFetch(async () => {
      requests++;
      return new Response("{}", { status: 200 });
    });
    setTargetResolver(async () => ["169.254.169.254"]);
    await expect(apiRequest(panel.deps, target, "/user")).rejects.toThrow("metadata");
    setTargetResolver(async () => {
      throw new Error("NXDOMAIN");
    });
    await expect(apiRequest(panel.deps, target, "/user")).rejects.toThrow("did not resolve");
    expect(requests).toBe(0);
    setTargetResolver(async () => ["10.0.0.5"]);
    await apiRequest(panel.deps, target, "/user");
    expect(requests).toBe(1);
  });

  test("dot segments in repository or branch names never walk the request elsewhere", async () => {
    const gitea = clientFor(panel.deps, row({ kind: "gitea", url: "https://git.example.com" }));
    await expect(gitea.repo("acme/../../admin")).rejects.toThrow("not a valid name");
    await expect(gitea.branchHead("acme/shop", "../../../admin/users")).rejects.toThrow("not a valid name");
    await expect(gitea.repo("acme/%2e%2e")).rejects.toThrow("not a valid name");
    const gitlab = clientFor(panel.deps, row({ kind: "gitlab", url: "https://gitlab.com" }));
    await expect(gitlab.repo("a/../b")).rejects.toThrow("not a valid name");
    await expect(gitlab.branchHead("acme/platform/shop", "..")).rejects.toThrow("not a valid name");
    expect(fake.sent).toHaveLength(0);
  });

  test("errors carry the provider's message; huge answers are cut off", async () => {
    setProviderFetch(async () => new Response(JSON.stringify({ message: "token expired" }), { status: 401 }));
    await expect(apiRequest(panel.deps, target, "/user")).rejects.toThrow("Gitea answered 401: token expired");
    setProviderFetch(async () => new Response("x", { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }));
    await expect(apiRequest(panel.deps, target, "/user")).rejects.toThrow("too large");
  });
});
