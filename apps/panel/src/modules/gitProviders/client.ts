// What the panel asks of a git provider, the same for GitLab, Gitea/Forgejo
// and Bitbucket Cloud. One client per connection row; every call goes to
// that connection's own API base (http.ts).

import { OpError } from "@seylo/ops";
import type { GitProviderKind } from "../../db/schema";
import type { Deps } from "../../deps";
import { bitbucketClient } from "./bitbucket";
import { giteaClient } from "./gitea";
import { gitlabClient } from "./gitlab";
import { openToken, type ProviderRow } from "./rows";

export interface CommitInfo {
  sha: string;
  /** Full message; screens use the first line. */
  message: string;
  author: string | null;
}

export interface RepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  updatedAt: string | null;
}

/** Files that differ between two commits; complete false when the provider capped the list. */
export interface ChangedFiles {
  files: string[];
  complete: boolean;
}

export interface MergeRequestInfo {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  /** Full commit id of the head. */
  headSha: string;
  /** Repository the head branch lives in; another one than the base means a fork. */
  headRepo: string;
  baseBranch: string;
  baseRepo: string;
}

export type CommitStatusState = "pending" | "running" | "success" | "failed" | "cancelled";

export interface CommitStatus {
  state: CommitStatusState;
  /** Shown as the check's name, for example "seylo/web". */
  context: string;
  description: string;
  /** Link to the deployment; null while the panel has no public address. */
  targetUrl: string | null;
}

export interface ProviderClient {
  readonly kind: GitProviderKind;
  /** Who the token acts as; throws when it does not work. */
  whoami(): Promise<string>;
  repos(query: string, page: number, perPage: number): Promise<{ repos: RepoInfo[]; hasMore: boolean }>;
  repo(repo: string): Promise<RepoInfo>;
  /** Branch names, up to a few thousand, filtered by query when given. */
  branches(repo: string, query: string): Promise<string[]>;
  /** The branch's head commit, or null when the branch does not exist. */
  branchHead(repo: string, branch: string): Promise<CommitInfo | null>;
  commit(repo: string, ref: string): Promise<CommitInfo>;
  compare(repo: string, before: string, after: string): Promise<ChangedFiles>;
  mergeRequest(repo: string, number: number): Promise<MergeRequestInfo>;
  /** Creates the repository webhook (pushes and merge/pull requests); returns the provider's id for it. */
  createHook(repo: string, hook: { url: string; secret: string }): Promise<string>;
  /** Deletes a webhook; one that is already gone is fine. */
  deleteHook(repo: string, id: string): Promise<void>;
  setStatus(repo: string, sha: string, status: CommitStatus): Promise<void>;
  /** HTTPS clone address on the connection's host. */
  cloneUrl(repo: string): string;
  /** HTTPS user name to clone with the token. */
  gitUsername(): string;
}

export interface ClientConfig {
  deps: Pick<Deps, "db">;
  row: ProviderRow;
  token: string;
}

export function clientFor(deps: Pick<Deps, "db" | "secrets">, row: ProviderRow): ProviderClient {
  const config = { deps, row, token: openToken(deps.secrets, row) };
  switch (row.kind) {
    case "gitlab":
      return gitlabClient(config);
    case "gitea":
      return giteaClient(config);
    case "bitbucket":
      return bitbucketClient(config);
    default:
      throw new OpError("CONFLICT", "This connection's provider is not supported.");
  }
}

export const providerLabels: Record<GitProviderKind, string> = { gitlab: "GitLab", gitea: "Gitea", bitbucket: "Bitbucket" };

/** The all-zero id providers send for "no commit" (a new or deleted branch). */
export function isNullSha(sha: string | null | undefined): boolean {
  return !sha || /^0+$/.test(sha);
}
