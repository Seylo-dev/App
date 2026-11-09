// The GitHub tab of the New app dialog: one Repository field that takes
// owner/repo or a github.com address (repo-input.ts), a Browse list of the
// repositories the panel's GitHub connections can read (the GitHub App's
// installations and the connected GitHub account of Settings > GitHub,
// through github.repos), a quiet line saying which source it becomes
// (repo-source.ts), and a Branch field with the repository's branches as
// suggestions. Connections only show when the person may use them: a
// hidden installation list gives none, a suspended installation is left
// out, and one whose repositories the panel refuses (FORBIDDEN for a member
// it is not shared with in the project) drops out of the list and of
// matching what was typed, as on the Source tab. A member who may create
// services but not change them (connectRepo needs services.update) gets
// plain git URLs only. The Git repository tab takes a URL alone and uses
// only the branch suggestions here (git.branches).

import { auth, git, github, grants, type OpError, type OpOutput } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { opQueryKey, useOp, useOpClient } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { Input } from "@seylo/ui/components/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@seylo/ui/components/popover";
import { LoadingRegion, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconBrandGithub, IconCheck, IconChevronDown, IconListSearch, IconLock, IconSearch, IconUserCircle } from "@tabler/icons-react";
import { type QueryKey, type UseQueryOptions, useQueries } from "@tanstack/react-query";
import { type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { useDebounced } from "../docker-hub/use-debounced";
import { formatRelative } from "../service/format";
import { retryOp } from "../service/op-state";
import { githubParse, type RepoParse } from "./repo-input";
import {
  type Connection,
  connectionsOf,
  decideSource,
  type FoundRepo,
  githubVia,
  lookupStateOf,
  mayConnectIn,
  pathIn,
  type RepoDecision,
  type RepoInfo,
  type RepoLookup,
} from "./repo-source";

type RepoPage = { repos: RepoInfo[]; hasMore: boolean };
type RepoQuery = UseQueryOptions<unknown, OpError, RepoPage, QueryKey>;
/** What a lookup by name needs from github.branches. */
type Lookup = { defaultBranch: string | null };
type LookupQuery = UseQueryOptions<Lookup, OpError, Lookup, QueryKey>;

const isForbidden = (error: unknown) => (error as OpError | null)?.code === "FORBIDDEN";
const message = (error: unknown) => errorMessage(error, t("common.unknownError"));

/**
 * One page of a connection's repositories, kept in the cache as the op
 * answered it (other screens read the same op) and turned into RepoInfo
 * on the way out.
 */
function reposQuery(client: OpClient, projectId: string, connection: Connection, query: string, page: number, enabled: boolean): RepoQuery {
  const input = { projectId, ...githubVia(connection), query: query.trim() || undefined, page };
  return {
    enabled: enabled && projectId !== "",
    retry: retryOp,
    staleTime: 60_000,
    queryKey: opQueryKey(github.repos, input),
    queryFn: ({ signal }) => client.call(github.repos, input, { signal }),
    select: (out) => {
      const data = out as OpOutput<typeof github.repos>;
      return {
        repos: data.repos.map((r) => ({ fullName: r.fullName, private: r.private, defaultBranch: r.defaultBranch, updatedAt: r.pushedAt })),
        hasMore: data.hasMore,
      };
    },
  };
}

/**
 * A typed repository asked for by its exact name through a connection:
 * github.branches, which reads that one repository and fails with
 * NOT_FOUND when the connection cannot (FORBIDDEN when it is not usable
 * here). The same query the branch suggestions make once it is found, so
 * it is asked once.
 */
function lookupQuery(client: OpClient, projectId: string, connection: Connection, repo: string, enabled: boolean): LookupQuery {
  const input = { projectId, ...githubVia(connection), repo };
  return {
    enabled: enabled && projectId !== "",
    retry: retryOp,
    staleTime: 60_000,
    queryKey: opQueryKey(github.branches, input),
    queryFn: ({ signal }) => client.call(github.branches, input, { signal }),
  };
}

/**
 * Whether connecting a repository can work in the project (repo-source.ts
 * mayConnectIn): owners and admins at once, members once their grants
 * (grants.mine) are read. A failed grants list does not block: the panel
 * still checks the connect.
 */
export function useCanConnect(projectId: string, enabled: boolean): { pending: boolean; can: boolean } {
  const me = useOp(auth.whoami, {});
  const role = me.data?.viewer.role;
  const mine = useOp(grants.mine, {}, { enabled: enabled && role === "member", retry: retryOp, staleTime: 60_000 });
  if (!role) return me.isError ? { pending: false, can: true } : { pending: true, can: false };
  if (role !== "member" || mine.isError) return { pending: false, can: true };
  if (!mine.data) return { pending: true, can: false };
  return { pending: false, can: mayConnectIn(role, mine.data.grants, projectId) };
}

export interface RepoSource {
  parse: RepoParse;
  decision: RepoDecision;
  connections: Connection[];
  /** The installation list (and a member's grants) are still loading. */
  listsPending: boolean;
  /** github.installations failed; null when it loaded. */
  listError: unknown;
  /** Whether the installation list is hidden from this person (no App or account to show, whatever there is). */
  hidden: boolean;
  /** Whether repositories may be connected here (see useCanConnect); without it, Browse says why and typing gives git URLs. */
  canConnect: boolean;
  /** Asks again what did not answer: a failed list or lookup. */
  retry: () => void;
}

/**
 * The source the field's text (or a picked repository) becomes. A typed
 * repository that a connection could hold is looked up in it by name once
 * the text rests for 300ms; until then and while the list loads it is
 * "checking". Only github.com: another host is the Git repository tab's.
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
  const access = useCanConnect(projectId, enabled);
  const installs = useOp(github.installations, {}, { enabled, retry: retryOp, staleTime: 60_000 });
  const connections = useMemo(() => connectionsOf(installs.data), [installs.data]);
  const listsPending = installs.isPending || access.pending;
  const usable = access.can;
  const chosen = usable ? picked : null;

  const parse = useMemo(() => githubParse(text), [text]);
  const settled = useDebounced(text, 300);
  const typing = settled !== text;
  const candidates = useMemo(() => {
    const settledParse = githubParse(settled);
    if (chosen || !usable || !settledParse.ok) return [];
    return connections.flatMap((connection) => {
      const path = pathIn(connection, settledParse.repo);
      return path ? [{ connection, path }] : [];
    });
  }, [settled, chosen, usable, connections]);
  const results = useQueries({
    queries: candidates.map(({ connection, path }) => lookupQuery(client, projectId, connection, path, enabled)),
  });
  const lookups: RepoLookup[] = candidates.map(({ connection, path }, index) => {
    const result = results[index];
    const base = { connection, path, defaultBranch: null, error: null };
    if (result?.data) return { ...base, state: "found", defaultBranch: result.data.defaultBranch };
    // A failure being asked again (Try again) is checking, not failed.
    if (result?.isError && !result.isFetching) return { ...base, state: lookupStateOf(result.error), error: result.error };
    return { ...base, state: "pending" };
  });

  let decision: RepoDecision;
  if (chosen) decision = decideSource(parse, chosen, []);
  else if (!parse.ok) decision = decideSource(parse, null, []);
  else {
    const repo = parse.repo;
    const couldHold = usable && connections.some((c) => pathIn(c, repo) !== null);
    if (listsPending || (usable && installs.isError && installs.isFetching)) decision = { type: "checking", repo };
    else if (usable && installs.isError) decision = { type: "unchecked", repo, failed: "github", error: installs.error };
    else if (typing && couldHold) decision = { type: "checking", repo };
    else if (projectId === "" && couldHold) decision = { type: "checking", repo, needsProject: true };
    else decision = decideSource(parse, null, typing ? [] : lookups);
  }

  const retry = () => {
    if (installs.isError) void installs.refetch();
    for (const result of results) if (result.isError) void result.refetch();
  };
  return {
    parse,
    decision,
    connections,
    listsPending: enabled && listsPending,
    listError: installs.isError ? installs.error : null,
    hidden: installs.data?.hidden === true,
    canConnect: usable,
    retry,
  };
}

export { githubParse } from "./repo-input";

export interface BranchSuggestions {
  /** Whether there is a repository to suggest branches for. */
  available: boolean;
  branches: string[] | undefined;
  defaultBranch: string | null;
  loading: boolean;
  error: unknown;
}

/**
 * The branches of the decided repository: github.branches through its
 * connection, git.branches (like git ls-remote) for a public https URL
 * once it rests for 600ms. An SSH URL has none to read.
 */
export function useBranchSuggestions(projectId: string, decision: RepoDecision, enabled: boolean): BranchSuggestions {
  const found = decision.type === "connected" ? decision.found : null;
  const plain = decision.type === "git" && !decision.repo.ssh ? decision.repo : null;
  const url = useDebounced(plain?.url ?? "", 600);
  const on = enabled && projectId !== "";
  const options = { retry: retryOp, staleTime: 60_000 };
  const fromGithub = useOp(
    github.branches,
    { projectId, ...(found ? githubVia(found.connection) : { installationId: "" }), repo: found?.repo.fullName ?? "" },
    { ...options, enabled: on && found !== null },
  );
  const fromGit = useOp(git.branches, { projectId, url }, { ...options, retry: false, enabled: on && plain !== null && url === plain.url });
  const active = found ? fromGithub : plain ? fromGit : null;
  if (!active) return { available: false, branches: undefined, defaultBranch: null, loading: false, error: null };
  return {
    available: true,
    branches: active.data?.branches,
    defaultBranch: active.data?.defaultBranch ?? found?.repo.defaultBranch ?? null,
    loading: active.isPending || (plain !== null && url !== plain.url),
    error: active.error,
  };
}

/**
 * Arrow keys, Home and End between a list's options (and its Show more
 * buttons), for lists marked listbox; Up on the first one calls onTop.
 */
function moveInList(event: KeyboardEvent<HTMLElement>, onTop?: () => void) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"], [data-more]'));
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "ArrowUp" && at <= 0) return onTop?.();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? Math.min(at + 1, items.length - 1)
          : at - 1;
  items[next]?.focus();
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
}: {
  id: string;
  noteId: string;
  value: string;
  onChange: (text: string) => void;
  onPick: (found: FoundRepo) => void;
  projectId: string;
  source: RepoSource;
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
      {/* The field's width on phones, at least 420px from sm up; never closer than 16px to the window's edges. */}
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-(--radix-popover-trigger-width) p-0 sm:w-[max(var(--radix-popover-trigger-width),420px)]"
      >
        <RepoBrowser
          projectId={projectId}
          source={source}
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
  /** The next page failed: said under the rows, and Show more asks for it again. */
  moreError?: unknown;
}

/** The Browse list's search and its repositories, one page per connection until "Show more". */
function RepoBrowser({
  projectId,
  source,
  selected,
  onPick,
}: {
  projectId: string;
  source: RepoSource;
  selected: FoundRepo | null;
  onPick: (found: FoundRepo) => void;
}) {
  const client = useOpClient();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 300);
  const [pages, setPages] = useState<Record<string, number>>({});
  const specs = source.connections.flatMap((connection) =>
    Array.from({ length: pages[connection.id] ?? 1 }, (_, index) => ({ connection, page: index + 1 })),
  );
  const results = useQueries({
    queries: specs.map(({ connection, page }) => reposQuery(client, projectId, connection, query, page, source.canConnect)),
  });
  const groups: RepoGroup[] = source.connections.map((connection) => {
    const own = results.filter((_, index) => specs[index]?.connection.id === connection.id);
    const first = own[0];
    const last = own[own.length - 1];
    const base = { connection, error: null, repos: [], hasMore: false, loadingMore: false };
    if (!first || first.isPending) return { ...base, status: "loading" };
    if (first.isError) return isForbidden(first.error) ? { ...base, status: "hidden" } : { ...base, status: "error", error: first.error };
    const later = own.length > 1 ? last : undefined;
    const loadingMore = later?.isPending === true || (later?.isError === true && later.isFetching);
    const moreFailed = later?.isError === true && !later.isFetching;
    return {
      ...base,
      status: "ready",
      repos: own.flatMap((r) => r.data?.repos ?? []),
      // While the next page loads, or after it failed, the page before it said there is more.
      hasMore: loadingMore || moreFailed || (last?.data?.hasMore ?? false),
      loadingMore,
      moreError: moreFailed ? later?.error : null,
    };
  });
  const more = (connectionId: string) => {
    const own = results.filter((_, index) => specs[index]?.connection.id === connectionId);
    const last = own[own.length - 1];
    if (own.length > 1 && last?.isError) void last.refetch();
    else setPages((p) => ({ ...p, [connectionId]: (p[connectionId] ?? 1) + 1 }));
  };

  return (
    <div className="flex flex-col">
      <div className="p-1.5 pb-0">
        <label className="flex h-9 items-center gap-2 rounded-control bg-raised px-2.5">
          <IconSearch size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchRef}
            // biome-ignore lint/a11y/noAutofocus: the list opens to be searched
            autoFocus
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPages({});
            }}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown") return;
              const first = listRef.current?.querySelector<HTMLElement>('[role="option"], [data-more]');
              if (!first) return;
              e.preventDefault();
              first.focus();
            }}
            placeholder={t("newService.repo.search")}
            aria-label={t("newService.repo.search")}
            className="h-full w-full border-0 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <RepoList
        listRef={listRef}
        projectId={projectId}
        listsPending={source.listsPending}
        listError={source.listError}
        canConnect={source.canConnect}
        groups={groups}
        query={query}
        selected={selected}
        onPick={onPick}
        onMore={more}
        onTop={() => searchRef.current?.focus()}
      />
    </div>
  );
}

const groupLabel = (connection: Connection) =>
  connection.account
    ? t("newService.repo.groupAccount", { login: connection.label })
    : t("newService.repo.group", { provider: t(`serviceSource.types.${connection.kind}.name`), name: connection.label });

/** What the Browse list shows: the states before there are repositories, then the repositories by connection. */
export function RepoList({
  listRef: givenRef,
  projectId,
  listsPending,
  listError,
  canConnect,
  groups,
  query,
  selected,
  onPick,
  onMore,
  onTop,
}: {
  listRef?: RefObject<HTMLDivElement | null>;
  projectId: string;
  listsPending: boolean;
  listError: unknown;
  canConnect: boolean;
  groups: RepoGroup[];
  query: string;
  selected: FoundRepo | null;
  onPick: (found: FoundRepo) => void;
  onMore: (connectionId: string) => void;
  /** Up on the first option: back to the search box. */
  onTop?: () => void;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const listRef = givenRef ?? ownRef;
  // After "Show more", focus goes to the first row the page brought (or back to the button), not to the page.
  const [focusAfterMore, setFocusAfterMore] = useState<{ connectionId: string; index: number } | null>(null);
  useEffect(() => {
    if (!focusAfterMore) return;
    const group = groups.find((g) => g.connection.id === focusAfterMore.connectionId);
    if (group?.loadingMore) return;
    setFocusAfterMore(null);
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-group], [data-more]") ?? []);
    const row = items.find((el) => el.dataset.group === focusAfterMore.connectionId && el.dataset.index === String(focusAfterMore.index));
    (row ?? items.find((el) => el.dataset.more === focusAfterMore.connectionId))?.focus();
  }, [focusAfterMore, groups, listRef]);

  const body = (() => {
    if (projectId === "") return <Line>{t("newService.repo.pickProject")}</Line>;
    if (listsPending) return <RepoRowsSkeleton />;
    if (listError != null) return <Line>{t("newService.repo.listFailed", { message: message(listError) })}</Line>;
    if (groups.length === 0) return <Line>{t("newService.repo.noConnections")}</Line>;
    if (!canConnect) return <Line>{t("newService.repo.cannotConnect")}</Line>;
    const shown = groups.filter((g) => g.status !== "hidden" && !(g.status === "ready" && g.repos.length === 0));
    if (shown.length === 0) return <Line>{query ? t("newService.repo.noMatch", { query }) : t("newService.repo.noRepos")}</Line>;
    return shown.map((group) => (
      <div key={group.connection.id} className="flex flex-col">
        <GroupHeading connection={group.connection} />
        {group.status === "loading" && <RepoRowsSkeleton />}
        {group.status === "error" && <Line>{t("newService.repo.groupFailed", { message: message(group.error) })}</Line>}
        {group.repos.map((repo, index) => (
          <RepoOption
            key={repo.fullName}
            groupId={group.connection.id}
            index={index}
            repo={repo}
            selected={selected?.connection.id === group.connection.id && selected.repo.fullName === repo.fullName}
            onPick={() => onPick({ connection: group.connection, repo })}
          />
        ))}
        {group.loadingMore && <RepoRowsSkeleton rows={1} />}
        {group.moreError != null && <Line>{t("newService.repo.groupFailed", { message: message(group.moreError) })}</Line>}
        {/* Stays while the next page loads (aria-disabled keeps the focus on it), so the keyboard does not land on the page. */}
        {group.hasMore && (
          <Button
            size="sm"
            variant="ghost"
            data-more={group.connection.id}
            aria-disabled={group.loadingMore}
            className="mx-1 self-start aria-disabled:opacity-60"
            onClick={() => {
              if (group.loadingMore) return;
              setFocusAfterMore({ connectionId: group.connection.id, index: group.repos.length });
              onMore(group.connection.id);
            }}
          >
            {t("newService.repo.more")}
          </Button>
        )}
      </div>
    ));
  })();
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t("newService.repo.list")}
      aria-busy={listsPending}
      onKeyDown={(e) => moveInList(e, onTop)}
      // At most 20rem, and never past the window: the space Radix leaves below (or above) the field, less the search box.
      className="max-h-[min(20rem,calc(var(--radix-popover-content-available-height)_-_56px))] overflow-y-auto p-1.5"
    >
      {body}
    </div>
  );
}

function GroupHeading({ connection }: { connection: Connection }) {
  const Icon = connection.account ? IconUserCircle : IconBrandGithub;
  return (
    <div role="presentation" className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-xs text-muted-foreground">
      <Icon size={13} stroke={1.8} aria-hidden="true" />
      <span className="truncate">{groupLabel(connection)}</span>
    </div>
  );
}

function RepoOption({
  groupId,
  index,
  repo,
  selected,
  onPick,
}: {
  groupId: string;
  index: number;
  repo: RepoInfo;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-group={groupId}
      data-index={index}
      onClick={onPick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-2.5 py-2 text-left transition-interactive duration-200 hover:bg-accent focus-visible:bg-accent",
        selected && "bg-accent",
      )}
    >
      <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">{repo.fullName}</span>
      {repo.private === true && (
        <Chip tone="gray" className="shrink-0 py-0">
          <IconLock size={11} aria-hidden="true" />
          {t("newService.repo.private")}
        </Chip>
      )}
      {repo.private === false && <span className="shrink-0 text-xs text-muted-foreground">{t("newService.repo.public")}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {repo.updatedAt && <span className="text-xs whitespace-nowrap text-muted-foreground">{formatRelative(repo.updatedAt)}</span>}
        {selected && <IconCheck size={15} stroke={2} className="text-primary" aria-hidden="true" />}
      </span>
    </button>
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

/**
 * The quiet line under a Repository field: which source the text becomes,
 * or what is wrong with it. When a connection did not answer, it says so
 * with Try again (onRetry), and nothing is created until it does. `tab`:
 * which tab the field is on (the Git repository tab points private GitHub
 * repositories at the GitHub tab).
 */
export function RepoNote({
  id,
  text,
  decision,
  onRetry,
  tab = "github",
}: {
  id: string;
  text: string;
  decision: RepoDecision;
  onRetry?: () => void;
  tab?: "github" | "git";
}) {
  const loud = decision.type === "none" && (decision.problem === "credentials" || decision.problem === "insecure");
  return (
    <span id={id} className={cn("text-xs leading-normal", loud ? "text-destructive" : "text-muted-foreground")}>
      {noteText(text, decision, tab)}
      {decision.type === "unchecked" && onRetry && (
        <>
          {" "}
          <button
            type="button"
            onClick={onRetry}
            className="cursor-pointer border-0 bg-transparent p-0 font-medium text-foreground underline underline-offset-2 transition-colors duration-200 hover:text-primary"
          >
            {t("newService.repo.retry")}
          </button>
        </>
      )}
    </span>
  );
}

function noteText(text: string, decision: RepoDecision, tab: "github" | "git"): string {
  switch (decision.type) {
    case "none": {
      if (decision.problem === "empty") return t(tab === "git" ? "newService.git.hint" : "newService.repo.hint");
      const path = text
        .trim()
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "");
      return t(`newService.repo.problems.${decision.problem}`, { path });
    }
    case "checking":
      return t(decision.needsProject ? "newService.repo.checkingNoProject" : "newService.repo.checking", { path: decision.repo.path });
    case "unchecked": {
      const { failed } = decision;
      if (typeof failed === "string") return t("newService.repo.listFailed", { message: message(decision.error) });
      if (failed.account) return t("newService.repo.uncheckedAccount", { login: failed.label, message: message(decision.error) });
      return t("newService.repo.uncheckedGithub", { account: failed.label, message: message(decision.error) });
    }
    case "connected": {
      const { connection } = decision.found;
      if (connection.account) return t("newService.repo.fromAccount", { login: connection.label });
      return t("newService.repo.fromGithub", { account: connection.label });
    }
    case "git": {
      const { repo, missedIn } = decision;
      if (repo.ssh) return t("newService.repo.ssh", { host: repo.host });
      if (missedIn?.account) return t("newService.repo.missedAccount", { login: missedIn.label });
      if (missedIn) return t("newService.repo.missedGithub", { account: missedIn.label });
      if (repo.host === "github.com")
        return t(tab === "git" ? "newService.git.publicGithub" : "newService.repo.publicGithub", { path: repo.path });
      return t("newService.repo.publicGit", { address: `${repo.host}/${repo.path}` });
    }
  }
}

/** The Branch field: free text, with the repository's branches a click away and its default marked. */
export function BranchField({
  id,
  value,
  placeholder,
  invalid,
  describedBy,
  onChange,
  suggestions,
}: {
  id: string;
  value: string;
  /** What an empty field stands for: the suggested branch. */
  placeholder: string;
  invalid: boolean;
  describedBy?: string;
  onChange: (branch: string) => void;
  suggestions: BranchSuggestions;
}) {
  const [open, setOpen] = useState(false);
  const all = suggestions.branches ?? [];
  const typed = value.trim().toLowerCase();
  const matching = typed && !all.includes(value.trim()) ? all.filter((b) => b.toLowerCase().includes(typed)) : all;
  const list = matching.length > 0 ? matching : all;
  const current = value.trim() || placeholder;
  return (
    <Popover open={open && suggestions.available} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            aria-invalid={invalid}
            aria-describedby={describedBy}
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
      <PopoverContent align="end" collisionPadding={16} className="w-[min(280px,calc(100vw-32px))] p-1.5">
        <div
          role="listbox"
          aria-label={t("newService.branch")}
          aria-busy={suggestions.loading}
          onKeyDown={(e) => moveInList(e)}
          className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height)_-_12px))] overflow-y-auto"
        >
          {suggestions.loading ? (
            <LoadingRegion label={t("newService.repo.branchesLoading")} className="flex flex-col">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-2.5 py-2 text-[12.5px]">
                  <SkeletonText className="w-28" />
                </div>
              ))}
            </LoadingRegion>
          ) : suggestions.error ? (
            <Line>{t("newService.repo.branchesFailed", { message: message(suggestions.error) })}</Line>
          ) : list.length === 0 ? (
            <Line>{t("newService.repo.noBranches")}</Line>
          ) : (
            list.map((branch) => (
              <button
                key={branch}
                type="button"
                role="option"
                aria-selected={branch === current}
                onClick={() => {
                  onChange(branch);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-2.5 py-2 text-left transition-interactive duration-200 hover:bg-accent focus-visible:bg-accent",
                  branch === current && "bg-accent",
                )}
              >
                <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">{branch}</span>
                {branch === suggestions.defaultBranch && (
                  <Chip tone="gray" className="shrink-0 py-0 text-[11px]">
                    {t("newService.repo.defaultBranch")}
                  </Chip>
                )}
                {branch === current && <IconCheck size={15} stroke={2} className="ml-auto shrink-0 text-primary" aria-hidden="true" />}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
