// A shared credential is shared for what an admin used it for: once a git
// credential, registry login, GitHub installation or git provider
// connection is attached to one service of a project, members there may use
// it for the same repository, URL or image repository, not for every other
// one the owner's token can reach. Admins attach anything.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { github, git as gitOps, gitProviders as providerOps, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { gitCredentials, githubApps, githubInstallations, gitProviders, registryCredentials, services } from "../src/db/schema";
import { imageRepository, normalizeGitUrl } from "../src/modules/services/source-guard";
import { createUser, grant, type TestPanel, testPanel } from "./helpers";
import { call } from "./people-helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

const realFetch = globalThis.fetch;
let panel: TestPanel;
let owner: string;
let member: string;
let projectId: string;
let nodeId: string;
let target: string;
let githubCalls: string[];

beforeEach(async () => {
  panel = testPanel();
  owner = (await createUser(panel, "owner")).cookie;
  const m = await createUser(panel, "member");
  member = m.cookie;
  nodeId = seedNode(panel).id;
  projectId = seedProject(panel).id;
  target = seedService(panel, { projectId, name: "api", nodeIds: [nodeId] }).id;
  grant(panel, m.user.id, "project", projectId, ["services.create", "services.update", "services.view"]);
  githubCalls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  panel.close();
});

/** An admin's service in the project that uses the credential for one thing. */
function sharedBy(source: Record<string, unknown>) {
  const svc = seedService(panel, { projectId, name: `admin-${crypto.randomUUID().slice(0, 6)}`, nodeIds: [nodeId] });
  const row = panel.deps.db.select().from(services).where(eq(services.id, svc.id)).get();
  panel.deps.db
    .update(services)
    .set({ spec: { ...(row?.spec as object), source } })
    .where(eq(services.id, svc.id))
    .run();
}

const setSource = (source: Record<string, unknown>, cookie = member) =>
  call(panel, serviceOps.setSource, { serviceId: target, source: source as never }, { cookie });

describe("a git credential shared for one repository", () => {
  test("is usable for that repository only", async () => {
    const pat = panel.deps.db
      .insert(gitCredentials)
      .values({ name: "org pat", kind: "token", host: "github.com", secretSealed: panel.deps.secrets.seal("ghp_x", "git.credential") })
      .returning()
      .get().id;
    const site = { type: "git", url: "https://github.com/org/site.git", branch: "main", credentialId: pat, deployOnPush: false };
    sharedBy(site);

    expect((await setSource({ ...site, url: "https://github.com/Org/site" })).status).toBe(200);
    const other = await setSource({ ...site, url: "https://github.com/org/billing.git" });
    expect(other.status).toBe(403);
    expect(other.body.error.message).toContain("github.com/org/site");
    // Listing branches of another repository with it is refused before anything is fetched.
    const branches = await call(
      panel,
      gitOps.branches,
      { projectId, url: "https://github.com/org/billing.git", credentialId: pat },
      { cookie: member },
    );
    expect(branches.status).toBe(403);
    // A new service with it for another repository too.
    const created = await call(
      panel,
      serviceOps.create,
      { projectId, name: "billing", kind: "app", nodeId, source: { ...site, url: "https://github.com/org/billing.git" } as never },
      { cookie: member },
    );
    expect(created.status).toBe(403);

    // An admin attaches anything.
    expect((await setSource({ ...site, url: "https://github.com/org/billing.git" }, owner)).status).toBe(200);
  });
});

describe("a registry login shared for one image repository", () => {
  test("is usable for other tags of that image only", async () => {
    const login = panel.deps.db
      .insert(registryCredentials)
      .values({ name: "ghcr", server: "ghcr.io", username: "bot", passwordSealed: panel.deps.secrets.seal("p", "registry.credential") })
      .returning()
      .get().id;
    sharedBy({ type: "image", image: "ghcr.io/org/app:1.0", registryId: login });
    expect((await setSource({ type: "image", image: "ghcr.io/org/app:2.0", registryId: login })).status).toBe(200);
    expect((await setSource({ type: "image", image: "ghcr.io/org/secret-tool:1", registryId: login })).status).toBe(403);
  });
});

describe("a GitHub installation shared for one repository", () => {
  function fakeGithub() {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.host !== "api.github.com") return realFetch(input, init);
      githubCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
        return ok({ token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (url.pathname === "/installation/repositories") {
        const repo = (full_name: string) => ({ full_name, private: true, default_branch: "main", pushed_at: "2026-11-01T00:00:00Z" });
        return ok({ total_count: 2, repositories: [repo("org/site"), repo("org/billing")] });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;
  }

  test("members list and connect that repository only", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app = panel.deps.db
      .insert(githubApps)
      .values({
        appId: 42,
        slug: "test",
        name: "test",
        htmlUrl: "https://github.com/apps/test",
        ownerLogin: "org",
        clientId: "Iv1.test",
        clientSecretSealed: panel.deps.secrets.seal("cs", "github.app"),
        privateKeySealed: panel.deps.secrets.seal(privateKey.export({ type: "pkcs1", format: "pem" }).toString(), "github.app"),
        webhookSecretSealed: panel.deps.secrets.seal("wh", "github.app"),
      })
      .returning()
      .get();
    const installationId = panel.deps.db
      .insert(githubInstallations)
      .values({ githubAppId: app.id, installationId: 7, accountLogin: "org", accountType: "Organization" })
      .returning()
      .get().id;
    fakeGithub();
    sharedBy({ type: "github", installationId, repo: "org/site", branch: "main", deployOnPush: false });

    const listed = await call(panel, github.repos, { projectId, installationId }, { cookie: member });
    expect(listed.status).toBe(200);
    expect(listed.body.repos.map((r: { fullName: string }) => r.fullName)).toEqual(["org/site"]);
    const asOwner = await call(panel, github.repos, { projectId, installationId }, { cookie: owner });
    expect(asOwner.body.repos).toHaveLength(2);

    const before = githubCalls.length;
    const connect = await call(
      panel,
      github.connectRepo,
      { serviceId: target, installationId, repo: "org/billing", branch: "main", deployOnPush: false },
      { cookie: member },
    );
    expect(connect.status).toBe(403);
    expect((await call(panel, github.branches, { projectId, installationId, repo: "org/billing" }, { cookie: member })).status).toBe(403);
    expect(githubCalls.length).toBe(before);
  });
});

describe("a git provider connection shared for one repository", () => {
  test("is refused for other repositories before the provider is called", async () => {
    const providerId = panel.deps.db
      .insert(gitProviders)
      .values({
        kind: "gitlab",
        name: "GitLab",
        url: "https://gitlab.example.com",
        tokenSealed: panel.deps.secrets.seal("t", "git.provider"),
      })
      .returning()
      .get().id;
    sharedBy({ type: "provider", providerId, provider: "gitlab", repo: "org/site", branch: "main", deployOnPush: false });
    const other = await call(panel, providerOps.branches, { projectId, providerId, repo: "org/billing" }, { cookie: member });
    expect(other.status).toBe(403);
    const connect = await call(
      panel,
      providerOps.connectRepo,
      { serviceId: target, providerId, repo: "org/billing", branch: "main", deployOnPush: false },
      { cookie: member },
    );
    expect(connect.status).toBe(403);
  });
});

test("targets compare the way people write them", () => {
  expect(normalizeGitUrl("https://GitHub.com/Org/Site.git/")).toBe(normalizeGitUrl("https://github.com/org/site"));
  expect(imageRepository("ghcr.io/org/app:1.0@sha256:abc")).toBe("ghcr.io/org/app");
  expect(imageRepository("nginx:1.27")).toBe("docker.io/library/nginx");
  expect(imageRepository("docker.io/acme/app")).toBe(imageRepository("acme/app:latest"));
  expect(imageRepository("localhost:5000/app:1")).toBe("localhost:5000/app");
});
