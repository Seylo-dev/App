// Git provider ops: connections (create, change, check, delete), the repo
// and branch pickers, connecting a repository to a service (with its
// webhook) and the webhook's state.

import { gitProviders as contracts, OpError, type gitProviders as providerOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { requireFreshIfSession } from "../../auth/fresh";
import { userOf } from "../../auth/principal";
import { gitProviders, sourcePolls } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { updateSpec } from "../services/ops";
import { loadService, toDetail } from "../services/rows";
import { assertSourceAllowed } from "../services/source-guard";
import { readSpec } from "../services/spec";
import { clientFor } from "./client";
import { ensureHook, type WebhookRow, webhookOf } from "./hooks";
import { describeProviderError, ProviderApiError } from "./http";
import { bitbucketWeb, gitlabCom, loadProvider, type ProviderRow, providerUsage, toProvider } from "./rows";

type ProviderWebhook = Static<typeof providerOps.ProviderWebhook>;

const pageSize = 30;

function canManage(ctx: OpContext): boolean {
  return ctx.access.can("gitProviders.manage");
}

/**
 * The address a webhook may point at when the panel has no domain: the one
 * the caller reached the panel at, but only for people who manage
 * connections. Anyone else could name any host in the Host header and have
 * the provider send the repository's pushes (and the hook's secret) there.
 */
function hookOrigin(ctx: OpContext): string | null {
  return canManage(ctx) ? (ctx.origin ?? null) : null;
}

function publishList(ctx: OpContext): void {
  ctx.live.publish("panel", { type: "invalidate", ops: [contracts.list.id] });
}

/** Checks a token with the provider; returns who it acts as or a BAD_REQUEST that says why. */
async function verifyToken(ctx: OpContext, row: ProviderRow): Promise<string> {
  try {
    return await clientFor(ctx, row).whoami();
  } catch (error) {
    if (error instanceof ProviderApiError && (error.status === 401 || error.status === 403)) {
      throw new OpError("BAD_REQUEST", `The provider refused the token: ${error.message}`, { field: "token", reason: "token" });
    }
    throw new OpError("BAD_REQUEST", `Could not check the token: ${describeProviderError(error)}`, { field: "url", reason: "unreachable" });
  }
}

const list = implement(contracts.list, (_input, ctx) => {
  const usage = providerUsage(ctx.db);
  const full = canManage(ctx);
  const rows = ctx.db.select().from(gitProviders).orderBy(gitProviders.name).all();
  return { items: rows.map((r) => toProvider(r, usage.get(r.id) ?? 0, full)) };
});

const create = implement(contracts.create, async (input, ctx) => {
  // A token with write access to repositories and their webhooks: a session left open may not add one.
  requireFreshIfSession(ctx);
  let url: string;
  let workspace: string | null = null;
  let authKind: ProviderRow["authKind"] = "token";
  let username: string | null = null;
  if (input.kind === "bitbucket") {
    if (input.url && input.url.replace(/\/+$/, "") !== bitbucketWeb)
      throw new OpError("BAD_REQUEST", "Bitbucket connections are for Bitbucket Cloud (https://bitbucket.org).", { field: "url" });
    if (!input.workspace) throw new OpError("BAD_REQUEST", "Enter the Bitbucket workspace.", { field: "workspace" });
    url = bitbucketWeb;
    workspace = input.workspace;
    authKind = input.authKind ?? "token";
    if (authKind === "appPassword") {
      if (!input.username) throw new OpError("BAD_REQUEST", "Enter the Bitbucket user name for the app password.", { field: "username" });
      username = input.username;
    }
  } else {
    if (input.authKind === "appPassword") throw new OpError("BAD_REQUEST", "Only Bitbucket uses app passwords.", { field: "authKind" });
    if (input.kind === "gitea" && !input.url)
      throw new OpError("BAD_REQUEST", "Enter the address of the Gitea or Forgejo server.", { field: "url" });
    url = (input.url ?? gitlabCom).replace(/\/+$/, "");
  }
  const draft: ProviderRow = {
    id: "",
    kind: input.kind,
    name: input.name.trim(),
    url,
    workspace,
    authKind,
    username,
    tokenSealed: ctx.secrets.seal(input.token.trim(), "git.provider"),
    account: null,
    statusNotes: input.statusNotes ?? true,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const account = await verifyToken(ctx, draft);
  const row = ctx.db
    .insert(gitProviders)
    .values({
      kind: draft.kind,
      name: draft.name,
      url: draft.url,
      workspace: draft.workspace,
      authKind: draft.authKind,
      username: draft.username,
      tokenSealed: draft.tokenSealed,
      account,
      statusNotes: draft.statusNotes,
      createdBy: userOf(ctx.principal)?.id ?? null,
    })
    .returning()
    .get();
  publishList(ctx);
  return toProvider(row, 0, true);
});

const update = implement(contracts.update, async (input, ctx) => {
  const row = loadProvider(ctx.db, input.providerId);
  const changes: Partial<typeof gitProviders.$inferInsert> = {};
  if (input.name !== undefined) changes.name = input.name.trim();
  if (input.statusNotes !== undefined) changes.statusNotes = input.statusNotes;
  if (input.username !== undefined) {
    if (row.authKind !== "appPassword")
      throw new OpError("BAD_REQUEST", "Only app password connections have a user name.", { field: "username" });
    changes.username = input.username;
  }
  if (input.token !== undefined || changes.username !== undefined) {
    // Swapping the credential is as sensitive as adding a connection.
    requireFreshIfSession(ctx);
    const tokenSealed = input.token !== undefined ? ctx.secrets.seal(input.token.trim(), "git.provider") : row.tokenSealed;
    changes.tokenSealed = tokenSealed;
    changes.account = await verifyToken(ctx, { ...row, ...changes, tokenSealed } as ProviderRow);
  }
  const updated =
    Object.keys(changes).length === 0 ? row : ctx.db.update(gitProviders).set(changes).where(eq(gitProviders.id, row.id)).returning().get();
  publishList(ctx);
  return toProvider(updated, providerUsage(ctx.db, row.id).get(row.id) ?? 0, true);
});

const remove = implement(contracts.remove, (input, ctx) => {
  const row = loadProvider(ctx.db, input.providerId);
  const used = providerUsage(ctx.db, row.id).get(row.id) ?? 0;
  if (used > 0) throw new OpError("CONFLICT", `${used} service(s) still deploy through "${row.name}". Change their source first.`);
  ctx.db.delete(gitProviders).where(eq(gitProviders.id, row.id)).run();
  publishList(ctx);
  return {};
});

const check = implement(contracts.check, async (input, ctx) => {
  const row = loadProvider(ctx.db, input.providerId);
  try {
    const account = await clientFor(ctx, row).whoami();
    if (account !== row.account) ctx.db.update(gitProviders).set({ account }).where(eq(gitProviders.id, row.id)).run();
    return { ok: true, account, message: `The token works and acts as ${account}.` };
  } catch (error) {
    return { ok: false, account: null, message: describeProviderError(error) };
  }
});

function providerFor(ctx: OpContext, projectId: string, providerId: string): ProviderRow {
  const row = loadProvider(ctx.db, providerId);
  // The same rules as saving the source: attaching a connection to a new project is for its managers.
  assertSourceAllowed(ctx, projectId, { type: "provider", providerId }, "");
  return row;
}

/** Turns a provider failure into a message for the person. */
function asOpError(error: unknown, field?: string): never {
  if (error instanceof OpError) throw error;
  if (error instanceof ProviderApiError) {
    const code = error.status === 404 ? "NOT_FOUND" : error.status === 0 ? "UNAVAILABLE" : "BAD_REQUEST";
    throw new OpError(code, error.message, field ? { field } : undefined);
  }
  throw error;
}

const repos = implement(contracts.repos, async (input, ctx) => {
  const row = providerFor(ctx, input.projectId, input.providerId);
  try {
    const page = input.page ?? 1;
    const out = await clientFor(ctx, row).repos(input.query?.trim() ?? "", page, pageSize);
    return { repos: out.repos, hasMore: out.hasMore };
  } catch (error) {
    asOpError(error);
  }
});

const branches = implement(contracts.branches, async (input, ctx) => {
  const row = providerFor(ctx, input.projectId, input.providerId);
  try {
    const client = clientFor(ctx, row);
    const [repo, names] = await Promise.all([client.repo(input.repo), client.branches(input.repo, input.query?.trim() ?? "")]);
    const defaultBranch = repo.defaultBranch;
    const rest = names.filter((b) => b !== defaultBranch).sort();
    const first = defaultBranch && names.includes(defaultBranch) ? [defaultBranch] : [];
    return { defaultBranch, branches: [...first, ...rest].slice(0, 1000) };
  } catch (error) {
    asOpError(error, "repo");
  }
});

const connectRepo = implement(contracts.connectRepo, async (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  if (svc.kind !== "app" && svc.kind !== "cron") throw new OpError("CONFLICT", `A ${svc.kind} service cannot build from a repository.`);
  if (svc.parentId) throw new OpError("CONFLICT", "Compose members build from their stack's repository.");
  if (readSpec(svc.spec).preview) throw new OpError("CONFLICT", "A preview follows its merge or pull request.");
  const provider = providerFor(ctx, svc.projectId, input.providerId);
  const client = clientFor(ctx, provider);
  let head: Awaited<ReturnType<typeof client.branchHead>>;
  try {
    await client.repo(input.repo);
    head = await client.branchHead(input.repo, input.branch);
  } catch (error) {
    throw new OpError("BAD_REQUEST", `"${provider.name}" cannot read ${input.repo}: ${describeProviderError(error)}`, { field: "repo" });
  }
  if (!head) throw new OpError("BAD_REQUEST", `${input.repo} has no branch ${input.branch}.`, { field: "branch" });
  const next = updateSpec(ctx, svc.id, (spec) => ({
    ...spec,
    source: {
      type: "provider",
      providerId: provider.id,
      provider: provider.kind,
      repo: input.repo,
      branch: input.branch,
      deployOnPush: input.deployOnPush,
    },
    build: { ...spec.build, contextPath: input.rootDir ?? spec.build.contextPath },
  }));
  ctx.db.delete(sourcePolls).where(eq(sourcePolls.serviceId, svc.id)).run();
  await ensureHook(ctx, { serviceId: svc.id, provider, repo: input.repo, origin: hookOrigin(ctx) });
  ctx.live.publish(`service:${svc.id}`, { type: "invalidate", ops: [contracts.webhook.id] });
  return toDetail(ctx.db, ctx.agents, next);
});

function toWebhook(ctx: OpContext, serviceId: string, row: WebhookRow | undefined): ProviderWebhook {
  const source = readSpec(loadService(ctx.db, serviceId).spec).source;
  const configured = source.type === "provider";
  return {
    configured,
    kind: configured ? source.provider : null,
    repo: configured ? source.repo : null,
    url: row?.url ?? null,
    created: Boolean(row?.remoteId),
    error: row ? row.error : configured ? "No webhook exists for this repository yet. Create it again." : null,
    insecure: row?.url?.startsWith("http://") ?? false,
    lastDeliveryAt: row?.lastDeliveryAt?.toISOString() ?? null,
    createdAt: row?.createdAt.toISOString() ?? null,
  };
}

const webhook = implement(contracts.webhook, (input, ctx) => toWebhook(ctx, input.serviceId, webhookOf(ctx, input.serviceId)));

const repairWebhook = implement(contracts.repairWebhook, async (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  const source = readSpec(svc.spec).source;
  if (source.type !== "provider") throw new OpError("CONFLICT", "The service's source is not a GitLab, Gitea or Bitbucket repository.");
  const provider = loadProvider(ctx.db, source.providerId);
  const row = await ensureHook(ctx, { serviceId: svc.id, provider, repo: source.repo, origin: hookOrigin(ctx), force: true });
  ctx.live.publish(`service:${svc.id}`, { type: "invalidate", ops: [contracts.webhook.id] });
  return toWebhook(ctx, svc.id, row);
});

export const providerHandlers = [list, create, update, remove, check, repos, branches, connectRepo, webhook, repairWebhook];
