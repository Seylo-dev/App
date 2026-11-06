// Gitea and Forgejo REST API v1 (Forgejo keeps Gitea's API and webhook
// format). Access tokens go in "Authorization: token"; clones use the
// token's owner as the user name.

import type { ChangedFiles, ClientConfig, CommitInfo, CommitStatusState, MergeRequestInfo, ProviderClient, RepoInfo } from "./client";
import { type ApiTarget, apiRequest, encodePath, ProviderApiError } from "./http";

interface GiteaRepo {
  full_name: string;
  private: boolean;
  default_branch: string | null;
  empty?: boolean;
  updated_at: string | null;
}

interface GiteaPayloadCommit {
  id: string;
  message: string;
  author?: { name?: string; username?: string } | null;
}

const stateMap: Record<CommitStatusState, string> = {
  pending: "pending",
  running: "pending",
  success: "success",
  failed: "failure",
  cancelled: "error",
};

function toRepo(r: GiteaRepo): RepoInfo {
  return {
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.empty ? null : r.default_branch || null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

export function giteaClient({ deps, row, token }: ClientConfig): ProviderClient {
  const target: ApiTarget = { label: "Gitea", base: `${row.url}/api/v1`, auth: { authorization: `token ${token}` } };
  const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
    apiRequest<T>(deps, target, path, { query });
  let me: { id: number; login: string } | null = null;
  const user = async () => {
    me ??= (await get<{ id: number; login: string }>("/user")).data;
    return me;
  };

  return {
    kind: "gitea",
    async whoami() {
      return (await user()).login;
    },
    async repos(query, page, perPage) {
      const { id } = await user();
      const res = await get<{ data: GiteaRepo[] }>("/repos/search", {
        q: query || undefined,
        uid: id,
        exclusive: false,
        sort: "updated",
        order: "desc",
        limit: perPage,
        page,
      });
      const total = Number(res.headers.get("x-total-count") ?? "0");
      const repos = (res.data.data ?? []).map(toRepo);
      return { repos, hasMore: total > 0 ? page * perPage < total : repos.length === perPage };
    },
    async repo(repo) {
      return toRepo((await get<GiteaRepo>(`/repos/${encodePath(repo)}`)).data);
    },
    async branches(repo, query) {
      const out: string[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await get<{ name: string }[]>(`/repos/${encodePath(repo)}/branches`, { page, limit: 50 });
        out.push(...res.data.map((b) => b.name));
        if (res.data.length < 50) break;
      }
      const q = query.toLowerCase();
      return q ? out.filter((b) => b.toLowerCase().includes(q)) : out;
    },
    async branchHead(repo, branch) {
      try {
        const { data } = await get<{ commit: GiteaPayloadCommit }>(`/repos/${encodePath(repo)}/branches/${encodePath(branch)}`);
        return {
          sha: data.commit.id,
          message: data.commit.message ?? "",
          author: data.commit.author?.username || data.commit.author?.name || null,
        };
      } catch (error) {
        if (error instanceof ProviderApiError && error.status === 404) return null;
        throw error;
      }
    },
    async commit(repo, ref): Promise<CommitInfo> {
      const { data } = await get<{
        sha: string;
        commit: { message: string; author?: { name?: string } };
        author?: { login?: string } | null;
      }>(`/repos/${encodePath(repo)}/git/commits/${encodeURIComponent(ref)}`, { stat: false, files: false, verification: false });
      return { sha: data.sha, message: data.commit.message ?? "", author: data.author?.login || data.commit.author?.name || null };
    },
    async compare(repo, before, after): Promise<ChangedFiles> {
      // Gitea 1.22 and later (and Forgejo 8): the commits between the two, each with its files.
      const { data } = await get<{ total_commits: number; commits: { files?: { filename: string }[] | null }[] }>(
        `/repos/${encodePath(repo)}/compare/${encodeURIComponent(before)}...${encodeURIComponent(after)}`,
      );
      const files = new Set<string>();
      let listed = true;
      for (const c of data.commits ?? []) {
        if (!Array.isArray(c.files)) listed = false;
        for (const f of c.files ?? []) files.add(f.filename);
      }
      return { files: [...files], complete: listed && (data.commits?.length ?? 0) >= (data.total_commits ?? 0) };
    },
    async mergeRequest(repo, number): Promise<MergeRequestInfo> {
      const { data } = await get<{
        number: number;
        title: string;
        state: string;
        merged: boolean;
        head: { ref: string; sha: string; repo: { full_name: string } | null };
        base: { ref: string; repo: { full_name: string } };
      }>(`/repos/${encodePath(repo)}/pulls/${number}`);
      return {
        number: data.number,
        title: data.title,
        state: data.state === "open" ? "open" : data.merged ? "merged" : "closed",
        headBranch: data.head.ref,
        headSha: data.head.sha,
        headRepo: data.head.repo?.full_name ?? "",
        baseBranch: data.base.ref,
        baseRepo: data.base.repo.full_name,
      };
    },
    async createHook(repo, hook) {
      const { data } = await apiRequest<{ id: number }>(deps, target, `/repos/${encodePath(repo)}/hooks`, {
        method: "POST",
        body: {
          type: "gitea",
          active: true,
          events: ["push", "pull_request"],
          branch_filter: "*",
          config: { url: hook.url, content_type: "json", secret: hook.secret },
        },
      });
      return String(data.id);
    },
    async deleteHook(repo, id) {
      try {
        await apiRequest(deps, target, `/repos/${encodePath(repo)}/hooks/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (error) {
        if (error instanceof ProviderApiError && error.status === 404) return;
        throw error;
      }
    },
    async setStatus(repo, sha, status) {
      await apiRequest(deps, target, `/repos/${encodePath(repo)}/statuses/${encodeURIComponent(sha)}`, {
        method: "POST",
        body: {
          state: stateMap[status.state],
          context: status.context,
          description: status.description.slice(0, 255),
          ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
        },
      });
    },
    cloneUrl(repo) {
      return `${row.url}/${repo}.git`;
    },
    gitUsername() {
      return row.account || "git";
    },
  };
}
