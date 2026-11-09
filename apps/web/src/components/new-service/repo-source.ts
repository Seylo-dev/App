// Which source the New app dialog creates for its Repository field. A
// repository read through one of the panel's connections (a GitHub App
// installation, a GitLab, Gitea/Forgejo or Bitbucket connection) becomes a
// GitHub or provider source, which deploys on push like the Source tab's
// forms; anything else becomes a plain git URL (owner/repo expanded to
// https://github.com/owner/repo.git), public, deploying only through the
// deploy trigger. A typed repository counts as one of a connection's when
// that connection reads it by its exact name (github.branches /
// gitProviders.branches, the same check connectRepo makes): the account
// alone says nothing about which repositories an installation may read.
// Only a clear answer decides: NOT_FOUND (it cannot read it) and FORBIDDEN
// (the connection is not usable here); any other failure leaves the field
// unchecked, so a private repository never quietly becomes a public URL.

import { actionAllowed, OpError, services } from "@seylo/ops";
import type { HostKind, KnownHost, RepoParse, RepoProblem, RepoRef } from "./repo-input";

export type ConnectionKind = HostKind;

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
  /** null when not known (a typed repository the connection was asked for by name). */
  private: boolean | null;
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

/**
 * What a connection answered when asked for a typed repository by name:
 * found (it reads it), missing (NOT_FOUND: it cannot, or there is no such
 * repository), refused (FORBIDDEN: not usable in this project), failed (no
 * answer to go by: the provider is down, a rate limit, a timeout).
 */
export interface RepoLookup {
  connection: Connection;
  /** The repository's full name in that connection. */
  path: string;
  state: "pending" | "found" | "missing" | "refused" | "failed";
  /** The default branch, once found. */
  defaultBranch: string | null;
  error: unknown;
}

/** The list a typed repository's connections come from. */
export type ConnectionList = "github" | "providers";

export type RepoDecision =
  /** Nothing usable typed. */
  | { type: "none"; problem: RepoProblem }
  /** Still asking the connections whether they hold it; needsProject: they can only be asked once a project is picked. */
  | { type: "checking"; repo: RepoRef; needsProject?: boolean }
  /** A connection, or the list of them, did not answer: nothing to create until it does. */
  | { type: "unchecked"; repo: RepoRef; failed: Connection | ConnectionList; error: unknown }
  /** Through a GitHub App installation or a git provider connection: deploys on push. */
  | { type: "connected"; found: FoundRepo }
  /** A plain git URL. missedIn: a connection that could have held it and cannot read it. */
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

/** The connections' servers, so the parser reads a self-managed GitLab's or Gitea's page addresses like gitlab.com's. */
export function knownHostsOf(connections: readonly Connection[]): KnownHost[] {
  return connections.flatMap((connection) => {
    const base = baseOf(connection);
    return base.host ? [{ host: base.host, kind: connection.kind, prefix: base.prefix }] : [];
  });
}

/** The repository names github.branches and gitProviders.branches take. */
const githubRepoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const providerRepoName = new RegExp(services.RepoFullPath.pattern as string);

/**
 * The full name a typed repository would have in a connection, or null
 * when it cannot be in it (another host, another GitHub account, a path
 * outside a self-managed server's prefix, a name the connection's ops
 * refuse). SSH addresses match on the host name alone: the connection
 * clones over https with its token.
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
  const valid = connection.kind === "github" ? githubRepoName.test(path) : providerRepoName.test(path) && path.length <= 300;
  return valid ? path : null;
}

/** The list a typed repository's connections are in: the GitHub App's installations for github.com, the providers for any other host. */
export function listFor(repo: RepoRef): ConnectionList {
  return repo.host.replace(/:\d+$/, "") === "github.com" ? "github" : "providers";
}

/**
 * What a failed lookup says. NOT_FOUND for the repository (details.field
 * "repo": the connection cannot read it) and FORBIDDEN are answers; anything
 * else is none, a NOT_FOUND for the connection itself (deleted meanwhile)
 * included.
 */
export function lookupStateOf(error: unknown): "missing" | "refused" | "failed" {
  if (error instanceof OpError && error.code === "NOT_FOUND" && error.details?.field === "repo") return "missing";
  if (error instanceof OpError && error.code === "FORBIDDEN") return "refused";
  return "failed";
}

/** The text the Repository field shows for a picked repository: what typing it would find again. */
export function textFor(found: FoundRepo): string {
  if (found.connection.kind === "github") return found.repo.fullName;
  const base = baseOf(found.connection);
  return [base.host, base.prefix, found.repo.fullName].filter(Boolean).join("/");
}

/**
 * The source for the field: a picked repository; else the first
 * connection (in order) that reads the typed one; else, when one did not
 * answer, unchecked; else a plain git URL. While a connection that could
 * hold it has not answered, "checking". A connection that refused
 * (FORBIDDEN for someone it is not shared with in this project) does not
 * hold it and is not mentioned; one that cannot read it (NOT_FOUND) is the
 * one the line names.
 */
export function decideSource(parse: RepoParse, picked: FoundRepo | null, lookups: RepoLookup[]): RepoDecision {
  if (picked) return { type: "connected", found: picked };
  if (!parse.ok) return { type: "none", problem: parse.problem };
  if (lookups.some((lookup) => lookup.state === "pending")) return { type: "checking", repo: parse.repo };
  const found = lookups.find((lookup) => lookup.state === "found");
  if (found) {
    const repo: RepoInfo = { fullName: found.path, private: null, defaultBranch: found.defaultBranch, updatedAt: null };
    return { type: "connected", found: { connection: found.connection, repo } };
  }
  const failed = lookups.find((lookup) => lookup.state === "failed");
  if (failed) return { type: "unchecked", repo: parse.repo, failed: failed.connection, error: failed.error };
  const missed = lookups.find((lookup) => lookup.state === "missing");
  return { type: "git", repo: parse.repo, missedIn: missed?.connection ?? null };
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

/**
 * Which repository the text names, whatever it is typed as and whatever
 * the connections answer: "github.com/acme/app" for acme/app, its URL and
 * git@github.com:acme/app.git alike. "" for no repository. A branch edited
 * for one repository is dropped when this changes.
 */
export function repoKeyOf(parse: RepoParse): string {
  return parse.ok ? `${parse.repo.host.replace(/:\d+$/, "")}/${parse.repo.path}`.toLowerCase() : "";
}

type Grant = { scopeType: "project" | "service"; scopeId: string; actions: readonly string[] };

/**
 * Whether connecting a repository can work for the person: connectRepo
 * needs services.update on the new service, which owners and admins hold
 * and a member holds through a project grant (a service grant cannot cover
 * a service that does not exist yet). Without it the field makes plain git
 * URLs, which services.create alone stores.
 */
export function mayConnectIn(role: string | undefined, grants: readonly Grant[], projectId: string): boolean {
  if (role === "owner" || role === "admin") return true;
  return grants.some((g) => g.scopeType === "project" && g.scopeId === projectId && actionAllowed(g.actions, "services.update"));
}
