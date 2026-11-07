import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { deployments as deploymentOps, github, previews as previewOps, projects, services as serviceOps, webhooks } from "@seylo/ops";
import { eq } from "drizzle-orm";
import {
  deploymentLogs,
  deployments,
  githubApps,
  githubInstallations,
  gitInternalHosts,
  previews,
  services,
  webhookDeliveries,
} from "../src/db/schema";
import { engineFor } from "../src/modules/deployments/engine";
import { resolveBuild } from "../src/modules/deployments/source";
import { pollBranches } from "../src/modules/github/poll";
import { loadService } from "../src/modules/services/rows";
import { readSpec } from "../src/modules/services/spec";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let fleet: FakeFleet;
let cookie: string;
let projectId: string;
let nodeA: string;
let installationRowId: string;
const realFetch = globalThis.fetch;
const secret = "whsec-test";
let heads: Record<string, string>;
let apiCalls: string[];
let compareFiles: string[] = [];

function fakeGithub() {
  apiCalls = [];
  heads = { main: "1111111111111111111111111111111111111111" };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    apiCalls.push(`${method} ${url.pathname}`);
    const ok = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (url.host !== "api.github.com") return realFetch(input, init);
    if (method === "POST" && /\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return ok({ token: "ghs_installation", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    const commit = /^\/repos\/acme\/shop\/commits\/(.+)$/.exec(url.pathname);
    if (commit) {
      const ref = decodeURIComponent(commit[1] as string);
      const sha = heads[ref] ?? ref;
      if (init?.headers && (init.headers as Record<string, string>)["if-none-match"] === `"${sha}"`)
        return new Response(null, { status: 304 });
      return ok(
        { sha, commit: { message: `commit ${sha.slice(0, 7)}\n\nbody`, author: { name: "Dev" } }, author: { login: "dev" } },
        { etag: `"${sha}"` },
      );
    }
    if (/^\/repos\/acme\/shop\/branches\//.test(url.pathname)) return ok({ name: "main" });
    if (/^\/repos\/acme\/shop\/compare\//.test(url.pathname)) return ok({ files: compareFiles.map((filename) => ({ filename })) });
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;
}

beforeEach(async () => {
  panel = testPanel();
  fleet = new FakeFleet(panel);
  nodeA = fleet.addNode("node-a", { canBuild: true, panelNode: true });
  ({ cookie } = await createUser(panel, "owner"));
  projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = panel.deps.db
    .insert(githubApps)
    .values({
      appId: 42,
      slug: "seylo-test",
      name: "Seylo test",
      htmlUrl: "https://github.com/apps/seylo-test",
      ownerLogin: "acme",
      clientId: "Iv1.test",
      clientSecretSealed: panel.deps.secrets.seal("cs", "github.app"),
      privateKeySealed: panel.deps.secrets.seal(privateKey.export({ type: "pkcs1", format: "pem" }).toString(), "github.app"),
      webhookSecretSealed: panel.deps.secrets.seal(secret, "github.app"),
    })
    .returning()
    .get();
  installationRowId = panel.deps.db
    .insert(githubInstallations)
    .values({ githubAppId: app.id, installationId: 7, accountLogin: "acme", accountType: "Organization" })
    .returning()
    .get().id;
  fakeGithub();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  panel.close();
});

async function githubService(name = "web") {
  const id = (
    await callOp(
      panel,
      serviceOps.create,
      { projectId, name, kind: "app", nodeId: nodeA, ports: [{ containerPort: 3000, protocol: "tcp" }] },
      { cookie },
    )
  ).body.id;
  const connected = await callOp(
    panel,
    github.connectRepo,
    { serviceId: id, installationId: installationRowId, repo: "acme/shop", branch: "main", deployOnPush: true },
    { cookie },
  );
  expect(connected.status).toBe(200);
  expect(connected.body.sourceConfig).toMatchObject({ type: "github", repo: "acme/shop", branch: "main" });
  return id as string;
}

async function post(event: string, payload: unknown, options: { sign?: string; delivery?: string } = {}) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", options.sign ?? secret)
    .update(body)
    .digest("hex")}`;
  const res = await panel.app.handle(
    new Request("http://panel.test/api/hooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": options.delivery ?? crypto.randomUUID(),
        "x-hub-signature-256": signature,
      },
      body,
    }),
  );
  await fleet.settle();
  return { status: res.status, body: (await res.json()) as any };
}

const push = (branch: string, sha: string) => ({
  ref: `refs/heads/${branch}`,
  after: sha,
  repository: { full_name: "acme/shop" },
  head_commit: { id: sha, message: "Fix checkout\n\nmore", author: { username: "dev" } },
  sender: { login: "dev" },
});

describe("GitHub webhooks", () => {
  // github.com gets the node's internal-address allowance only when an admin recorded it for the
  // project (git.allowInternalHost): a node behind a proxy that cannot resolve github.com itself
  // refuses it otherwise (agentio-2 round 3).
  test("a GitHub build carries allow_internal_host only for a recorded github.com", async () => {
    const id = await githubService();
    const built = async () => {
      const service = loadService(panel.deps.db, id);
      const resolved = await resolveBuild(panel.deps, {
        service,
        spec: readSpec(service.spec),
        buildId: "b1",
        generation: 1,
        commitSha: "2222222222222222222222222222222222222222",
        uploadId: null,
      });
      return resolved.request.source?.source;
    };
    expect(await built()).toMatchObject({ case: "git", value: { url: "https://github.com/acme/shop.git", allowInternalHost: false } });
    panel.deps.db.insert(gitInternalHosts).values({ projectId, host: "github.com", approvedBy: null }).run();
    expect(await built()).toMatchObject({ case: "git", value: { url: "https://github.com/acme/shop.git", allowInternalHost: true } });
  });

  test("a signed push to the followed branch deploys that commit; other branches are ignored", async () => {
    const id = await githubService();
    const sha = "2222222222222222222222222222222222222222";
    const res = await post("push", push("main", sha));
    expect(res.body).toMatchObject({ ok: true, deployed: 1 });
    const d = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).get();
    expect(d).toMatchObject({ trigger: "push", actor: "dev", commitSha: sha, commitMessage: "Fix checkout" });
    expect(fleet.builds[0]?.request).toMatchObject({
      source: { source: { case: "git", value: { url: "https://github.com/acme/shop.git", commit: sha, token: "ghs_installation" } } },
    });

    await post("push", push("dev", "3333333333333333333333333333333333333333"));
    const deliveries = (await callOp(panel, webhooks.listDeliveries, { serviceId: id }, { cookie })).body.deliveries;
    expect(deliveries.map((d: { outcome: string }) => d.outcome)).toEqual(["ignored", "deployed"]);
    expect(deliveries[0].detail).toContain("dev");
  });

  test("a bad signature is rejected and logged; a repeated delivery deploys once", async () => {
    const id = await githubService();
    const bad = await post("push", push("main", "4444444444444444444444444444444444444444"), { sign: "wrong" });
    expect(bad.status).toBe(401);
    expect(panel.deps.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.outcome, "rejected")).all()).toHaveLength(1);

    await post("push", push("main", "5555555555555555555555555555555555555555"), { delivery: "same" });
    await post("push", push("main", "5555555555555555555555555555555555555555"), { delivery: "same" });
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).all()).toHaveLength(1);
  });

  test("pull requests open, update and close a preview service with the same env", async () => {
    const id = await githubService();
    const refused = await callOp(panel, previewOps.updateSettings, { serviceId: id, enabled: true }, { cookie });
    expect(refused.body.error).toMatchObject({ code: "BAD_REQUEST", details: { field: "acknowledgeSharedEnv" } });
    const on = await callOp(panel, previewOps.updateSettings, { serviceId: id, enabled: true, acknowledgeSharedEnv: true }, { cookie });
    expect(on.body.enabled).toBe(true);

    const pr = (action: string, sha: string) => ({
      action,
      number: 12,
      pull_request: {
        title: "New checkout",
        head: { ref: "feat/checkout", sha, repo: { full_name: "acme/shop" } },
        base: { ref: "main", repo: { full_name: "acme/shop" } },
      },
      repository: { full_name: "acme/shop" },
      sender: { login: "dev" },
    });
    await post("pull_request", pr("opened", "6666666666666666666666666666666666666666"));
    let list = (await callOp(panel, previewOps.list, { serviceId: id }, { cookie })).body.previews;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ prNumber: 12, branch: "feat/checkout", prTitle: "New checkout" });
    const previewId = list[0].previewServiceId as string;
    const previewSvc = panel.deps.db.select().from(services).where(eq(services.id, previewId)).get();
    expect(previewSvc?.name).toBe("web-pr-12");
    const pd = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, previewId)).all();
    expect(pd.map((d) => d.trigger)).toEqual(["preview"]);

    await post("pull_request", pr("synchronize", "7777777777777777777777777777777777777777"));
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, previewId)).all()).toHaveLength(2);

    await post("pull_request", pr("closed", "7777777777777777777777777777777777777777"));
    expect(panel.deps.db.select().from(services).where(eq(services.id, previewId)).get()).toBeUndefined();
    list = (await callOp(panel, previewOps.list, { serviceId: id }, { cookie })).body.previews;
    expect(list[0].closedAt).not.toBeNull();
    expect(panel.deps.db.select().from(previews).all()).toHaveLength(1);
  });

  test("forks are not previewed", async () => {
    const id = await githubService();
    await callOp(panel, previewOps.updateSettings, { serviceId: id, enabled: true, acknowledgeSharedEnv: true }, { cookie });
    await post("pull_request", {
      action: "opened",
      number: 3,
      pull_request: {
        title: "x",
        head: { ref: "main", sha: "8888888888888888888888888888888888888888", repo: { full_name: "evil/shop" } },
        base: { ref: "main", repo: { full_name: "acme/shop" } },
      },
      repository: { full_name: "acme/shop" },
    });
    expect((await callOp(panel, previewOps.list, { serviceId: id }, { cookie })).body.previews).toHaveLength(0);
  });

  test("polling deploys a commit the webhook missed", async () => {
    const id = await githubService();
    expect(await pollBranches(panel.deps)).toBe(0);
    expect(await pollBranches(panel.deps)).toBe(0);
    heads.main = "9999999999999999999999999999999999999999";
    expect(await pollBranches(panel.deps)).toBe(1);
    await fleet.settle();
    const d = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).get();
    expect(d?.commitSha).toBe(heads.main);
  });

  test("a head polling finds while a deploy runs deploys after it, and the newest head wins", async () => {
    const id = await githubService();
    expect(await pollBranches(panel.deps)).toBe(0);
    // A deploy of the service is running.
    const running = panel.deps.db
      .insert(deployments)
      .values({ serviceId: id, trigger: "manual", status: "building", generation: 50, actor: "test", startedAt: new Date() } as never)
      .returning()
      .get();
    heads.main = "2222222222222222222222222222222222222222";
    expect(await pollBranches(panel.deps)).toBe(1);
    const pushDeploys = () =>
      panel.deps.db
        .select()
        .from(deployments)
        .where(eq(deployments.serviceId, id))
        .all()
        .filter((d) => d.trigger === "push");
    expect(pushDeploys()).toMatchObject([{ status: "queued", commitSha: heads.main }]);

    // Another push before the running deploy is done: the waiting deploy builds the newer head.
    heads.main = "3333333333333333333333333333333333333333";
    expect(await pollBranches(panel.deps)).toBe(0);
    const [waiting] = pushDeploys();
    expect(pushDeploys()).toHaveLength(1);
    expect(waiting).toMatchObject({ status: "queued", commitSha: heads.main });
    const log = panel.deps.db
      .select()
      .from(deploymentLogs)
      .where(eq(deploymentLogs.deploymentId, waiting?.id as string))
      .all()
      .map((l) => l.text);
    expect(log).toContain("A newer push arrived before this deploy started: it builds 3333333 now.");
    const deliveries = (await callOp(panel, webhooks.listDeliveries, { serviceId: id }, { cookie })).body.deliveries;
    expect(deliveries[0]).toMatchObject({ outcome: "ignored", detail: "A deploy was already queued; it builds 3333333 now." });

    // The running deploy ends; the waiting one builds the newest head.
    panel.deps.db.update(deployments).set({ status: "failed", finishedAt: new Date() }).where(eq(deployments.id, running.id)).run();
    engineFor(panel.deps).kick(waiting?.id as string);
    await fleet.settle();
    expect(fleet.builds.at(-1)?.request).toMatchObject({
      source: { source: { case: "git", value: { commit: "3333333333333333333333333333333333333333" } } },
    });
    expect(pushDeploys()).toMatchObject([{ status: "deploying", commitSha: "3333333333333333333333333333333333333333" }]);
  });

  test("a webhook push while a deploy runs queues behind it; a second one takes the waiting deploy over", async () => {
    const id = await githubService();
    panel.deps.db
      .insert(deployments)
      .values({ serviceId: id, trigger: "manual", status: "deploying", generation: 50, actor: "test", startedAt: new Date() } as never)
      .run();
    expect((await post("push", push("main", "6666666666666666666666666666666666666666"))).body).toMatchObject({ deployed: 1 });
    expect((await post("push", push("main", "7777777777777777777777777777777777777777"))).body).toMatchObject({ deployed: 0 });
    const queued = panel.deps.db
      .select()
      .from(deployments)
      .where(eq(deployments.serviceId, id))
      .all()
      .filter((d) => d.status === "queued");
    expect(queued).toMatchObject([{ trigger: "push", commitSha: "7777777777777777777777777777777777777777" }]);
  });
});

describe("GitHub pushes with watch paths and [skip ci]", () => {
  const sha = (n: number) => String(n).repeat(40).slice(0, 40);
  const pushWith = (n: number, files: string[] | null, message = "Change") => ({
    ...push("main", sha(n)),
    before: sha(n - 1),
    head_commit: { id: sha(n), message, author: { username: "dev" } },
    commits: files === null ? [] : [{ id: sha(n), message, added: [], modified: files, removed: [] }],
  });
  const logLines = (deploymentId: string) =>
    panel.deps.db
      .select()
      .from(deploymentLogs)
      .where(eq(deploymentLogs.deploymentId, deploymentId))
      .all()
      .map((l) => l.text);

  test("only pushes that touch the watch paths deploy, and the log says which file matched", async () => {
    const id = await githubService();
    await callOp(panel, serviceOps.setWatchPaths, { serviceId: id, watchPaths: ["apps/web/**"] }, { cookie });
    const skipped = await post("push", pushWith(2, ["apps/api/main.go"]));
    expect(skipped.body).toMatchObject({ deployed: 0 });
    let list = (await callOp(panel, webhooks.listDeliveries, { serviceId: id }, { cookie })).body.deliveries;
    expect(list[0]).toMatchObject({ outcome: "ignored", detail: "Skipped by watch paths: the one changed file matches no pattern." });

    await post("push", pushWith(3, ["apps/web/page.tsx"]));
    const [d] = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).all();
    expect(logLines(d?.id as string)).toContain("Watch paths: apps/web/page.tsx matches apps/web/**.");

    await post("push", pushWith(4, ["apps/web/page.tsx"], "Small fix [skip ci]"));
    list = (await callOp(panel, webhooks.listDeliveries, { serviceId: id }, { cookie })).body.deliveries;
    expect(list[0].detail).toBe("Skipped: the head commit message says [skip ci].");
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).all()).toHaveLength(1);
  });

  test("a push without a file list asks GitHub's compare API", async () => {
    const id = await githubService();
    await callOp(panel, serviceOps.setWatchPaths, { serviceId: id, watchPaths: ["apps/web/**"] }, { cookie });
    compareFiles = ["docs/readme.md"];
    await post("push", pushWith(5, null));
    expect(apiCalls).toContain(`GET /repos/acme/shop/compare/${sha(4)}...${sha(5)}`);
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).all()).toHaveLength(0);
    compareFiles = ["apps/web/x.ts"];
    await post("push", pushWith(6, null));
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, id)).all()).toHaveLength(1);
  });

  test("a pull request titled [skip ci] opens no preview", async () => {
    const id = await githubService();
    await callOp(panel, previewOps.updateSettings, { serviceId: id, enabled: true, acknowledgeSharedEnv: true }, { cookie });
    await post("pull_request", {
      action: "opened",
      number: 4,
      pull_request: {
        title: "WIP [skip ci]",
        head: { ref: "wip", sha: sha(7), repo: { full_name: "acme/shop" } },
        base: { ref: "main", repo: { full_name: "acme/shop" } },
      },
      repository: { full_name: "acme/shop" },
    });
    expect((await callOp(panel, previewOps.list, { serviceId: id }, { cookie })).body.previews).toHaveLength(0);
  });
});

describe("deploy trigger URLs", () => {
  test("rotate, call, and delete", async () => {
    const id = (
      await callOp(
        panel,
        serviceOps.create,
        { projectId, name: "api", kind: "app", nodeId: nodeA, source: { type: "image", image: "nginx:1", registryId: null } },
        { cookie },
      )
    ).body.id;
    const rotated = await callOp(panel, webhooks.rotateTrigger, { serviceId: id }, { cookie });
    expect(rotated.body.url).toStartWith("/api/hooks/deploy/");
    const got = await callOp(panel, webhooks.getTrigger, { serviceId: id }, { cookie });
    expect(got.body).toMatchObject({ configured: true, hint: rotated.body.hint });

    const call = await panel.app.handle(new Request(`http://panel.test${rotated.body.url}`, { method: "POST" }));
    expect(call.status).toBe(200);
    const { deploymentId } = (await call.json()) as { deploymentId: string };
    await fleet.settle();
    const d = await callOp(panel, deploymentOps.get, { serviceId: id, deploymentId }, { cookie });
    expect(d.body.deployment).toMatchObject({ trigger: "webhook", status: "deploying" });

    const wrong = await panel.app.handle(new Request("http://panel.test/api/hooks/deploy/nope", { method: "POST" }));
    expect(wrong.status).toBe(404);
    await callOp(panel, webhooks.deleteTrigger, { serviceId: id }, { cookie });
    const after = await panel.app.handle(new Request(`http://panel.test${rotated.body.url}`, { method: "POST" }));
    expect(after.status).toBe(404);
  });

  test("distinct commits join one queued deploy, and a looping caller is rate limited", async () => {
    const id = (
      await callOp(
        panel,
        serviceOps.create,
        { projectId, name: "worker", kind: "app", nodeId: nodeA, source: { type: "image", image: "nginx:1", registryId: null } },
        { cookie },
      )
    ).body.id;
    const { url } = (await callOp(panel, webhooks.rotateTrigger, { serviceId: id }, { cookie })).body;
    // A deploy is waiting in the queue (another one of the service is running).
    panel.deps.db
      .insert(deployments)
      .values({ serviceId: id, trigger: "webhook", status: "queued", generation: 99, actor: "test" } as never)
      .run();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const commit = `${i.toString(16).padStart(2, "0")}${"a".repeat(38)}`;
      statuses.push((await panel.app.handle(new Request(`http://panel.test${url}?commit=${commit}`, { method: "POST" }))).status);
    }
    expect(statuses).toContain(429);
    const queued = panel.deps.db
      .select()
      .from(deployments)
      .where(eq(deployments.serviceId, id))
      .all()
      .filter((d) => d.status === "queued");
    expect(queued).toHaveLength(1);
  });
});
