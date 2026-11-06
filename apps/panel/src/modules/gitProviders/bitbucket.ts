// Bitbucket Cloud REST API 2.0 for one workspace. Workspace (or repository
// and project) access tokens are bearer tokens and clone as "x-token-auth";
// app passwords sign in with the account's user name, for the API and git.

import type { ChangedFiles, ClientConfig, CommitInfo, CommitStatusState, MergeRequestInfo, ProviderClient, RepoInfo } from "./client";
import { type ApiResponse, type ApiTarget, apiRequest, encodePath, ProviderApiError } from "./http";
import { bitbucketApi, bitbucketWeb } from "./rows";

interface BitbucketRepo {
  full_name: string;
  is_private: boolean;
  mainbranch?: { name: string } | null;
  updated_on: string | null;
}

interface BitbucketCommit {
  hash: string;
  message: string;
  author?: { raw?: string; user?: { nickname?: string; display_name?: string } | null } | null;
}

interface DiffStat {
  old?: { path: string } | null;
  new?: { path: string } | null;
}

interface Page<T> {
  values: T[];
  next?: string;
}

/** Pages of a diffstat read before the list counts as incomplete. */
const maxDiffPages = 10;

const stateMap: Record<CommitStatusState, string> = {
  pending: "INPROGRESS",
  running: "INPROGRESS",
  success: "SUCCESSFUL",
  failed: "FAILED",
  cancelled: "STOPPED",
};

function toRepo(r: BitbucketRepo): RepoInfo {
  return {
    fullName: r.full_name,
    private: r.is_private,
    defaultBranch: r.mainbranch?.name ?? null,
    updatedAt: r.updated_on ? new Date(r.updated_on).toISOString() : null,
  };
}

function toCommit(c: BitbucketCommit): CommitInfo {
  const author = c.author?.user?.nickname || c.author?.user?.display_name || c.author?.raw?.replace(/\s*<[^>]*>$/, "") || null;
  return { sha: c.hash, message: c.message ?? "", author };
}

/** The page/query of a "next" link: Bitbucket hands back absolute URLs on its own API host only. */
function nextQuery(next: string | undefined): Record<string, string> | null {
  if (!next) return null;
  const url = new URL(next);
  if (url.origin !== new URL(bitbucketApi).origin) return null;
  return Object.fromEntries(url.searchParams);
}

export function bitbucketClient({ deps, row, token }: ClientConfig): ProviderClient {
  const auth =
    row.authKind === "appPassword"
      ? { authorization: `Basic ${Buffer.from(`${row.username ?? ""}:${token}`).toString("base64")}` }
      : { authorization: `Bearer ${token}` };
  const target: ApiTarget = { label: "Bitbucket", base: bitbucketApi, auth };
  const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
    apiRequest<T>(deps, target, path, { query });
  const workspace = encodeURIComponent(row.workspace ?? "");

  const client: ProviderClient = {
    kind: "bitbucket",
    async whoami() {
      // Access tokens are no user (GET /user refuses them): reading the workspace proves the token.
      await get<Page<BitbucketRepo>>(`/repositories/${workspace}`, { pagelen: 1 });
      return row.authKind === "appPassword" ? (row.username ?? row.workspace ?? "") : (row.workspace ?? "");
    },
    async repos(query, page, perPage) {
      const res = await get<Page<BitbucketRepo>>(`/repositories/${workspace}`, {
        pagelen: perPage,
        page,
        sort: "-updated_on",
        q: query ? `name ~ "${query.replace(/["\\]/g, "")}"` : undefined,
      });
      return { repos: res.data.values.map(toRepo), hasMore: Boolean(res.data.next) };
    },
    async repo(repo) {
      return toRepo((await get<BitbucketRepo>(`/repositories/${encodePath(repo)}`)).data);
    },
    async branches(repo, query) {
      const out: string[] = [];
      let params: Record<string, string> | null = {
        pagelen: "100",
        ...(query ? { q: `name ~ "${query.replace(/["\\]/g, "")}"` } : {}),
      };
      for (let page = 0; params && page < 20; page++) {
        const res: ApiResponse<Page<{ name: string }>> = await get<Page<{ name: string }>>(
          `/repositories/${encodePath(repo)}/refs/branches`,
          params,
        );
        out.push(...res.data.values.map((b) => b.name));
        params = nextQuery(res.data.next);
      }
      return out;
    },
    async branchHead(repo, branch) {
      try {
        const { data } = await get<{ target: BitbucketCommit }>(`/repositories/${encodePath(repo)}/refs/branches/${encodePath(branch)}`);
        return toCommit(data.target);
      } catch (error) {
        if (error instanceof ProviderApiError && error.status === 404) return null;
        throw error;
      }
    },
    async commit(repo, ref) {
      return toCommit((await get<BitbucketCommit>(`/repositories/${encodePath(repo)}/commit/${encodeURIComponent(ref)}`)).data);
    },
    async compare(repo, before, after): Promise<ChangedFiles> {
      // "<new>..<old>": the changes of new since its merge base with old (Bitbucket's pull request direction).
      const files = new Set<string>();
      let params: Record<string, string> | null = { pagelen: "500" };
      let pages = 0;
      while (params && pages < maxDiffPages) {
        const res: ApiResponse<Page<DiffStat>> = await get<Page<DiffStat>>(
          `/repositories/${encodePath(repo)}/diffstat/${encodeURIComponent(after)}..${encodeURIComponent(before)}`,
          params,
        );
        for (const d of res.data.values) {
          if (d.new?.path) files.add(d.new.path);
          if (d.old?.path) files.add(d.old.path);
        }
        params = nextQuery(res.data.next);
        pages++;
      }
      return { files: [...files], complete: params === null };
    },
    async mergeRequest(repo, number): Promise<MergeRequestInfo> {
      const { data } = await get<{
        id: number;
        title: string;
        state: string;
        source: { branch: { name: string }; commit: { hash: string }; repository: { full_name: string } | null };
        destination: { branch: { name: string }; repository: { full_name: string } };
      }>(`/repositories/${encodePath(repo)}/pullrequests/${number}`);
      // Pull request payloads carry short hashes: read the full one.
      const head = await client.commit(data.source.repository?.full_name ?? repo, data.source.commit.hash);
      return {
        number: data.id,
        title: data.title,
        state: data.state === "OPEN" ? "open" : data.state === "MERGED" ? "merged" : "closed",
        headBranch: data.source.branch.name,
        headSha: head.sha,
        headRepo: data.source.repository?.full_name ?? "",
        baseBranch: data.destination.branch.name,
        baseRepo: data.destination.repository.full_name,
      };
    },
    async createHook(repo, hook) {
      const { data } = await apiRequest<{ uuid: string }>(deps, target, `/repositories/${encodePath(repo)}/hooks`, {
        method: "POST",
        body: {
          description: "Deploy on push",
          url: hook.url,
          active: true,
          secret: hook.secret,
          events: ["repo:push", "pullrequest:created", "pullrequest:updated", "pullrequest:fulfilled", "pullrequest:rejected"],
        },
      });
      return data.uuid;
    },
    async deleteHook(repo, id) {
      try {
        await apiRequest(deps, target, `/repositories/${encodePath(repo)}/hooks/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (error) {
        if (error instanceof ProviderApiError && error.status === 404) return;
        throw error;
      }
    },
    async setStatus(repo, sha, status) {
      // Bitbucket requires a link; without a public panel address there is nothing to point at.
      if (!status.targetUrl) return;
      await apiRequest(deps, target, `/repositories/${encodePath(repo)}/commit/${encodeURIComponent(sha)}/statuses/build`, {
        method: "POST",
        body: {
          key: status.context.slice(0, 40),
          name: status.context,
          state: stateMap[status.state],
          description: status.description.slice(0, 255),
          url: status.targetUrl,
        },
      });
    },
    cloneUrl(repo) {
      return `${bitbucketWeb}/${repo}.git`;
    },
    gitUsername() {
      return row.authKind === "appPassword" ? (row.username ?? "") : "x-token-auth";
    },
  };
  return client;
}
