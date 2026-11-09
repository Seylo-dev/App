// Pick a GitHub repository and branch through the panel's GitHub App or its
// connected GitHub account (Settings > GitHub, a device login or a token).

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
import { IconLock, IconSearch } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { t } from "../../../i18n/t";
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
}

export function GithubForm({ service }: { service: ServiceDetail }) {
  const installs = useOp(github.installations, {}, { retry: retryOp });
  const src = service.sourceConfig.type === "github" ? service.sourceConfig : null;
  const [choiceKey, setChoiceKey] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(src?.repo ?? null);
  const [branch, setBranch] = useState<string | null>(src?.branch ?? null);
  const [rootDir, setRootDir] = useState(service.build.contextPath);
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
      .map((i) => ({ key: `i:${i.id}`, via: { installationId: i.id }, label: i.accountLogin })),
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
        connect.mutate({ serviceId: service.id, ...via, repo, branch, rootDir, deployOnPush });
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
          value={repo}
          onChange={(r, defaultBranch) => {
            setRepo(r);
            setBranch(defaultBranch);
          }}
        />
      )}
      <Field label={t("serviceSource.rootDir")} htmlFor="gh-root" hint={t("serviceSource.rootDirHint")}>
        <Input id="gh-root" className="font-mono" value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="apps/web" />
      </Field>
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
  value,
  onChange,
}: {
  projectId: string;
  via: GithubVia;
  value: string | null;
  onChange: (repo: string, defaultBranch: string) => void;
}) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const repos = useOp(github.repos, { projectId, ...via, query: deferred || undefined }, { retry: retryOp });
  return (
    <Field label={t("serviceSource.github.repository")}>
      <div className="relative">
        <IconSearch size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
        <Input
          className="pl-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("serviceSource.github.searchRepos")}
          aria-label={t("serviceSource.github.searchRepos")}
        />
      </div>
      <div
        role="listbox"
        aria-label={t("serviceSource.github.repository")}
        className="flex max-h-64 flex-col overflow-y-auto rounded-control bg-raised p-1"
      >
        {repos.isPending ? (
          <RepoRowsSkeleton bare />
        ) : repos.isError ? (
          <OpErrorNote error={repos.error} compact />
        ) : repos.data.repos.length === 0 ? (
          <p className="m-0 p-3 text-[12.5px] text-muted-foreground">
            {t(via.accountId ? "serviceSource.github.noReposAccount" : "serviceSource.github.noRepos")}
          </p>
        ) : (
          repos.data.repos.map((r) => (
            <button
              key={r.fullName}
              type="button"
              role="option"
              aria-selected={value === r.fullName}
              onClick={() => onChange(r.fullName, r.defaultBranch)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-chip border-0 bg-transparent px-2.5 py-2 text-left text-[13px] transition-interactive duration-200 hover:bg-card",
                value === r.fullName && "bg-card shadow-control",
              )}
            >
              <span className="truncate font-mono text-[12.5px]">{r.fullName}</span>
              {r.private && (
                <Chip tone="gray" className="py-0">
                  <IconLock size={11} />
                  {t("serviceSource.github.private")}
                </Chip>
              )}
              {r.pushedAt && <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">{formatRelative(r.pushedAt)}</span>}
            </button>
          ))
        )}
      </div>
    </Field>
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
