// The Git repository tab of the New app dialog: one Repository field that
// takes a URL, owner/repo or host/path (repo-input.ts), a Browse list of
// the repositories the person's connections can read (GitHub App
// installations through github.repos, git provider connections through
// gitProviders.repos), a quiet line saying which source it becomes
// (repo-source.ts), and a Branch field with the repository's branches as
// suggestions. Connections only show when the person may use them: a
// hidden installation or provider list gives none, a suspended
// installation is left out, and one whose repositories the panel refuses
// (FORBIDDEN for a member it is not shared with in the project) drops out
// of the list and of matching what was typed, as on the Source tab.

import { git, github, gitProviders, OpError, type OpOutput } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { opQueryKey, useOp, useOpClient } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { Input } from "@seylo/ui/components/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@seylo/ui/components/popover";
import { LoadingRegion, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import {
  IconBrandBitbucket,
  IconBrandGithub,
  IconBrandGitlab,
  IconCheck,
  IconChevronDown,
  IconCup,
  IconListSearch,
  IconLock,
  IconSearch,
} from "@tabler/icons-react";
import { type QueryKey, type UseQueryOptions, useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { useDebounced } from "../docker-hub/use-debounced";
import { formatRelative } from "../service/format";
import { retryOp } from "../service/op-state";
import { parseRepoInput, type RepoParse } from "./repo-input";
import {
  type Connection,
  type ConnectionKind,
  connectionsOf,
  decideSource,
  type FoundRepo,
  pathIn,
  type RepoDecision,
  type RepoInfo,
  type RepoLookup,
} from "./repo-source";

type RepoPage = { repos: RepoInfo[]; hasMore: boolean };
type RepoQuery = UseQueryOptions<unknown, OpError, RepoPage, QueryKey>;

const kindIcons: Record<ConnectionKind, typeof IconBrandGithub> = {
  github: IconBrandGithub,
  gitlab: IconBrandGitlab,
  gitea: IconCup,
  bitbucket: IconBrandBitbucket,
};

const isForbidden = (error: unknown) => error instanceof OpError && error.code === "FORBIDDEN";

/**
 * One page of a connection's repositories, kept in the cache as the op
 * answered it (other screens read the same ops) and turned into RepoInfo
 * on the way out.
 */
function reposQuery(client: OpClient, projectId: string, connection: Connection, query: string, page: number, enabled: boolean): RepoQuery {
  const q = query.trim() || undefined;
  const shared = { enabled: enabled && projectId !== "", retry: retryOp, staleTime: 60_000 };
  if (connection.kind === "github") {
    const input = { projectId, installationId: connection.id, query: q, page };
    return {
      ...shared,
      queryKey: opQueryKey(github.repos, input),
      queryFn: ({ signal }) => client.call(github.repos, input, { signal }),
      select: (out) => {
        const data = out as OpOutput<typeof github.repos>;
        return {
          repos: data.repos.map((r) => ({
            fullName: r.fullName,
            private: r.private,
            defaultBranch: r.defaultBranch,
            updatedAt: r.pushedAt,
          })),
          hasMore: data.hasMore,
        };
      },
    };
  }
  const input = { projectId, providerId: connection.id, query: q, page };
  return {
    ...shared,
    queryKey: opQueryKey(gitProviders.repos, input),
    queryFn: ({ signal }) => client.call(gitProviders.repos, input, { signal }),
    select: (out) => out as OpOutput<typeof gitProviders.repos>,
  };
}

export interface RepoSource {
  parse: RepoParse;
  decision: RepoDecision;
  connections: Connection[];
  /** The installation and provider lists are still loading. */
  listsPending: boolean;
  /** Both lists failed: the first error. One failing alone leaves the other's connections. */
  listsError: unknown;
}

/**
 * The source the field's text (or a picked repository) becomes. A typed
 * repository that a connection could hold is looked up in it (github.repos
 * with the name, gitProviders.repos with the last segment) once the text
 * rests for 300ms; until then and while the lists load it is "checking".
 */
export function useRepoSource({
  projectId,
  text,
  picked,
  enabled,
}: {
  projectId: string;
  text: string;
  picked: FoundRepo | null;
  enabled: boolean;
}): RepoSource {
  const client = useOpClient();
  const installs = useOp(github.installations, {}, { enabled, retry: retryOp, staleTime: 60_000 });
  const providers = useOp(gitProviders.list, {}, { enabled, retry: retryOp, staleTime: 60_000 });
  const connections = useMemo(() => connectionsOf(installs.data, providers.data), [installs.data, providers.data]);
  const listsPending = installs.isPending || providers.isPending;

  const parse = useMemo(() => parseRepoInput(text), [text]);
  const settled = useDebounced(text, 300);
  const typing = settled !== text;
  const candidates = useMemo(() => {
    const settledParse = parseRepoInput(settled);
    if (picked || !settledParse.ok) return [];
    return connections.flatMap((connection) => {
      const path = pathIn(connection, settledParse.repo);
      return path ? [{ connection, path }] : [];
    });
  }, [settled, picked, connections]);
  const results = useQueries({
    queries: candidates.map(({ connection, path }) =>
      reposQuery(client, projectId, connection, connection.kind === "github" ? path : (path.split("/").pop() ?? path), 1, enabled),
    ),
  });
  const lookups: RepoLookup[] = candidates.map(({ connection, path }, index) => {
    const result = results[index];
    if (projectId === "" || !result || result.isError) return { connection, path, state: "failed", repos: [] };
    if (result.data) return { connection, path, state: "done", repos: result.data.repos };
    return { connection, path, state: "pending", repos: [] };
  });

  let decision: RepoDecision;
  if (picked) decision = decideSource(parse, picked, []);
  else if (parse.ok && (listsPending || (typing && connections.some((c) => pathIn(c, parse.repo) !== null))))
    decision = { type: "checking", repo: parse.repo };
  else decision = decideSource(parse, null, typing ? [] : lookups);

  const listsError = installs.isError && providers.isError ? installs.error : null;
  return { parse, decision, connections, listsPending: enabled && listsPending, listsError };
}

export interface BranchSuggestions {
  /** Whether there is a repository to suggest branches for. */
  available: boolean;
  branches: string[] | undefined;
  defaultBranch: string | null;
  loading: boolean;
  error: unknown;
}

/**
 * The branches of the decided repository: github.branches or
 * gitProviders.branches through its connection, git.branches (like git
 * ls-remote) for a public https URL once it rests for 600ms. An SSH URL
 * without a credential has none to read.
 */
export function useBranchSuggestions(projectId: string, decision: RepoDecision, enabled: boolean): BranchSuggestions {
  const found = decision.type === "connected" ? decision.found : null;
  const viaGithub = found?.connection.kind === "github" ? found : null;
  const viaProvider = found && found.connection.kind !== "github" ? found : null;
  const plain = decision.type === "git" && !decision.repo.ssh ? decision.repo : null;
  const url = useDebounced(plain?.url ?? "", 600);
  const on = enabled && projectId !== "";
  const options = { retry: retryOp, staleTime: 60_000 };
  const fromGithub = useOp(
    github.branches,
    { projectId, installationId: viaGithub?.connection.id ?? "", repo: viaGithub?.repo.fullName ?? "" },
    { ...options, enabled: on && viaGithub !== null },
  );
  const fromProvider = useOp(
    gitProviders.branches,
    { projectId, providerId: viaProvider?.connection.id ?? "", repo: viaProvider?.repo.fullName ?? "" },
    { ...options, enabled: on && viaProvider !== null },
  );
  const fromGit = useOp(git.branches, { projectId, url }, { ...options, retry: false, enabled: on && plain !== null && url === plain.url });
  const active = viaGithub ? fromGithub : viaProvider ? fromProvider : plain ? fromGit : null;
  if (!active)
    return { available: false, branches: undefined, defaultBranch: found?.repo.defaultBranch ?? null, loading: false, error: null };
  return {
    available: true,
    branches: active.data?.branches,
    defaultBranch: active.data?.defaultBranch ?? found?.repo.defaultBranch ?? null,
    loading: active.isPending || (plain !== null && url !== plain.url),
    error: active.error,
  };
}

/** The Repository field: free text with a Browse list inside it. */
export function RepoField({
  id,
  noteId,
  value,
  onChange,
  onPick,
  projectId,
  source,
  canManage,
}: {
  id: string;
  noteId: string;
  value: string;
  onChange: (text: string) => void;
  onPick: (found: FoundRepo) => void;
  projectId: string;
  source: RepoSource;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = source.decision.type === "connected" ? source.decision.found : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("newService.repo.placeholder")}
            aria-describedby={noteId}
            aria-invalid={
              source.decision.type === "none" && (source.decision.problem === "credentials" || source.decision.problem === "insecure")
            }
            autoComplete="off"
            spellCheck={false}
            className="pr-[92px] font-mono"
          />
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="absolute top-1/2 right-[3px] -translate-y-1/2 px-2.5">
              <IconListSearch size={15} stroke={1.8} aria-hidden="true" />
              {t("newService.repo.browse")}
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-[min(max(var(--radix-popover-trigger-width),420px),calc(100vw-32px))] p-0">
        <RepoBrowser
          projectId={projectId}
          source={source}
          canManage={canManage}
          selected={selected}
          onPick={(found) => {
            onPick(found);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface RepoGroup {
  connection: Connection;
  /** hidden: the panel refused the list (a connection this person may not use here). */
  status: "loading" | "error" | "ready" | "hidden";
  error: unknown;
  repos: RepoInfo[];
  hasMore: boolean;
  loadingMore: boolean;
}

/** The Browse list's search and its repositories, one page per connection until "Show more". */
function RepoBrowser({
  projectId,
  source,
  canManage,
  selected,
  onPick,
}: {
  projectId: string;
  source: RepoSource;
  canManage: boolean;
  selected: FoundRepo | null;
  onPick: (found: FoundRepo) => void;
}) {
  const client = useOpClient();
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 300);
  const [pages, setPages] = useState<Record<string, number>>({});
  const specs = source.connections.flatMap((connection) =>
    Array.from({ length: pages[connection.id] ?? 1 }, (_, index) => ({ connection, page: index + 1 })),
  );
  const results = useQueries({
    queries: specs.map(({ connection, page }) => reposQuery(client, projectId, connection, query, page, true)),
  });
  const groups: RepoGroup[] = source.connections.map((connection) => {
    const own = results.filter((_, index) => specs[index]?.connection.id === connection.id);
    const first = own[0];
    const last = own[own.length - 1];
    const base = { connection, error: null, repos: [], hasMore: false, loadingMore: false };
    if (!first || first.isPending) return { ...base, status: "loading" };
    if (first.isError) return isForbidden(first.error) ? { ...base, status: "hidden" } : { ...base, status: "error", error: first.error };
    return {
      ...base,
      status: "ready",
      repos: own.flatMap((r) => r.data?.repos ?? []),
      hasMore: last?.data?.hasMore ?? false,
      loadingMore: own.length > 1 && last?.isPending === true,
    };
  });

  return (
    <div className="flex flex-col">
      <div className="p-1.5 pb-0">
        <label className="flex h-9 items-center gap-2 rounded-control bg-raised px-2.5">
          <IconSearch size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the list opens to be searched
            autoFocus
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPages({});
            }}
            placeholder={t("newService.repo.search")}
            aria-label={t("newService.repo.search")}
            className="h-full w-full border-0 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <RepoList
        projectId={projectId}
        listsPending={source.listsPending}
        listsError={source.listsError}
        groups={groups}
        canManage={canManage}
        query={query}
        selected={selected}
        onPick={onPick}
        onMore={(connectionId) => setPages((p) => ({ ...p, [connectionId]: (p[connectionId] ?? 1) + 1 }))}
      />
    </div>
  );
}

const groupLabel = (connection: Connection) =>
  t("newService.repo.group", { provider: t(`serviceSource.types.${connection.kind}.name`), name: connection.label });

/** What the Browse list shows: the states before there are repositories, then the repositories by connection. */
export function RepoList({
  projectId,
  listsPending,
  listsError,
  groups,
  canManage,
  query,
  selected,
  onPick,
  onMore,
}: {
  projectId: string;
  listsPending: boolean;
  listsError: unknown;
  groups: RepoGroup[];
  canManage: boolean;
  query: string;
  selected: FoundRepo | null;
  onPick: (found: FoundRepo) => void;
  onMore: (connectionId: string) => void;
}) {
  const body = (() => {
    if (projectId === "") return <Line>{t("newService.repo.pickProject")}</Line>;
    if (listsPending) return <RepoRowsSkeleton />;
    if (listsError) return <Line>{t("newService.repo.loadFailed", { message: errorMessage(listsError, t("common.unknownError")) })}</Line>;
    if (groups.length === 0) return <NoConnections canManage={canManage} />;
    const shown = groups.filter((g) => g.status !== "hidden" && !(g.status === "ready" && g.repos.length === 0));
    if (shown.length === 0) {
      return <Line>{query ? t("newService.repo.noMatch", { query }) : t("newService.repo.noRepos")}</Line>;
    }
    return shown.map((group) => (
      <div key={group.connection.id} className="flex flex-col">
        <GroupHeading connection={group.connection} />
        {group.status === "loading" && <RepoRowsSkeleton />}
        {group.status === "error" && (
          <Line>{t("newService.repo.groupFailed", { message: errorMessage(group.error, t("common.unknownError")) })}</Line>
        )}
        {group.repos.map((repo) => (
          <RepoOption
            key={repo.fullName}
            repo={repo}
            selected={selected?.connection.id === group.connection.id && selected.repo.fullName === repo.fullName}
            onPick={() => onPick({ connection: group.connection, repo })}
          />
        ))}
        {group.loadingMore && <RepoRowsSkeleton rows={1} />}
        {group.hasMore && !group.loadingMore && (
          <Button size="sm" variant="ghost" className="mx-1 self-start" onClick={() => onMore(group.connection.id)}>
            {t("newService.repo.more")}
          </Button>
        )}
      </div>
    ));
  })();
  return (
    <div role="listbox" aria-label={t("newService.repo.list")} aria-busy={listsPending} className="max-h-80 overflow-y-auto p-1.5">
      {body}
    </div>
  );
}

function GroupHeading({ connection }: { connection: Connection }) {
  const Icon = kindIcons[connection.kind];
  return (
    <div role="presentation" className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-xs text-muted-foreground">
      <Icon size={13} stroke={1.8} aria-hidden="true" />
      <span className="truncate">{groupLabel(connection)}</span>
    </div>
  );
}

function RepoOption({ repo, selected, onPick }: { repo: RepoInfo; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-2.5 py-2 text-left transition-interactive duration-200 hover:bg-accent",
        selected && "bg-accent",
      )}
    >
      <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">{repo.fullName}</span>
      {repo.private ? (
        <Chip tone="gray" className="shrink-0 py-0">
          <IconLock size={11} aria-hidden="true" />
          {t("newService.repo.private")}
        </Chip>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">{t("newService.repo.public")}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {repo.updatedAt && <span className="text-xs whitespace-nowrap text-muted-foreground">{formatRelative(repo.updatedAt)}</span>}
        {selected && <IconCheck size={15} stroke={2} className="text-primary" aria-hidden="true" />}
      </span>
    </button>
  );
}

function NoConnections({ canManage }: { canManage: boolean }) {
  return (
    <div className="flex flex-col gap-2 px-2.5 py-3">
      <span className="text-[13px] font-medium text-foreground">{t("newService.repo.noneTitle")}</span>
      <span className="text-[12.5px] leading-normal text-muted-foreground">
        {canManage ? t("newService.repo.noneBody") : t("newService.repo.noneMember")}
      </span>
      {canManage && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button asChild size="sm">
            <Link to="/settings/github">{t("newService.repo.setUpGithub")}</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to="/settings/git-providers">{t("newService.repo.addProvider")}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function Line({ children }: { children: string }) {
  return <p className="m-0 px-2.5 py-3 text-[12.5px] leading-normal text-muted-foreground">{children}</p>;
}

/** Repository rows while they load: the name and when it was pushed. */
function RepoRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <LoadingRegion label={t("common.loading")} className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else to key on
        <div key={i} className="flex items-center gap-2 px-2.5 py-2 text-[12.5px]">
          <SkeletonText className="w-40" />
          <SkeletonText className="ml-auto w-14 text-xs" />
        </div>
      ))}
    </LoadingRegion>
  );
}

/** The quiet line under the Repository field: which source the text becomes, or what is wrong with it. */
export function RepoNote({ id, text, decision }: { id: string; text: string; decision: RepoDecision }) {
  const loud = decision.type === "none" && (decision.problem === "credentials" || decision.problem === "insecure");
  return (
    <span id={id} className={cn("text-xs leading-normal", loud ? "text-destructive" : "text-muted-foreground")}>
      {noteText(text, decision)}
    </span>
  );
}

function noteText(text: string, decision: RepoDecision): string {
  switch (decision.type) {
    case "none":
      if (decision.problem === "empty") return t("newService.repo.hint");
      return t(`newService.repo.problems.${decision.problem}`, {
        path: text
          .trim()
          .replace(/\/+$/, "")
          .replace(/\.git$/i, ""),
      });
    case "checking":
      return t("newService.repo.checking", { path: decision.repo.path });
    case "connected": {
      const { connection } = decision.found;
      if (connection.kind === "github") return t("newService.repo.fromGithub", { account: connection.label });
      return t("newService.repo.fromProvider", { provider: t(`serviceSource.types.${connection.kind}.name`), name: connection.label });
    }
    case "git": {
      const { repo, missedIn } = decision;
      if (repo.ssh) return t("newService.repo.ssh", { host: repo.host });
      if (repo.host === "github.com") {
        return missedIn
          ? t("newService.repo.publicGithubMissed", { path: repo.path, account: missedIn.label })
          : t("newService.repo.publicGithub", { path: repo.path });
      }
      const address = `${repo.host}/${repo.path}`;
      return missedIn
        ? t("newService.repo.publicGitMissed", {
            address,
            provider: t(`serviceSource.types.${missedIn.kind}.name`),
            name: missedIn.label,
          })
        : t("newService.repo.publicGit", { address });
    }
  }
}

/** The Branch field: free text, with the repository's branches a click away and its default marked. */
export function BranchField({
  id,
  value,
  onChange,
  suggestions,
}: {
  id: string;
  value: string;
  onChange: (branch: string) => void;
  suggestions: BranchSuggestions;
}) {
  const [open, setOpen] = useState(false);
  const all = suggestions.branches ?? [];
  const typed = value.trim().toLowerCase();
  const matching = typed && !all.includes(value.trim()) ? all.filter((b) => b.toLowerCase().includes(typed)) : all;
  const list = matching.length > 0 ? matching : all;
  return (
    <Popover open={open && suggestions.available} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={cn("font-mono", suggestions.available && "pr-9")}
          />
          {suggestions.available && (
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("newService.repo.showBranches")}
                className="absolute top-1/2 right-[3px] flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent text-muted-foreground transition-interactive duration-200 hover:bg-muted hover:text-foreground"
              >
                <IconChevronDown size={14} stroke={2} aria-hidden="true" />
              </button>
            </PopoverTrigger>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent align="end" className="w-[min(280px,calc(100vw-32px))] p-1.5">
        <div role="listbox" aria-label={t("newService.branch")} aria-busy={suggestions.loading} className="max-h-64 overflow-y-auto">
          {suggestions.loading ? (
            <LoadingRegion label={t("newService.repo.branchesLoading")} className="flex flex-col">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-2.5 py-2 text-[12.5px]">
                  <SkeletonText className="w-28" />
                </div>
              ))}
            </LoadingRegion>
          ) : suggestions.error ? (
            <Line>{t("newService.repo.branchesFailed", { message: errorMessage(suggestions.error, t("common.unknownError")) })}</Line>
          ) : list.length === 0 ? (
            <Line>{t("newService.repo.noBranches")}</Line>
          ) : (
            list.map((branch) => (
              <button
                key={branch}
                type="button"
                role="option"
                aria-selected={branch === value.trim()}
                onClick={() => {
                  onChange(branch);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-2.5 py-2 text-left transition-interactive duration-200 hover:bg-accent",
                  branch === value.trim() && "bg-accent",
                )}
              >
                <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">{branch}</span>
                {branch === suggestions.defaultBranch && (
                  <Chip tone="gray" className="shrink-0 py-0 text-[11px]">
                    {t("newService.repo.defaultBranch")}
                  </Chip>
                )}
                {branch === value.trim() && <IconCheck size={15} stroke={2} className="ml-auto shrink-0 text-primary" aria-hidden="true" />}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
