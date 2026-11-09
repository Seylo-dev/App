// GitHub ops: the App (manifest flow), installations, repo and branch
// pickers, connecting a repo, and the opt-in connected GitHub account (a
// device login or a pasted token, account.ts) for private repos the App
// does not reach.

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
import { readSpec } from "../services/spec";
import { readPanelName } from "../settings/keys";
import {
  accountById,
  accountRepos,
  accountToken,
  checkGithubToken,
  connectedAccount,
  forgetAccountRepos,
  type GithubRepo,
  saveAccount,
  toAccount,
} from "./account";
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
import { ensureRepoHook, removeAccountHooks, repoHookOf } from "./repo-hooks";

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
  const account = connectedAccount(ctx.db);
  return {
    app: row ? toApp(row) : null,
    webhookUrl: webhookUrl(ctx.db),
    deviceFlowAvailable: !isPlaceholder(oauthClientId),
    // The owner's connected account (its scopes, how it was connected) is theirs to see, not every member's.
    account: account && ctx.access.can("github.manage") ? toAccount(account) : null,
  };
});

/** Invalidates what shows the connected account: Settings > GitHub, the pickers and the credential list. */
function publishAccount(ctx: Pick<OpContext, "live">): void {
  ctx.live.publish("panel", { type: "invalidate", ops: [githubOps.status.id, githubOps.installations.id, "git.listCredentials"] });
}

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
  if (!maySeeApp(ctx)) return { installations: [], installUrl: null, account: null, hidden: true };
  const row = appRow(ctx.db);
  const rows = ctx.db.select().from(githubInstallations).orderBy(githubInstallations.accountLogin).all();
  const account = connectedAccount(ctx.db);
  return {
    installations: rows.map(toInstallation),
    installUrl: row ? installUrl(row) : null,
    account: account ? { id: account.id, login: toAccount(account).login } : null,
    hidden: false,
  };
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

/** Which of installationId and accountId an op got: exactly one. */
export type GithubVia = { installationId: string; accountId: null } | { installationId: null; accountId: string };

export function viaOf(input: { installationId?: string; accountId?: string }): GithubVia {
  if (input.installationId && input.accountId)
    throw new OpError("BAD_REQUEST", "Pass installationId or accountId, not both.", { field: "accountId" });
  if (input.installationId) return { installationId: input.installationId, accountId: null };
  if (input.accountId) return { installationId: null, accountId: input.accountId };
  throw new OpError("BAD_REQUEST", "Pass installationId (the GitHub App) or accountId (the connected GitHub account).", {
    field: "installationId",
  });
}

/** The repositories the App installation or the connected account reads. */
async function reposVia(ctx: OpContext, via: GithubVia): Promise<GithubRepo[]> {
  if (via.installationId !== null) return installationRepos(ctx, via.installationId);
  return accountRepos(ctx, accountById(ctx.db, via.accountId));
}

/** FORBIDDEN unless the caller may use it in the project; the repositories it is shared for there (null: any). */
function sharedVia(ctx: OpContext, projectId: string, via: GithubVia): Set<string> | null {
  return via.installationId !== null
    ? assertMayUseSomewhere(ctx, projectId, "github", via.installationId, "installationId")
    : assertMayUseSomewhere(ctx, projectId, "githubAccount", accountById(ctx.db, via.accountId).id, "accountId");
}

const repos = implement(githubOps.repos, async (input, ctx) => {
  const via = viaOf(input);
  // People who do not manage GitHub see only the repositories the installation or account is shared for in this project.
  const shared = sharedVia(ctx, input.projectId, via);
  let all: GithubRepo[];
  try {
    all = await reposVia(ctx, via);
  } catch (error) {
    if (error instanceof GithubApiError && via.accountId !== null)
      throw new OpError(
        error.status === 401 ? "CONFLICT" : "UNAVAILABLE",
        error.status === 401
          ? "GitHub no longer accepts the connected account's token. Connect the account again in Settings > GitHub."
          : error.message,
      );
    throw error;
  }
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

/** The token of the App installation or the connected account, and how errors name it. */
async function tokenVia(ctx: Pick<OpContext, "db" | "secrets">, via: GithubVia): Promise<{ token: string; who: string; fix: string }> {
  if (via.installationId !== null) {
    return {
      token: await tokenForInstallation(ctx.db, ctx.secrets, via.installationId),
      who: "The App",
      fix: "Give the App access to it on GitHub.",
    };
  }
  const account = accountById(ctx.db, via.accountId);
  return {
    token: accountToken(ctx.secrets, account),
    who: `The connected GitHub account (@${toAccount(account).login})`,
    fix: "Check the account can open it on GitHub (an organization may need to approve the panel first).",
  };
}

/**
 * Branches of a repo through the App or the connected account, default
 * branch first. GitHub answers 404 for a repository it cannot read (or that
 * does not exist): NOT_FOUND with field repo, so the New app dialog can tell
 * it from GitHub not answering (UNAVAILABLE), which says nothing about the
 * repository.
 */
export async function repoBranches(ctx: Pick<OpContext, "db" | "secrets">, viaOrInstallation: GithubVia | string, repo: string) {
  const via: GithubVia = typeof viaOrInstallation === "string" ? { installationId: viaOrInstallation, accountId: null } : viaOrInstallation;
  const { token, who, fix } = await tokenVia(ctx, via);
  try {
    const [info, names] = await Promise.all([
      githubRequest<{ default_branch: string }>(`/repos/${repo}`, { auth: token }),
      githubPages<string>(`/repos/${repo}/branches`, token, (page) => (page as { name: string }[]).map((b) => b.name), 10),
    ]);
    const defaultBranch = info.data.default_branch;
    return { defaultBranch, branches: [defaultBranch, ...names.filter((b) => b !== defaultBranch).sort()] };
  } catch (error) {
    if (!(error instanceof GithubApiError)) throw error;
    // 403 too: a fine-grained token without access to this repository, or an organization that has not approved the panel.
    if (error.status === 404 || (error.status === 403 && via.accountId !== null)) {
      throw new OpError("NOT_FOUND", `${who} cannot read ${repo}, or there is no such repository. ${fix}`, {
        field: "repo",
      });
    }
    throw new OpError("UNAVAILABLE", error.message, { field: "repo" });
  }
}

/** The source fields of a GitHub source read through the App or the account. */
function sourceVia(ctx: OpContext, via: GithubVia): { installationId: string | null; accountId: string | null } {
  return via.installationId !== null
    ? { installationId: via.installationId, accountId: null }
    : { installationId: null, accountId: accountById(ctx.db, via.accountId).id };
}

const branches = implement(githubOps.branches, async (input, ctx) => {
  const via = viaOf(input);
  assertSourceAllowed(ctx, input.projectId, { type: "github", ...sourceVia(ctx, via), repo: input.repo }, "");
  const { defaultBranch, branches: all } = await repoBranches(ctx, via, input.repo);
  const q = input.query?.toLowerCase().trim() ?? "";
  return { defaultBranch, branches: all.filter((b) => !q || b.toLowerCase().includes(q)).slice(0, 500) };
});

const connectRepo = implement(githubOps.connectRepo, async (input, ctx) => {
  const row = loadService(ctx.db, input.serviceId);
  if (row.kind !== "app" && row.kind !== "cron") throw new OpError("CONFLICT", `A ${row.kind} service cannot build from a repository.`);
  if (row.parentId) throw new OpError("CONFLICT", "Compose members build from their stack's repository.");
  const via = viaOf(input);
  if (via.installationId !== null) installationById(ctx.db, via.installationId);
  const fields = sourceVia(ctx, via);
  assertSourceAllowed(ctx, row.projectId, { type: "github", ...fields, repo: input.repo }, "");
  const { token, who, fix } = await tokenVia(ctx, via);
  try {
    await githubRequest(`/repos/${input.repo}/branches/${encodeURIComponent(input.branch)}`, { auth: token });
  } catch {
    throw new OpError("BAD_REQUEST", `${who} cannot read ${input.repo} at ${input.branch}. Check the branch. ${fix}`, {
      field: "repo",
    });
  }
  const next = updateSpec(ctx, row.id, (spec) => ({
    ...spec,
    source: {
      type: "github",
      ...fields,
      repo: input.repo,
      branch: input.branch,
      deployOnPush: input.deployOnPush,
    },
    build: { ...spec.build, contextPath: input.rootDir ?? spec.build.contextPath, builder: spec.build.builder },
  }));
  ctx.db.delete(sourcePolls).where(eq(sourcePolls.serviceId, row.id)).run();
  // The App's webhook covers its repositories; one read through the account gets its own (pushes and pull requests).
  if (fields.accountId) {
    await ensureRepoHook(ctx, { serviceId: row.id, account: accountById(ctx.db, fields.accountId), repo: input.repo });
    ctx.live.publish(`service:${row.id}`, { type: "invalidate", ops: [githubOps.repoWebhook.id] });
  }
  publishService(ctx, row);
  return toDetail(ctx.db, ctx.agents, next);
});

const repoWebhook = implement(githubOps.repoWebhook, (input, ctx) => {
  const source = readSpec(loadService(ctx.db, input.serviceId).spec).source;
  const configured = source.type === "github" && source.installationId === null;
  const row = repoHookOf(ctx, input.serviceId);
  return {
    configured,
    repo: configured ? source.repo : null,
    url: row?.url ?? null,
    created: Boolean(row?.remoteId),
    error: row ? row.error : null,
    lastDeliveryAt: row?.lastDeliveryAt?.toISOString() ?? null,
  };
});

const tokenConnect = implement(githubOps.tokenConnect, async (input, ctx) => {
  const token = input.token.trim();
  const checked = await checkGithubToken(token);
  const row = saveAccount(ctx, { token, login: checked.login, scopes: checked.scopes, origin: "github_token" });
  publishAccount(ctx);
  return toAccount(row);
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
  const scopes = (data.scope ?? user.scopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Replaces a pasted token too, in place: services that read through the account keep it.
  const credential = saveAccount(ctx, { token: data.access_token, login: user.data.login, scopes, origin: "device" });
  ctx.db.delete(githubDeviceFlows).where(eq(githubDeviceFlows.id, flow.id)).run();
  publishAccount(ctx);
  return { status: "done" as const, login: user.data.login, gitCredentialId: credential.id };
});

const deviceDisconnect = implement(githubOps.deviceDisconnect, async (_input, ctx) => {
  const existing = connectedAccount(ctx.db);
  if (!existing) throw new OpError("NOT_FOUND", "No GitHub account is connected.");
  // The webhooks it made go first: without the token nothing could remove them later.
  await removeAccountHooks(ctx, existing);
  ctx.db.delete(gitCredentials).where(eq(gitCredentials.id, existing.id)).run();
  forgetAccountRepos(ctx.db);
  publishAccount(ctx);
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
  repoWebhook,
  tokenConnect,
  deviceStart,
  devicePoll,
  deviceDisconnect,
];
