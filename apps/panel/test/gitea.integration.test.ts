// End to end against a real Gitea in the test VM (scripts/dev/it-gitea.sh
// starts it, with HTTPS from a throwaway CA, and sets SEYLO_IT_GITEA_*):
// the panel serves on a real port, a connection is checked with Gitea, a
// private repository is connected (Gitea gets the webhook), commits pushed
// from a local clone deploy through Gitea's signed webhook, a docs-only
// push is skipped by the watch paths, [skip ci] skips, a pull request
// opens and closes a preview, and deleting the service removes the hook.
// Skipped unless the script runs it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previews as previewOps, projects, gitProviders as providerOps, services as serviceOps } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { deploymentLogs, deployments, gitProviderWebhooks, previews, webhookDeliveries } from "../src/db/schema";
import { clientFor } from "../src/modules/gitProviders/client";
import { loadProvider } from "../src/modules/gitProviders/rows";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

const it = {
  url: process.env.SEYLO_IT_GITEA_URL ?? "",
  token: process.env.SEYLO_IT_GITEA_TOKEN ?? "",
  user: process.env.SEYLO_IT_GITEA_USER ?? "",
  ca: process.env.SEYLO_IT_GITEA_CA ?? "",
  panelHost: process.env.SEYLO_IT_PANEL_HOST ?? "",
  port: Number(process.env.SEYLO_IT_PANEL_PORT ?? "18811"),
  out: process.env.SEYLO_IT_GITEA_OUT ?? "",
};
const enabled = it.url !== "" && it.token !== "";

let panel: TestPanel;
let fleet: FakeFleet;
let server: ReturnType<typeof Bun.serve>;
let cookie: string;
let projectId: string;
let nodeA: string;
let repo = "";
let work = "";

async function gitea<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${it.url}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `token ${it.token}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`gitea ${init.method ?? "GET"} ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function git(...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-c", `http.sslCAInfo=${it.ca}`, ...args], {
    cwd: work,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "IT",
      GIT_AUTHOR_EMAIL: "it@example.com",
      GIT_COMMITTER_NAME: "IT",
      GIT_COMMITTER_EMAIL: "it@example.com",
    },
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** Writes files, commits and pushes; returns the new head. */
function commit(files: Record<string, string>, message: string, branch = "main"): string {
  for (const [path, content] of Object.entries(files)) {
    const full = join(work, path);
    Bun.spawnSync(["mkdir", "-p", full.slice(0, full.lastIndexOf("/"))]);
    writeFileSync(full, content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", message);
  git("push", "-q", "origin", `HEAD:${branch}`);
  return git("rev-parse", "HEAD");
}

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

describe.skipIf(!enabled)("a real Gitea", () => {
  beforeAll(async () => {
    panel = testPanel();
    fleet = new FakeFleet(panel);
    nodeA = fleet.addNode("node-a", { canBuild: true, panelNode: true });
    ({ cookie } = await createUser(panel, "owner"));
    projectId = (await callOp(panel, projects.create, { name: "it" }, { cookie })).body.id;
    server = Bun.serve({ port: it.port, hostname: "0.0.0.0", fetch: (request) => panel.app.handle(request) });
    const name = `demo-${crypto.randomUUID().slice(0, 8)}`;
    await gitea("/user/repos", { method: "POST", body: { name, private: true, auto_init: true, default_branch: "main" } });
    repo = `${it.user}/${name}`;
    work = mkdtempSync(join(tmpdir(), "gitproviders-it-"));
    const authed = new URL(`${it.url}/${repo}.git`);
    authed.username = it.user;
    authed.password = it.token;
    git("clone", "-q", authed.toString(), ".");
  });

  afterAll(async () => {
    // The repository stays for the agent's clone test; the script removes the whole Gitea afterwards.
    server?.stop(true);
    panel?.close();
  });

  test("connect, push to deploy, watch-path and [skip ci] skips, a pull request preview, hook removal", async () => {
    const connection = await callOp(
      panel,
      providerOps.create,
      { kind: "gitea", name: "IT Gitea", url: it.url, token: it.token },
      { cookie },
    );
    expect(connection.status).toBe(200);
    expect(connection.body.account).toBe(it.user);
    const providerId = connection.body.id as string;

    const serviceId = (
      await callOp(
        panel,
        serviceOps.create,
        { projectId, name: "web", kind: "app", nodeId: nodeA, ports: [{ containerPort: 3000, protocol: "tcp" }] },
        { cookie },
      )
    ).body.id as string;
    const picked = await callOp(panel, providerOps.repos, { projectId, providerId, query: repo.split("/")[1] }, { cookie });
    expect(picked.body.repos.map((r: { fullName: string }) => r.fullName)).toContain(repo);
    const connected = await callOp(
      panel,
      providerOps.connectRepo,
      { serviceId, providerId, repo, branch: "main", deployOnPush: true },
      { cookie, headers: { host: it.panelHost } },
    );
    expect(connected.status).toBe(200);
    const hooks = await gitea<{ id: number; config: { url: string }; events: string[] }[]>(`/repos/${repo}/hooks`);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.config.url).toStartWith(`http://${it.panelHost}/api/hooks/gitea/`);
    await callOp(panel, serviceOps.setWatchPaths, { serviceId, watchPaths: ["app/**"] }, { cookie });

    // A push that touches app/ deploys that commit through the webhook.
    const first = commit({ "app/index.js": "console.log('hello');\n" }, "Add the app");
    const deployed = await waitFor("the push deploy", () =>
      panel.deps.db
        .select()
        .from(deployments)
        .where(and(eq(deployments.serviceId, serviceId), eq(deployments.commitSha, first)))
        .get(),
    );
    await fleet.settle();
    expect(deployed).toMatchObject({ trigger: "push", branch: "main", commitMessage: "Add the app" });
    const lines = panel.deps.db
      .select()
      .from(deploymentLogs)
      .where(eq(deploymentLogs.deploymentId, deployed.id))
      .all()
      .map((l) => l.text);
    expect(lines).toContain("Watch paths: app/index.js matches app/**.");
    expect(fleet.builds[0]?.request).toMatchObject({
      source: { source: { case: "git", value: { url: `${it.url}/${repo}.git`, commit: first, token: it.token, username: it.user } } },
    });

    const detailFor = (sha: string, text: string) =>
      waitFor(`a delivery for ${sha.slice(0, 7)}`, () =>
        panel.deps.db
          .select()
          .from(webhookDeliveries)
          .where(and(eq(webhookDeliveries.serviceId, serviceId), eq(webhookDeliveries.source, "gitea")))
          .all()
          .find((d) => d.detail.includes(text)),
      );

    // A docs-only push is skipped by the watch paths.
    const docs = commit({ "docs/readme.md": "# Docs\n" }, "Docs only");
    const skipped = await detailFor(docs, "Skipped by watch paths");
    expect(skipped.outcome).toBe("ignored");
    // [skip ci] skips even a push that touches app/.
    const marked = commit({ "app/index.js": "console.log('quiet');\n" }, "Quiet change [skip ci]");
    await detailFor(marked, "[skip ci]");
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).all()).toHaveLength(1);

    // The real compare API names the files between two pushes.
    const changed = await clientFor(panel.deps, loadProvider(panel.deps.db, providerId)).compare(repo, first, docs);
    expect(changed.files).toContain("docs/readme.md");
    expect(changed.complete).toBe(true);

    // A pull request opens a preview and closing it removes the preview.
    await callOp(panel, previewOps.updateSettings, { serviceId, enabled: true, acknowledgeSharedEnv: true }, { cookie });
    const head = commit({ "app/feature.js": "export {};\n" }, "Feature", "feat");
    const pr = await gitea<{ number: number }>(`/repos/${repo}/pulls`, {
      method: "POST",
      body: { head: "feat", base: "main", title: "New feature" },
    });
    const preview = await waitFor("the preview", () =>
      panel.deps.db
        .select()
        .from(previews)
        .where(and(eq(previews.serviceId, serviceId), eq(previews.prNumber, pr.number)))
        .get(),
    );
    expect(preview).toMatchObject({ branch: "feat", commitSha: head });
    await fleet.settle();
    await gitea(`/repos/${repo}/pulls/${pr.number}`, { method: "PATCH", body: { state: "closed" } });
    await waitFor("the preview to close", () =>
      panel.deps.db.select().from(previews).where(eq(previews.id, preview.id)).get()?.closedAt ? true : undefined,
    );

    // The agent-side clone test reads the repository and its head from here.
    if (it.out) writeFileSync(it.out, JSON.stringify({ repo: `${it.url}/${repo}.git`, head: first }));

    // Deleting the service removes the webhook from Gitea.
    await callOp(panel, serviceOps.remove, { serviceId, confirmName: "web" }, { cookie });
    expect(panel.deps.db.select().from(gitProviderWebhooks).all()).toHaveLength(0);
    await panel.runner.runDue(panel.deps);
    expect(await gitea<unknown[]>(`/repos/${repo}/hooks`)).toHaveLength(0);
  }, 180_000);
});
