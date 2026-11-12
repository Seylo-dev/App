// GitLab REST API v4 (gitlab.com or self-managed, also under a path such
// as https://example.com/gitlab). Projects are addressed by their URL-encoded
// path, so the panel never stores numeric ids. Personal, group and project
// access tokens all work with PRIVATE-TOKEN and clone as "oauth2".

import type { ChangedFiles, ClientConfig, CommitInfo, CommitStatusState, MergeRequestInfo, ProviderClient, RepoInfo } from "./client";
import { type ApiTarget, apiRequest, encodeSegment, ProviderApiError } from "./http";

interface GitlabProject {
  path_with_namespace: string;
  default_branch: string | null;
  visibility: string;
  last_activity_at: string | null;
}

interface GitlabCommit {
  id: string;
  message: string;
  author_name: string | null;
}

/** Most entries GitLab's compare returns before it stops listing diffs. */
const compareFileCap = 1000;

const stateMap: Record<CommitStatusState, string> = {
  pending: "pending",
  running: "running",
  success: "success",
  failed: "failed",
  cancelled: "canceled",
};

function project(repo: string): string {
  for (const segment of repo.split("/")) encodeSegment(segment);
  return encodeURIComponent(repo);
}

function toRepo(p: GitlabProject): RepoInfo {
  return {
    fullName: p.path_with_namespace,
    private: p.visibility !== "public",
    defaultBranch: p.default_branch,
    updatedAt: p.last_activity_at ? new Date(p.last_activity_at).toISOString() : null,
  };
}

function toCommit(c: GitlabCommit): CommitInfo {
  return { sha: c.id, message: c.message ?? "", author: c.author_name ?? null };
}

export function gitlabClient({ deps, row, token }: ClientConfig): ProviderClient {
  const target: ApiTarget = { label: "GitLab", base: `${row.url}/api/v4`, auth: { "private-token": token } };
  const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
    apiRequest<T>(deps, target, path, { query });

  return {
    kind: "gitlab",
    async whoami() {
      const { data } = await get<{ username: string }>("/user");
      return data.username;
    },
    async repos(query, page, perPage) {
      const res = await get<GitlabProject[]>("/projects", {
        membership: true,
        simple: true,
        archived: false,
        order_by: "last_activity_at",
        sort: "desc",
        search: query || undefined,
        per_page: perPage,
        page,
      });
      return { repos: res.data.map(toRepo), hasMore: Boolean(res.headers.get("x-next-page")) };
    },
    async repo(repo) {
      return toRepo((await get<GitlabProject>(`/projects/${project(repo)}`)).data);
    },
    async branches(repo, query) {
      const out: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const res = await get<{ name: string }[]>(`/projects/${project(repo)}/repository/branches`, {
          search: query || undefined,
          per_page: 100,
          page,
        });
        out.push(...res.data.map((b) => b.name));
        if (!res.headers.get("x-next-page")) break;
      }
      return out;
    },
    async branchHead(repo, branch) {
      try {
        const { data } = await get<{ commit: GitlabCommit }>(`/projects/${project(repo)}/repository/branches/${encodeSegment(branch)}`);
        return toCommit(data.commit);
      } catch (error) {
        if (error instanceof ProviderApiError && error.status === 404) return null;
        throw error;
      }
    },
    async commit(repo, ref) {
      return toCommit((await get<GitlabCommit>(`/projects/${project(repo)}/repository/commits/${encodeSegment(ref)}`)).data);
    },
    async compare(repo, before, after): Promise<ChangedFiles> {
      const { data } = await get<{ diffs: { old_path: string; new_path: string }[]; compare_timeout?: boolean }>(
        `/projects/${project(repo)}/repository/compare`,
        { from: before, to: after, straight: false },
      );
      const files = new Set<string>();
      for (const d of data.diffs ?? []) {
        files.add(d.new_path);
        files.add(d.old_path);
      }
      return { files: [...files], complete: !data.compare_timeout && (data.diffs?.length ?? 0) < compareFileCap };
    },
    async mergeRequest(repo, number): Promise<MergeRequestInfo> {
      const { data } = await get<{
        iid: number;
        title: string;
        state: string;
        source_branch: string;
        target_branch: string;
        sha: string;
        source_project_id: number;
        target_project_id: number;
      }>(`/projects/${project(repo)}/merge_requests/${number}`);
      // A merge request from a fork names another source project; its path is not needed, only that it differs.
      const fork = data.source_project_id !== data.target_project_id;
      return {
        number: data.iid,
        title: data.title,
        state: data.state === "opened" ? "open" : data.state === "merged" ? "merged" : "closed",
        headBranch: data.source_branch,
        headSha: data.sha,
        headRepo: fork ? `fork:${data.source_project_id}` : repo,
        baseBranch: data.target_branch,
        baseRepo: repo,
      };
    },
    async createHook(repo, hook) {
      const { data } = await apiRequest<{ id: number }>(deps, target, `/projects/${project(repo)}/hooks`, {
        method: "POST",
        body: {
          url: hook.url,
          token: hook.secret,
          push_events: true,
          merge_requests_events: true,
          tag_push_events: false,
          enable_ssl_verification: true,
        },
      });
      return String(data.id);
    },
    async deleteHook(repo, id) {
      try {
        await apiRequest(deps, target, `/projects/${project(repo)}/hooks/${encodeSegment(id)}`, { method: "DELETE" });
      } catch (error) {
        if (error instanceof ProviderApiError && error.status === 404) return;
        throw error;
      }
    },
    async setStatus(repo, sha, status) {
      try {
        await apiRequest(deps, target, `/projects/${project(repo)}/statuses/${encodeSegment(sha)}`, {
          method: "POST",
          body: {
            state: stateMap[status.state],
            name: status.context,
            description: status.description.slice(0, 255),
            ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
          },
        });
      } catch (error) {
        // GitLab keeps one pending or running status per name and moves it through its state machine: pending
        // twice (a new description), running twice (a post repeated after a panel restart) or pending after
        // running answer 400 "Cannot transition status via :enqueue from :pending". The commit already shows
        // that state, or a later one it does not go back from, so the post is done.
        if (error instanceof ProviderApiError && error.status === 400 && /cannot transition status/i.test(error.message)) return;
        throw error;
      }
    },
    cloneUrl(repo) {
      return `${row.url}/${repo}.git`;
    },
    gitUsername() {
      return "oauth2";
    },
  };
}
