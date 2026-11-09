// GitHub ops: the App (manifest flow), installations, repo and branch
// pickers, connecting a repo, and the opt-in device-flow token for
// private repos.

import { createHash, randomBytes } from "node:crypto";
import { isPlaceholder, oauthClientId } from "@seylo/brand";
import { github as githubOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { eq, lt, notInArray } from "drizzle-orm";
import { sourcePickerActions } from "../../auth/access";
import { userOf } from "../../auth/principal";
import type { PanelDb } from "../../db/client";
import { gitCredentials, githubApps, githubDeviceFlows, githubInstallations, githubManifestFlows, sourcePolls } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { publishService, updateSpec } from "../services/ops";
import { loadService, toDetail } from "../services/rows";
import { assertMayUseSomewhere, assertSourceAllowed } from "../services/source-guard";
import { readPanelName } from "../settings/keys";
import { GithubApiError, githubPages, githubRequest } from "./api";
import {
  appJwt,
  appRow,
  forgetTokens,
  installationById,
  installUrl,
  manifestFor,
  panelBaseUrl,
  requireApp,
  syncWebhookConfig,
  tokenForInstallation,
  webhookUrl,
} from "./app";

type GithubApp = Static<typeof githubOps.GithubApp>;
type Installation = Static<typeof githubOps.Installation>;

const flowTtlMs = 60 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function toApp(row: typeof githubApps.$inferSelect): GithubApp {
  return {
    id: row.id,
    appId: row.appId,
    slug: row.slug,
    name: row.name,
    ownerLogin: row.ownerLogin,
    htmlUrl: row.htmlUrl,
    installUrl: installUrl(row),
    createdAt: row.createdAt.toISOString(),
  };
}

function toInstallation(row: typeof githubInstallations.$inferSelect): Installation {
  return {
    id: row.id,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: row.repositorySelection,
    suspended: row.suspendedAt !== null,
    manageUrl:
      row.accountType === "Organization"
        ? `https://github.com/organizations/${row.accountLogin}/settings/installations/${row.installationId}`
        : `https://github.com/settings/installations/${row.installationId}`,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface GithubInstallationPayload {
  id: number;
  account: { login: string; type: string } | null;
  repository_selection?: string;
  suspended_at?: string | null;
}

/** Inserts or refreshes an installation row from GitHub's shape. */
export function upsertInstallation(db: PanelDb, appRowId: string, inst: GithubInstallationPayload): void {
  const values = {
    githubAppId: appRowId,
    installationId: inst.id,
    accountLogin: inst.account?.login ?? "unknown",
    accountType: (inst.account?.type === "Organization" ? "Organization" : "User") as "User" | "Organization",
    repositorySelection: (inst.repository_selection === "selected" ? "selected" : "all") as "all" | "selected",
    suspendedAt: inst.suspended_at ? new Date(inst.suspended_at) : null,
  };
  db.insert(githubInstallations)
    .values(values)
    .onConflictDoUpdate({ target: githubInstallations.installationId, set: { ...values } })
    .run();
}

function deviceCredential(db: PanelDb) {
  return db.select().from(gitCredentials).where(eq(gitCredentials.origin, "device")).get();
}

/**
 * Whether the caller may see the App and where it is installed (account
 * and organisation logins): people who manage it, or who may set a source
 * somewhere, like the other shared pickers. Everyone else sees no App.
 */
function maySeeApp(ctx: OpContext): boolean {
  return ctx.access.can("github.manage") || ctx.access.canSomewhere(sourcePickerActions);
}

const status = implement(githubOps.status, (_input, ctx) => {
  const row = maySeeApp(ctx) ? appRow(ctx.db) : undefined;
  const device = deviceCredential(ctx.db);
  return {
    app: row ? toApp(row) : null,
    webhookUrl: webhookUrl(ctx.db),
    deviceFlowAvailable: !isPlaceholder(oauthClientId),
    // The owner's device-flow account is theirs to see, not every member's.
    deviceAccount:
      device && ctx.access.can("github.manage")
        ? {
            login: device.githubLogin ?? "",
            scopes: (device.scopes ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            gitCredentialId: device.id,
            connectedAt: device.createdAt.toISOString(),
          }
        : null,
  };
});

const startManifest = implement(githubOps.startManifest, (input, ctx) => {
  if (appRow(ctx.db)) throw new OpError("CONFLICT", "This panel already has a GitHub App. Forget it first to create another.");
  const base = panelBaseUrl(ctx.db) ?? input.panelUrl;
  if (!base)
    throw new OpError("BAD_REQUEST", "Set the panel's domain first, or pass panelUrl (the address you open the panel at).", {
      field: "panelUrl",
    });
  const state = randomBytes(24).toString("base64url");
  ctx.db.delete(githubManifestFlows).where(lt(githubManifestFlows.expiresAt, new Date())).run();
  ctx.db
    .insert(githubManifestFlows)
    .values({
      stateHash: hash(state),
      organization: input.organization ?? null,
      createdBy: userOf(ctx.principal)?.id ?? null,
      expiresAt: new Date(Date.now() + flowTtlMs),
    })
    .run();
  const manifest = manifestFor({ baseUrl: base.replace(/\/$/, ""), webhookUrl: webhookUrl(ctx.db), panelName: readPanelName(ctx.db) });
  const target = input.organization
    ? `https://github.com/organizations/${encodeURIComponent(input.organization)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return { postUrl: `${target}?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(manifest), state };
});

interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  owner: { login: string } | null;
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
}

const finishManifest = implement(githubOps.finishManifest, async (input, ctx) => {
  const flow = ctx.db
    .select()
    .from(githubManifestFlows)
    .where(eq(githubManifestFlows.stateHash, hash(input.state)))
    .get();
  if (!flow || flow.expiresAt < new Date())
    throw new OpError("BAD_REQUEST", "This GitHub App link expired. Start again.", { field: "state" });
  ctx.db.delete(githubManifestFlows).where(eq(githubManifestFlows.stateHash, flow.stateHash)).run();
  if (appRow(ctx.db)) throw new OpError("CONFLICT", "This panel already has a GitHub App.");
  if (!/^[\w-]{1,100}$/.test(input.code)) throw new OpError("BAD_REQUEST", "Invalid code from GitHub.", { field: "code" });
  const { data } = await githubRequest<ManifestConversion>(`/app-manifests/${input.code}/conversions`, { method: "POST" });
  const row = ctx.db
    .insert(githubApps)
    .values({
      appId: data.id,
      slug: data.slug,
      name: data.name,
      htmlUrl: data.html_url,
      ownerLogin: data.owner?.login ?? "",
      clientId: data.client_id,
      clientSecretSealed: ctx.secrets.seal(data.client_secret, "github.app"),
      privateKeySealed: ctx.secrets.seal(data.pem, "github.app"),
      // GitHub sends no secret when the hook is inactive; make one so later activation can verify.
      webhookSecretSealed: ctx.secrets.seal(data.webhook_secret ?? randomBytes(32).toString("hex"), "github.app"),
    })
    .returning()
    .get();
  forgetTokens(ctx.db);
  // Older GitHub answers lack a secret: push ours, and point the hook at the domain when there is one.
  if (!data.webhook_secret || webhookUrl(ctx.db)) await syncWebhookConfig(ctx);
  ctx.live.publish("panel", { type: "invalidate", ops: [githubOps.status.id, githubOps.installations.id] });
  return toApp(row);
});

const deleteApp = implement(githubOps.deleteApp, (_input, ctx) => {
  const row = requireApp(ctx.db);
  ctx.db.delete(githubApps).where(eq(githubApps.id, row.id)).run();
  forgetTokens(ctx.db);
  ctx.live.publish("panel", { type: "invalidate", ops: [githubOps.status.id, githubOps.installations.id] });
  return {};
});

const installations = implement(githubOps.installations, (_input, ctx) => {
  if (!maySeeApp(ctx)) return { installations: [], installUrl: null, hidden: true };
  const row = appRow(ctx.db);
  const rows = ctx.db.select().from(githubInstallations).orderBy(githubInstallations.accountLogin).all();
  return { installations: rows.map(toInstallation), installUrl: row ? installUrl(row) : null, hidden: false };
});

/** Reads the App's installations from GitHub and makes the table match. */
export async function syncInstallationRows(ctx: Pick<OpContext, "db" | "secrets">): Promise<void> {
  const row = requireApp(ctx.db);
  const list = await githubPages<GithubInstallationPayload>(
    "/app/installations",
    appJwt(row, ctx.secrets),
    (page) => page as GithubInstallationPayload[],
  );
  for (const inst of list) upsertInstallation(ctx.db, row.id, inst);
  const ids = list.map((i) => i.id);
  ctx.db
    .delete(githubInstallations)
    .where(ids.length > 0 ? notInArray(githubInstallations.installationId, ids) : eq(githubInstallations.githubAppId, row.id))
    .run();
}

const syncInstallations = implement(githubOps.syncInstallations, async (_input, ctx) => {
  await syncInstallationRows(ctx);
  ctx.live.publish("panel", { type: "invalidate", ops: [githubOps.installations.id] });
  return { installations: ctx.db.select().from(githubInstallations).orderBy(githubInstallations.accountLogin).all().map(toInstallation) };
});

interface GithubRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
}

const repoCache = new WeakMap<object, Map<string, { at: number; repos: GithubRepo[] }>>();

async function installationRepos(ctx: OpContext, installationRowId: string): Promise<GithubRepo[]> {
  let cache = repoCache.get(ctx.db);
  if (!cache) {
    cache = new Map();
    repoCache.set(ctx.db, cache);
  }
  const hit = cache.get(installationRowId);
  if (hit && Date.now() - hit.at < 60_000) return hit.repos;
  const token = await tokenForInstallation(ctx.db, ctx.secrets, installationRowId);
  const repos = await githubPages<GithubRepo>(
    "/installation/repositories",
    token,
    (page) => (page as { repositories: GithubRepo[] }).repositories,
    10,
  );
  cache.set(installationRowId, { at: Date.now(), repos });
  return repos;
}

const pageSize = 30;

const repos = implement(githubOps.repos, async (input, ctx) => {
  // People who do not manage GitHub see only the repositories the installation is shared for in this project.
  const shared = assertMayUseSomewhere(ctx, input.projectId, "github", input.installationId, "installationId");
  const all = await installationRepos(ctx, input.installationId);
  const q = input.query?.toLowerCase().trim() ?? "";
  const filtered = all
    .filter((r) => shared === null || shared.has(r.full_name.toLowerCase()))
    .filter((r) => !q || r.full_name.toLowerCase().includes(q))
    .sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""));
  const page = input.page ?? 1;
  return {
    repos: filtered.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      pushedAt: r.pushed_at ? new Date(r.pushed_at).toISOString() : null,
    })),
    hasMore: filtered.length > page * pageSize,
  };
});

/**
 * Branches of a repo through the App, default branch first. GitHub answers
 * 404 for a repository the installation cannot read (or that does not
 * exist): NOT_FOUND with field repo, so the New app dialog can tell it from
 * GitHub not answering (UNAVAILABLE), which says nothing about the repository.
 */
export async function repoBranches(ctx: Pick<OpContext, "db" | "secrets">, installationRowId: string, repo: string) {
  const token = await tokenForInstallation(ctx.db, ctx.secrets, installationRowId);
  try {
    const [info, names] = await Promise.all([
      githubRequest<{ default_branch: string }>(`/repos/${repo}`, { auth: token }),
      githubPages<string>(`/repos/${repo}/branches`, token, (page) => (page as { name: string }[]).map((b) => b.name), 10),
    ]);
    const defaultBranch = info.data.default_branch;
    return { defaultBranch, branches: [defaultBranch, ...names.filter((b) => b !== defaultBranch).sort()] };
  } catch (error) {
    if (!(error instanceof GithubApiError)) throw error;
    if (error.status === 404) {
      throw new OpError("NOT_FOUND", `The App cannot read ${repo}, or there is no such repository. Give the App access to it on GitHub.`, {
        field: "repo",
      });
    }
    throw new OpError("UNAVAILABLE", error.message, { field: "repo" });
  }
}

const branches = implement(githubOps.branches, async (input, ctx) => {
  assertSourceAllowed(ctx, input.projectId, { type: "github", installationId: input.installationId, repo: input.repo }, "");
  const { defaultBranch, branches: all } = await repoBranches(ctx, input.installationId, input.repo);
  const q = input.query?.toLowerCase().trim() ?? "";
  return { defaultBranch, branches: all.filter((b) => !q || b.toLowerCase().includes(q)).slice(0, 500) };
});

const connectRepo = implement(githubOps.connectRepo, async (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  if (row.kind !== "app" && row.kind !== "cron") throw new OpError("CONFLICT", `A ${row.kind} service cannot build from a repository.`);
  if (row.parentId) throw new OpError("CONFLICT", "Compose members build from their stack's repository.");
  installationById(ctx.db, input.installationId);
  assertSourceAllowed(ctx, row.projectId, { type: "github", installationId: input.installationId, repo: input.repo }, "");
  const token = await tokenForInstallation(ctx.db, ctx.secrets, input.installationId);
  try {
    await githubRequest(`/repos/${input.repo}/branches/${encodeURIComponent(input.branch)}`, { auth: token });
  } catch {
    throw new OpError(
      "BAD_REQUEST",
      `The App cannot read ${input.repo} at ${input.branch}. Check the branch, or give the App access to the repository on GitHub.`,
      {
        field: "repo",
      },
    );
  }
  const next = updateSpec(ctx, row.id, (spec) => ({
    ...spec,
    source: {
      type: "github",
      installationId: input.installationId,
      repo: input.repo,
      branch: input.branch,
      deployOnPush: input.deployOnPush,
    },
    build: { ...spec.build, contextPath: input.rootDir ?? spec.build.contextPath, builder: spec.build.builder },
  }));
  ctx.db.delete(sourcePolls).where(eq(sourcePolls.serviceId, row.id)).run();
  publishService(ctx, row);
  return toDetail(ctx.db, ctx.agents, next);
});

// Device flow (like `gh auth login`) for a token that clones private repos.

const deviceStart = implement(githubOps.deviceStart, async (_input, ctx) => {
  if (isPlaceholder(oauthClientId))
    throw new OpError("NOT_IMPLEMENTED", "This build has no GitHub OAuth App configured, so the device flow is off.", {
      reason: "noClientId",
    });
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: oauthClientId, scope: "repo" }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => null)) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    interval?: number;
    expires_in?: number;
  } | null;
  if (!response.ok || !data?.device_code || !data.user_code || !data.verification_uri)
    throw new OpError("UNAVAILABLE", "GitHub did not start the device flow. Try again.");
  ctx.db.delete(githubDeviceFlows).where(lt(githubDeviceFlows.expiresAt, new Date())).run();
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 900) * 1000);
  const row = ctx.db
    .insert(githubDeviceFlows)
    .values({
      deviceCodeSealed: ctx.secrets.seal(data.device_code, "github.account"),
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      intervalSeconds: data.interval ?? 5,
      createdBy: userOf(ctx.principal)?.id ?? null,
      expiresAt,
    })
    .returning()
    .get();
  return {
    flowId: row.id,
    userCode: row.userCode,
    verificationUri: row.verificationUri,
    intervalSeconds: row.intervalSeconds,
    expiresAt: expiresAt.toISOString(),
  };
});

const devicePoll = implement(githubOps.devicePoll, async (input, ctx) => {
  const flow = ctx.db.select().from(githubDeviceFlows).where(eq(githubDeviceFlows.id, input.flowId)).get();
  if (!flow) throw new OpError("NOT_FOUND", "No device flow with this id.", { field: "flowId" });
  if (flow.expiresAt < new Date()) {
    ctx.db.delete(githubDeviceFlows).where(eq(githubDeviceFlows.id, flow.id)).run();
    return { status: "expired" as const, login: null, gitCredentialId: null };
  }
  const deviceCode = ctx.secrets.open(flow.deviceCodeSealed, "github.account");
  if (!deviceCode) throw new OpError("CONFLICT", "The device flow cannot be read. Start again.");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: oauthClientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    error?: string;
    interval?: number;
  } | null;
  if (data?.error === "authorization_pending") return { status: "pending" as const, login: null, gitCredentialId: null };
  if (data?.error === "slow_down") {
    ctx.db
      .update(githubDeviceFlows)
      .set({ intervalSeconds: data.interval ?? flow.intervalSeconds + 5 })
      .where(eq(githubDeviceFlows.id, flow.id))
      .run();
    return { status: "pending" as const, login: null, gitCredentialId: null };
  }
  if (data?.error === "expired_token" || data?.error === "access_denied") {
    ctx.db.delete(githubDeviceFlows).where(eq(githubDeviceFlows.id, flow.id)).run();
    return { status: data.error === "access_denied" ? ("denied" as const) : ("expired" as const), login: null, gitCredentialId: null };
  }
  if (!data?.access_token) throw new OpError("UNAVAILABLE", "GitHub did not answer the device flow. Try again.");
  const user = await githubRequest<{ login: string }>("/user", { auth: data.access_token });
  const scopes = data.scope ?? user.scopes ?? "";
  const existing = deviceCredential(ctx.db);
  const values = {
    name: `GitHub (${user.data.login})`,
    kind: "token" as const,
    host: "github.com",
    username: user.data.login,
    secretSealed: ctx.secrets.seal(data.access_token, "git.credential"),
    origin: "device" as const,
    githubLogin: user.data.login,
    scopes,
    createdBy: userOf(ctx.principal)?.id ?? null,
  };
  const credential = existing
    ? ctx.db.update(gitCredentials).set(values).where(eq(gitCredentials.id, existing.id)).returning().get()
    : ctx.db.insert(gitCredentials).values(values).returning().get();
  ctx.db.delete(githubDeviceFlows).where(eq(githubDeviceFlows.id, flow.id)).run();
  ctx.live.publish("panel", { type: "invalidate", ops: [githubOps.status.id, "git.listCredentials"] });
  return { status: "done" as const, login: user.data.login, gitCredentialId: credential.id };
});

const deviceDisconnect = implement(githubOps.deviceDisconnect, (_input, ctx) => {
  const existing = deviceCredential(ctx.db);
  if (!existing) throw new OpError("NOT_FOUND", "No GitHub account is connected.");
  ctx.db.delete(gitCredentials).where(eq(gitCredentials.id, existing.id)).run();
  ctx.live.publish("panel", { type: "invalidate", ops: [githubOps.status.id, "git.listCredentials"] });
  return {};
});

export const githubHandlers = [
  status,
  startManifest,
  finishManifest,
  deleteApp,
  installations,
  syncInstallations,
  repos,
  branches,
  connectRepo,
  deviceStart,
  devicePoll,
  deviceDisconnect,
];
