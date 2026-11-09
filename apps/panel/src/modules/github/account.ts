// The panel's connected GitHub account (Settings > GitHub, "Private
// repositories without the App"): one per panel, a git credential for
// github.com with origin "device" (the device flow, like gh auth login) or
// "github_token" (a pasted personal access token). Its token lists the
// repositories the account reaches (GET /user/repos), reads branches,
// clones (sent to the build node like any git credential, for that clone
// only) and creates repository webhooks when it may (repo-hooks.ts). A
// GitHub source read through it names the row in accountId; connecting an
// account again keeps the row's id, and a source whose row is gone uses the
// account connected now, since there is only ever one.

import { type github as githubOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { desc, eq, inArray } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import type { PanelDb } from "../../db/client";
import { gitCredentials } from "../../db/schema";
import type { Deps } from "../../deps";
import type { OpContext } from "../../ops/implement";
import type { SecretBox } from "../../security/secret-box";
import { type GitCredentialRow, loadCredential } from "../git/credentials";
import { GithubApiError, githubPages, githubRequest } from "./api";
import { tokenForInstallation } from "./app";

export type GithubAccount = Static<typeof githubOps.GithubAccount>;

export const accountOrigins = ["device", "github_token"] as const;

/** The panel's connected GitHub account, if there is one (the newest, should there ever be two). */
export function connectedAccount(db: PanelDb): GitCredentialRow | undefined {
  return db
    .select()
    .from(gitCredentials)
    .where(inArray(gitCredentials.origin, [...accountOrigins]))
    .orderBy(desc(gitCredentials.updatedAt))
    .get();
}

function isAccount(row: GitCredentialRow): boolean {
  return (accountOrigins as readonly string[]).includes(row.origin);
}

/** "repo, read:org" -> ["repo", "read:org"]. */
export function scopesOf(row: Pick<GitCredentialRow, "scopes">): string[] {
  return (row.scopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A fine-grained token says nothing about scopes: its repositories and permissions are set on GitHub. */
export function tokenKindOf(row: Pick<GitCredentialRow, "origin" | "scopes">): "classic" | "fineGrained" {
  return row.origin === "github_token" && row.scopes === "" ? "fineGrained" : "classic";
}

export function toAccount(row: GitCredentialRow): GithubAccount {
  return {
    id: row.id,
    login: row.githubLogin ?? row.username ?? "",
    method: row.origin === "github_token" ? "token" : "device",
    scopes: scopesOf(row),
    tokenKind: tokenKindOf(row),
    connectedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The account an op names by id: it must be the connected one (an id from
 * github.installations). NOT_FOUND for anything else, a manual git
 * credential included.
 */
export function accountById(db: PanelDb, accountId: string, field = "accountId"): GitCredentialRow {
  const current = connectedAccount(db);
  if (!current || current.id !== accountId) {
    throw new OpError("NOT_FOUND", "No connected GitHub account with this id. Connect one in Settings > GitHub.", { field });
  }
  return current;
}

/**
 * The account a stored source reads through: its own row while it exists,
 * else the account connected now (disconnected and connected again), else
 * CONFLICT with what to do.
 */
export function accountForSource(db: PanelDb, accountId: string | null | undefined): GitCredentialRow {
  if (accountId) {
    try {
      const row = loadCredential(db, accountId);
      if (isAccount(row)) return row;
    } catch {
      // Gone: the current account below.
    }
  }
  const current = connectedAccount(db);
  if (current) return current;
  throw new OpError(
    "CONFLICT",
    "The GitHub account this service reads its repository through is disconnected. Connect one in Settings > GitHub, or connect the repository through the GitHub App.",
    { reason: "noGithubAccount" },
  );
}

export function accountToken(secrets: SecretBox, row: GitCredentialRow): string {
  const token = secrets.open(row.secretSealed, "git.credential");
  if (token === null) throw new OpError("CONFLICT", "The connected GitHub account's token cannot be opened. Connect the account again.");
  return token;
}

export interface GithubSourceRef {
  installationId: string | null;
  accountId?: string | null;
}

/**
 * The token a GitHub source reads its repository with, and the user name
 * git sends with it: an installation token (the agent's default user) or
 * the connected account's token (its login).
 */
export async function githubSourceAuth(
  deps: Pick<Deps, "db" | "secrets">,
  source: GithubSourceRef,
): Promise<{ token: string; username: string; via: "installation" | "account"; label: string }> {
  if (source.installationId) {
    return {
      token: await tokenForInstallation(deps.db, deps.secrets, source.installationId),
      username: "",
      via: "installation",
      label: "",
    };
  }
  const row = accountForSource(deps.db, source.accountId);
  const login = row.githubLogin ?? row.username ?? "";
  return { token: accountToken(deps.secrets, row), username: login, via: "account", label: `@${login}` };
}

/** Whether the account's token may create repository webhooks: true, false, or null when GitHub decides (a fine-grained token). */
export function mayCreateHooks(row: Pick<GitCredentialRow, "origin" | "scopes">): boolean | null {
  if (tokenKindOf(row) === "fineGrained") return null;
  const scopes = scopesOf(row);
  return scopes.includes("repo") || scopes.includes("admin:repo_hook") || scopes.includes("write:repo_hook");
}

export interface GithubRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
}

/** /user/repos for everything the account reaches: its own, ones it collaborates on, its organizations'. */
export const userReposPath = "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed";
/** Pages of 100 read at most (1,000 repositories). */
export const userRepoPages = 10;

const repoCache = new WeakMap<object, Map<string, { at: number; key: string; repos: GithubRepo[] }>>();

/**
 * Every repository the account reaches, read once a minute at most (and
 * again as soon as the account's token changes).
 */
export async function accountRepos(deps: Pick<Deps, "db" | "secrets">, row: GitCredentialRow): Promise<GithubRepo[]> {
  let cache = repoCache.get(deps.db);
  if (!cache) {
    cache = new Map();
    repoCache.set(deps.db, cache);
  }
  const hit = cache.get(row.id);
  if (hit && hit.key === row.secretSealed && Date.now() - hit.at < 60_000) return hit.repos;
  const repos = await githubPages<GithubRepo>(
    userReposPath,
    accountToken(deps.secrets, row),
    (page) => page as GithubRepo[],
    userRepoPages,
  );
  cache.set(row.id, { at: Date.now(), key: row.secretSealed, repos });
  return repos;
}

export function forgetAccountRepos(db: PanelDb): void {
  repoCache.delete(db);
}

/** Where people create a token, and the scopes a classic one needs. */
export const tokensPage = "https://github.com/settings/tokens";

/**
 * Checks a pasted token before it is stored: GitHub must accept it
 * (api.github.com/user), a classic token needs the repo scope, and a
 * fine-grained one must reach a repository and read its code (Contents:
 * Read; Metadata: Read comes with any repository access). Answers who the
 * token is and its scopes (empty for a fine-grained token).
 */
export async function checkGithubToken(token: string): Promise<{ login: string; scopes: string[]; fineGrained: boolean }> {
  let user: Awaited<ReturnType<typeof githubRequest<{ login: string }>>>;
  try {
    user = await githubRequest<{ login: string }>("/user", { auth: token });
  } catch (error) {
    if (error instanceof GithubApiError && (error.status === 401 || error.status === 403)) {
      throw new OpError("BAD_REQUEST", "GitHub did not accept this token. Check it was copied whole and has not expired.", {
        field: "token",
        reason: "rejected",
      });
    }
    throw new OpError("UNAVAILABLE", "GitHub did not answer. Try again in a moment.", { field: "token" });
  }
  const login = user.data.login;
  // Classic tokens (and device logins) list their scopes; fine-grained tokens send no such header.
  if (user.scopes !== null && !token.startsWith("github_pat_")) {
    const scopes = user.scopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!scopes.includes("repo")) {
      throw new OpError(
        "BAD_REQUEST",
        "This classic token has no repo scope, so it cannot read private repositories. Create one with the repo scope, or a fine-grained token with Contents: Read.",
        { field: "token", reason: "scope" },
      );
    }
    return { login, scopes, fineGrained: false };
  }
  const first = await githubRequest<GithubRepo[]>(`${userReposPath}&per_page=1`, { auth: token }).catch(() => null);
  const repo = first?.data?.[0];
  if (!repo) {
    throw new OpError(
      "BAD_REQUEST",
      "This token reaches no repository. On GitHub, give it access to the repositories you deploy (Repository access), with Contents: Read.",
      { field: "token", reason: "noRepos" },
    );
  }
  try {
    await githubRequest(`/repos/${repo.full_name}/commits?per_page=1`, { auth: token });
  } catch (error) {
    // 409: an empty repository, which still says the token may read it.
    if (!(error instanceof GithubApiError) || error.status !== 409) {
      throw new OpError(
        "BAD_REQUEST",
        `This token cannot read the code of ${repo.full_name}. Give it Contents: Read under Repository permissions.`,
        { field: "token", reason: "contents" },
      );
    }
  }
  return { login, scopes: [], fineGrained: true };
}

/**
 * Stores the account's token, replacing the connected account in place
 * (its id stays, so services that read through it keep working).
 */
export function saveAccount(
  ctx: Pick<OpContext, "db" | "secrets" | "principal">,
  input: { token: string; login: string; scopes: string[]; origin: (typeof accountOrigins)[number] },
): GitCredentialRow {
  const existing = connectedAccount(ctx.db);
  const values = {
    name: `GitHub (${input.login})`,
    kind: "token" as const,
    host: "github.com",
    username: input.login,
    secretSealed: ctx.secrets.seal(input.token, "git.credential"),
    origin: input.origin,
    githubLogin: input.login,
    scopes: input.scopes.join(","),
    createdBy: userOf(ctx.principal)?.id ?? null,
    updatedAt: new Date(),
  };
  forgetAccountRepos(ctx.db);
  return existing
    ? ctx.db.update(gitCredentials).set(values).where(eq(gitCredentials.id, existing.id)).returning().get()
    : ctx.db.insert(gitCredentials).values(values).returning().get();
}
