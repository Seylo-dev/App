// Pick a GitHub repository and branch through the panel's GitHub App or its
// connected GitHub account (Settings > GitHub, a device login or a token).
// The repository field searches the list, or takes a GitHub link or
// owner/repo, which is looked up by name and offered on top of the list.

import { github, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { ButtonSkeleton, FieldSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconCheck, IconLock, IconSearch } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useDeferredValue, useMemo, useState } from "react";
import { t } from "../../../i18n/t";
import { useDebounced } from "../../docker-hub/use-debounced";
import { branchFromRef, githubParse } from "../../new-service/repo-input";
import { lookupStateOf } from "../../new-service/repo-source";
import { Field, ToggleRow } from "../field";
import { formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

/** What github.repos, github.branches and github.connectRepo take to read through the App or the account. */
export type GithubVia = { installationId: string; accountId?: undefined } | { accountId: string; installationId?: undefined };

/** An entry of the Account picker: an App installation, or the connected account. */
interface Choice {
  key: string;
  via: GithubVia;
  label: string;
  /** An installation's GitHub login: the only owner whose repositories it reads. */
  owner?: string;
}

export function GithubForm({ service }: { service: ServiceDetail }) {
  const installs = useOp(github.installations, {}, { retry: retryOp });
  const src = service.sourceConfig.type === "github" ? service.sourceConfig : null;
  const [choiceKey, setChoiceKey] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(src?.repo ?? null);
  const [branch, setBranch] = useState<string | null>(src?.branch ?? null);
  const [deployOnPush, setDeployOnPush] = useState(src?.deployOnPush ?? true);
  const invalidate = useInvalidate();
  const connect = useOpMutation(github.connectRepo, {
    onSuccess: () => {
      invalidate(services.get);
      invalidate(github.repoWebhook);
      toast.success(t("serviceSource.github.connected"));
    },
  });

  if (installs.isPending)
    return (
      <LoadingRegion label={t("common.loading")} className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <FieldSkeleton labelWidth="w-16" />
          <FieldSkeleton labelWidth="w-14" />
        </div>
        <div className="flex flex-col gap-1.5">
          <SkeletonText className="w-20 text-[13px]" />
          <Skeleton className="h-[38px]" />
          <RepoRowsSkeleton />
        </div>
        <FieldSkeleton labelWidth="w-24" hint />
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <SkeletonText className="w-28 text-[13.5px]" />
            <SkeletonText className="w-60 text-[12.5px] leading-normal" />
          </div>
          <Skeleton className="mt-0.5 h-5 w-9 shrink-0 rounded-full" />
        </div>
        <ButtonSkeleton className="w-[140px] self-start" />
      </LoadingRegion>
    );
  if (installs.isError) return <OpErrorNote error={installs.error} />;
  // Someone who may not see the App gets no installations: that does not mean there is no App.
  if (installs.data.hidden) return <ReadOnlyGithub repo={src?.repo ?? null} branch={src?.branch ?? null} />;
  const account = installs.data.account;
  const choices: Choice[] = [
    ...installs.data.installations
      .filter((i) => !i.suspended)
      .map((i) => ({ key: `i:${i.id}`, via: { installationId: i.id }, label: i.accountLogin, owner: i.accountLogin })),
    ...(account
      ? [
          {
            key: `a:${account.id}`,
            via: { accountId: account.id },
            label: t("serviceSource.github.accountOption", { login: account.login }),
          },
        ]
      : []),
  ];
  if (choices.length === 0) {
    return (
      <Callout
        tone="info"
        title={t("serviceSource.github.noAppTitle")}
        action={
          <>
            {installs.data.installUrl && (
              <Button asChild size="sm" variant="primary">
                <a href={installs.data.installUrl} target="_blank" rel="noreferrer">
                  {t("serviceSource.github.install")}
                </a>
              </Button>
            )}
            <Button asChild size="sm">
              <Link to="/settings/github">{t("serviceSource.github.setUp")}</Link>
            </Button>
          </>
        }
      >
        {t("serviceSource.github.noAppBody")}
      </Callout>
    );
  }
  // The saved source's installation or account, else the first choice; a picked one wins.
  const saved = src
    ? (choices.find((c) => (src.installationId ? c.key === `i:${src.installationId}` : c.key.startsWith("a:")))?.key ?? null)
    : null;
  const chosen = choices.find((c) => c.key === (choiceKey ?? saved)) ?? choices[0] ?? null;
  const via = chosen?.via ?? null;
  // The repository webhook (or polling) only exists for a source read through the account.
  const viaAccountNow = src !== null && src.installationId === null && chosen?.via.accountId !== undefined && repo === src.repo;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!via || !repo || !branch) return;
        connect.mutate({ serviceId: service.id, ...via, repo, branch, deployOnPush });
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("serviceSource.github.account")}>
          <Select
            value={chosen?.key}
            onValueChange={(v) => {
              setChoiceKey(v);
              setRepo(null);
              setBranch(null);
            }}
          >
            <SelectTrigger aria-label={t("serviceSource.github.account")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("serviceSource.github.branch")}>
          {via && repo ? (
            <BranchSelect projectId={service.projectId} {...via} repo={repo} value={branch} onChange={setBranch} />
          ) : (
            <Input disabled placeholder={t("serviceSource.github.pickRepoFirst")} aria-label={t("serviceSource.github.branch")} />
          )}
        </Field>
      </div>
      {via && chosen && (
        <RepoPicker
          key={chosen.key}
          projectId={service.projectId}
          via={via}
          owner={chosen.owner ?? null}
          // Where a typed repository of another owner is read: the installation on that owner, else the connected account.
          accountFor={(o) =>
            choices.find((c) => c.owner?.toLowerCase() === o.toLowerCase())?.label ?? choices.find((c) => c.via.accountId)?.label ?? null
          }
          value={repo}
          onChange={(r, nextBranch) => {
            setRepo(r);
            setBranch(nextBranch);
          }}
        />
      )}
      <ToggleRow
        title={t("serviceSource.deployOnPush")}
        description={t("serviceSource.deployOnPushHint")}
        control={<Switch checked={deployOnPush} onCheckedChange={setDeployOnPush} aria-label={t("serviceSource.deployOnPush")} />}
      />
      {viaAccountNow && <RepoHookNote serviceId={service.id} />}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!via || !repo || !branch || connect.isPending}>
          {t("serviceSource.github.connect")}
        </Button>
        <MutationError error={connect.error} />
      </div>
    </form>
  );
}

/** How a repository read through the connected account reaches the panel on push: its webhook, or polling and why. */
function RepoHookNote({ serviceId }: { serviceId: string }) {
  const hook = useOp(github.repoWebhook, { serviceId }, { retry: retryOp });
  if (!hook.data?.configured) return null;
  return (
    <p data-testid="repo-hook-note" className="m-0 text-[12.5px] leading-normal text-muted-foreground">
      {hook.data.created ? t("serviceSource.github.hookOk") : (hook.data.error ?? t("serviceSource.github.hookPolling"))}
    </p>
  );
}

/** The connected repository and branch, for someone who may not change them (and so does not see the App). */
function ReadOnlyGithub({ repo, branch }: { repo: string | null; branch: string | null }) {
  return (
    <div className="flex flex-col gap-4">
      {repo && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("serviceSource.github.repository")} htmlFor="gh-repo-readonly">
            <Input id="gh-repo-readonly" className="font-mono" value={repo} readOnly />
          </Field>
          <Field label={t("serviceSource.github.branch")} htmlFor="gh-branch-readonly">
            <Input id="gh-branch-readonly" className="font-mono" value={branch ?? ""} readOnly />
          </Field>
        </div>
      )}
      <p className="m-0 text-[12.5px] leading-normal text-muted-foreground">{t("serviceSource.github.readOnly")}</p>
    </div>
  );
}

function RepoPicker({
  projectId,
  via,
  owner,
  accountFor,
  value,
  onChange,
}: {
  projectId: string;
  via: GithubVia;
  /** The picked installation's GitHub login (it reads only that owner's repositories); null for the connected account. */
  owner: string | null;
  /** The Account choice that reads another owner's repositories, if any. */
  accountFor: (owner: string) => string | null;
  value: string | null;
  /** The repository and its branch: a link's tree/<branch>, else the default one (null when it has none yet). */
  onChange: (repo: string, branch: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const text = query.trim();
  const typed = useMemo(() => githubParse(text), [text]);
  const named = typed.ok ? typed.repo : null;
  // A link or owner/repo searches for that repository; anything else searches as typed.
  const search = useDeferredValue(named ? named.path : text);
  const repos = useOp(github.repos, { projectId, ...via, query: search || undefined }, { retry: retryOp });
  // The typed repository is read by name through the picked account or App once the text rests:
  // it may be one the list does not show (an organization's, a collaborator's, past the first page).
  const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  // An installation reads one owner's repositories: another owner's is not looked up through it (a public
  // one would read fine, but the App's webhook would never deliver its pushes); the hint names where it is.
  const typedOwner = named?.path.split("/")[0] ?? null;
  const elsewhere = owner !== null && typedOwner !== null && !same(typedOwner, owner) ? typedOwner : null;
  const looked = named && !elsewhere ? named.path : null;
  const settled = useDebounced(looked, 300);
  const lookup = useOp(github.branches, { projectId, ...via, repo: settled ?? "" }, { enabled: settled !== null, retry: false });
  const listed = named ? repos.data?.repos.find((r) => same(r.fullName, named.path)) : undefined;
  const typedName = listed?.fullName ?? named?.path ?? null;
  // Checking: the text has not rested, or the first answer (or a retry of a failure) is on its way. A refetch
  // of an answer it has (when the branch list mounts, or the socket reconnects) keeps the found row.
  const checking = looked !== null && (settled !== looked || lookup.isPending || (lookup.isFetching && lookup.isError));
  const found = looked !== null && settled === looked && lookup.data ? lookup.data : null;
  const failed = looked !== null && !checking && !found && lookup.isError ? lookup.error : null;
  const pickTyped = () => {
    if (!named || !found || !typedName) return;
    onChange(typedName, branchFromRef(named.ref, found.branches) ?? found.defaultBranch ?? found.branches[0] ?? null);
  };
  // The typed repository moves to the top once it is found; until then (or if reading it fails) a listed one stays in the list.
  const rest = (repos.data?.repos ?? []).filter((r) => !found || !same(r.fullName, typedName));
  // Nothing to show under a typed repository that is still being read or cannot be: no empty gray box.
  const emptyUnderTyped = named !== null && !found && repos.isSuccess && rest.length === 0;
  // "acme/shop" typed to filter the list (acme/shop-api, acme/shop-worker) is a search, not a missing repository.
  const missingButListed = failed !== null && lookupStateOf(failed) === "missing" && rest.length > 0;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter in the search box picks, it never connects: the typed repository once found, or the only match.
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (found) pickTyped();
    else if ((!named || failed || elsewhere) && rest.length === 1 && rest[0]) onChange(rest[0].fullName, rest[0].defaultBranch);
  };
  const problem = !typed.ok && ["notGithub", "credentials", "insecure"].includes(typed.problem) ? typed.problem : null;
  return (
    <Field label={t("serviceSource.github.repository")}>
      <div className="relative">
        <IconSearch size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
        <Input
          className="pl-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("serviceSource.github.searchPlaceholder")}
          aria-label={t("serviceSource.github.searchRepos")}
          aria-describedby={problem ? "gh-repo-problem" : undefined}
        />
      </div>
      {problem && (
        <p id="gh-repo-problem" className="m-0 text-[12.5px] leading-normal text-muted-foreground">
          {t(
            problem === "notGithub"
              ? "serviceSource.github.typedNotGithub"
              : problem === "credentials"
                ? "serviceSource.github.typedCredentials"
                : "serviceSource.github.typedInsecure",
          )}
        </p>
      )}
      {/* The typed repository while it is read, or why it cannot be: status, not a choice in the list. */}
      {checking && typedName && (
        <p role="status" className="m-0 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <span className="font-mono">{typedName}</span>
          <span className="sr-only">{t("serviceSource.github.typedChecking", { repo: typedName })}</span>
          <SkeletonText className="w-24 text-xs" />
        </p>
      )}
      {failed && !missingButListed ? <OpErrorNote error={failed} compact /> : null}
      {elsewhere && (
        <p className="m-0 text-[12.5px] leading-normal text-muted-foreground">
          {accountFor(elsewhere)
            ? t("serviceSource.github.typedOtherAccount", { owner: elsewhere, account: accountFor(elsewhere) ?? "" })
            : t("serviceSource.github.typedNotInstalled", { owner: elsewhere, login: owner ?? "" })}
        </p>
      )}
      {!emptyUnderTyped && (
        <div
          role="listbox"
          aria-label={t("serviceSource.github.repository")}
          className="flex max-h-64 flex-col overflow-y-auto rounded-control bg-raised p-1"
        >
          {found && typedName && (
            <RepoOption
              name={typedName}
              isPrivate={listed?.private ?? false}
              selected={same(value, typedName)}
              onPick={pickTyped}
              trailing={t("serviceSource.github.typedUse")}
            />
          )}
          {repos.isPending ? (
            <RepoRowsSkeleton bare />
          ) : repos.isError ? (
            <OpErrorNote error={repos.error} compact />
          ) : rest.length === 0 ? (
            // A typed repository has its own row: "No repositories match" under it would read as "not found".
            named ? null : (
              <p className="m-0 p-3 text-[12.5px] text-muted-foreground">
                {t(via.accountId ? "serviceSource.github.noReposAccount" : "serviceSource.github.noRepos")}
              </p>
            )
          ) : (
            rest.map((r) => (
              <RepoOption
                key={r.fullName}
                name={r.fullName}
                isPrivate={r.private}
                pushedAt={r.pushedAt}
                selected={value === r.fullName}
                onPick={() => onChange(r.fullName, r.defaultBranch)}
              />
            ))
          )}
        </div>
      )}
    </Field>
  );
}

/**
 * One repository of the list. The chosen one: the accent fill and a check,
 * as in the New app picker (a card fill on the gray list vanishes in dark presets).
 */
function RepoOption({
  name,
  isPrivate,
  pushedAt,
  selected,
  onPick,
  trailing,
}: {
  name: string;
  isPrivate: boolean;
  pushedAt?: string | null;
  selected: boolean;
  onPick: () => void;
  /** Shown where the push time goes, for the typed repository's "Use this repository". */
  trailing?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-chip border-0 bg-transparent px-2.5 py-2 text-left text-[13px] transition-interactive duration-200",
        selected ? "bg-accent" : "hover:bg-card",
      )}
    >
      <span className="truncate font-mono text-[12.5px]">{name}</span>
      {isPrivate && (
        <Chip tone="gray" className="py-0">
          <IconLock size={11} />
          {t("serviceSource.github.private")}
        </Chip>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {trailing && !selected && <span className="text-xs whitespace-nowrap text-muted-foreground">{trailing}</span>}
        {pushedAt && <span className="text-xs whitespace-nowrap text-muted-foreground">{formatRelative(pushedAt)}</span>}
        {selected && <IconCheck size={15} stroke={2} className="text-primary" aria-hidden="true" />}
      </span>
    </button>
  );
}

/**
 * The branches of the picked repository. When the list fails (the App or
 * the account lost access, a rate limit, a repository that is gone) the
 * error shows under the field: the saved or default branch alone in the
 * list would hide it otherwise.
 */
export function BranchSelect({
  projectId,
  installationId,
  accountId,
  repo,
  value,
  onChange,
}: {
  projectId: string;
  installationId?: string;
  accountId?: string;
  repo: string;
  value: string | null;
  onChange: (branch: string) => void;
}) {
  const via = accountId ? { accountId } : { installationId: installationId ?? "" };
  const branches = useOp(github.branches, { projectId, ...via, repo }, { retry: retryOp });
  const list = branches.data?.branches ?? (value ? [value] : []);
  // While the list loads the trigger shows a skeleton (loading), never a "Loading" placeholder.
  const placeholder = branches.isError
    ? t("serviceSource.github.branchesFailed")
    : list.length === 0
      ? t("serviceSource.github.noBranches")
      : t("serviceSource.github.pickBranch");
  return (
    <>
      <Select value={value ?? undefined} onValueChange={onChange} disabled={list.length === 0}>
        <SelectTrigger aria-label={t("serviceSource.github.branch")} className="font-mono" loading={branches.isPending && !value}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {list.map((b) => (
            <SelectItem key={b} value={b} className="font-mono">
              {b}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {branches.isError && <OpErrorNote error={branches.error} compact />}
    </>
  );
}

/** Repository rows while the list loads: name and when it was pushed. */
function RepoRowsSkeleton({ bare = false }: { bare?: boolean }) {
  const rows = [0, 1, 2].map((i) => (
    <div key={i} className="flex items-center gap-2 px-2.5 py-2 text-[13px]">
      <SkeletonText ground className="w-36" />
      <SkeletonText ground className="ml-auto w-16 text-xs" />
    </div>
  ));
  return bare ? rows : <div className="flex flex-col rounded-control bg-raised p-1">{rows}</div>;
}
