// Which source the New app dialog creates for its Repository field. A
// repository read through one of the panel's connections (a GitHub App
// installation, a GitLab, Gitea/Forgejo or Bitbucket connection) becomes a
// GitHub or provider source, which deploys on push like the Source tab's
// forms; anything else becomes a plain git URL (owner/repo expanded to
// https://github.com/owner/repo.git), public, deploying only through the
// deploy trigger. A typed repository counts as one of a connection's when
// that connection lists it (github.repos / gitProviders.repos): the
// account alone says nothing about which repositories an installation may
// read.

import type { services } from "@seylo/ops";
import type { RepoParse, RepoProblem, RepoRef } from "./repo-input";

export type ConnectionKind = "github" | "gitlab" | "gitea" | "bitbucket";

/** A place the panel lists repositories from. */
export interface Connection {
  kind: ConnectionKind;
  /** github_installations.id or git_providers.id. */
  id: string;
  /** The installation's account ("acme") or the connection's name ("Company GitLab"). */
  label: string;
  /** Web address the repositories live under: "https://github.com" or the connection's url. */
  baseUrl: string;
  /** The one account or workspace it holds repositories of: a GitHub installation's login, a Bitbucket workspace. */
  owner: string | null;
}

export interface RepoInfo {
  /** "owner/name", "group/sub/project" or "workspace/slug". */
  fullName: string;
  private: boolean;
  /** null for an empty repository. */
  defaultBranch: string | null;
  /** Last push or activity, for the list. */
  updatedAt: string | null;
}

/** A repository and the connection it is read through. */
export interface FoundRepo {
  connection: Connection;
  repo: RepoInfo;
}

/** What a connection answered when asked for a typed repository. */
export interface RepoLookup {
  connection: Connection;
  /** The repository's full name in that connection. */
  path: string;
  state: "pending" | "done" | "failed";
  repos: RepoInfo[];
}

export type RepoDecision =
  /** Nothing usable typed. */
  | { type: "none"; problem: RepoProblem }
  /** Still asking the connections whether they hold it. */
  | { type: "checking"; repo: RepoRef }
  /** Through a GitHub App installation or a git provider connection: deploys on push. */
  | { type: "connected"; found: FoundRepo }
  /** A plain git URL. missedIn: a connection that could have held it but does not list it. */
  | { type: "git"; repo: RepoRef; missedIn: Connection | null };

type Installation = { id: string; accountLogin: string; suspended: boolean };
type Provider = { id: string; kind: Exclude<ConnectionKind, "github">; name: string; url: string; workspace: string | null };

/**
 * The connections a person can pick from: installations that are not
 * suspended (the Source tab's rule) and every git provider connection.
 * A hidden list (github.installations / gitProviders.list for someone who
 * may not see them) gives none.
 */
export function connectionsOf(
  installations: { installations: Installation[]; hidden?: boolean } | undefined,
  providers: { items: Provider[]; hidden?: boolean } | undefined,
): Connection[] {
  const github: Connection[] = installations?.hidden
    ? []
    : (installations?.installations ?? [])
        .filter((i) => !i.suspended)
        .map((i) => ({ kind: "github", id: i.id, label: i.accountLogin, baseUrl: "https://github.com", owner: i.accountLogin }));
  const others: Connection[] = providers?.hidden
    ? []
    : (providers?.items ?? []).map((p) => ({ kind: p.kind, id: p.id, label: p.name, baseUrl: p.url, owner: p.workspace }));
  return [...github, ...others];
}

/** "https://Git.Example.com/gitlab/" -> { host: "git.example.com", prefix: "gitlab" }. */
function baseOf(connection: Connection): { host: string; hostname: string; prefix: string } {
  try {
    const url = new URL(connection.baseUrl);
    return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase(), prefix: url.pathname.replace(/^\/+|\/+$/g, "") };
  } catch {
    return { host: "", hostname: "", prefix: "" };
  }
}

/**
 * The full name a typed repository would have in a connection, or null
 * when it cannot be in it (another host, another GitHub account, a path
 * outside a self-managed server's prefix). SSH addresses match on the
 * host name alone: the connection clones over https with its token.
 */
export function pathIn(connection: Connection, repo: RepoRef): string | null {
  const base = baseOf(connection);
  const repoHostname = repo.host.replace(/:\d+$/, "");
  if (repo.ssh ? repoHostname !== base.hostname : repo.host !== base.host) return null;
  let path = repo.path;
  if (base.prefix && !repo.ssh) {
    if (!path.toLowerCase().startsWith(`${base.prefix.toLowerCase()}/`)) return null;
    path = path.slice(base.prefix.length + 1);
  }
  const parts = path.split("/");
  if (parts.length < 2) return null;
  // GitHub and Bitbucket repositories are owner/name, and such a connection holds one owner's.
  if (connection.kind === "github" || connection.kind === "bitbucket") {
    if (parts.length !== 2) return null;
    if (connection.owner && parts[0]?.toLowerCase() !== connection.owner.toLowerCase()) return null;
  }
  return path;
}

/** The text the Repository field shows for a picked repository: what typing it would find again. */
export function textFor(found: FoundRepo): string {
  if (found.connection.kind === "github") return found.repo.fullName;
  const base = baseOf(found.connection);
  return [base.host, base.prefix, found.repo.fullName].filter(Boolean).join("/");
}

/**
 * The source for the field: a picked repository; else the first
 * connection (in order) that lists the typed one; else a plain git URL.
 * While a connection that could hold it has not answered, "checking".
 * A connection that failed to answer (FORBIDDEN for someone it is not
 * shared with in this project, a rate limit) does not hold it.
 */
export function decideSource(parse: RepoParse, picked: FoundRepo | null, lookups: RepoLookup[]): RepoDecision {
  if (picked) return { type: "connected", found: picked };
  if (!parse.ok) return { type: "none", problem: parse.problem };
  let missedIn: Connection | null = null;
  for (const lookup of lookups) {
    if (lookup.state === "pending") return { type: "checking", repo: parse.repo };
    if (lookup.state === "failed") continue;
    const hit = lookup.repos.find((r) => r.fullName.toLowerCase() === lookup.path.toLowerCase());
    if (hit) return { type: "connected", found: { connection: lookup.connection, repo: hit } };
    missedIn ??= lookup.connection;
  }
  return { type: "git", repo: parse.repo, missedIn };
}

type Source = (typeof services.Source)["static"];

/**
 * The source to store, with the Source tab's deploy-on-push defaults: on
 * for GitHub and provider repositories (their pushes reach the panel), off
 * for a git URL (it deploys on push only through the deploy trigger URL).
 * null while there is nothing to create.
 */
export function sourceFor(decision: RepoDecision, branch: string): Source | null {
  if (decision.type === "connected") {
    const { connection, repo } = decision.found;
    if (connection.kind === "github") {
      return { type: "github", installationId: connection.id, repo: repo.fullName, branch, deployOnPush: true };
    }
    return { type: "provider", providerId: connection.id, provider: connection.kind, repo: repo.fullName, branch, deployOnPush: true };
  }
  if (decision.type === "git") return { type: "git", url: decision.repo.url, branch, credentialId: null, deployOnPush: false };
  return null;
}

/** A stable key for the repository a decision names, to tell when it changed. */
export function decisionKey(decision: RepoDecision): string {
  if (decision.type === "connected") return `${decision.found.connection.id}:${decision.found.repo.fullName.toLowerCase()}`;
  if (decision.type === "git" || decision.type === "checking") return decision.repo.url;
  return "";
}
