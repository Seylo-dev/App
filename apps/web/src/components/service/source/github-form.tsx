// Pick a GitHub repository and branch through the panel's GitHub App.

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

export function GithubForm({ service }: { service: ServiceDetail }) {
  const installs = useOp(github.installations, {}, { retry: retryOp });
  const src = service.sourceConfig.type === "github" ? service.sourceConfig : null;
  const [installationId, setInstallationId] = useState<string | null>(src?.installationId ?? null);
  const [repo, setRepo] = useState<string | null>(src?.repo ?? null);
  const [branch, setBranch] = useState<string | null>(src?.branch ?? null);
  const [rootDir, setRootDir] = useState(service.build.contextPath);
  const [deployOnPush, setDeployOnPush] = useState(src?.deployOnPush ?? true);
  const invalidate = useInvalidate();
  const connect = useOpMutation(github.connectRepo, {
    onSuccess: () => {
      invalidate(services.get);
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
  const list = installs.data.installations.filter((i) => !i.suspended);
  if (list.length === 0) {
    return (
      <Callout
        tone="info"
        title={t("serviceSource.github.noAppTitle")}
        action={
          installs.data.installUrl ? (
            <Button asChild size="sm" variant="primary">
              <a href={installs.data.installUrl} target="_blank" rel="noreferrer">
                {t("serviceSource.github.install")}
              </a>
            </Button>
          ) : (
            <Button asChild size="sm">
              <Link to="/settings/github">{t("serviceSource.github.setUp")}</Link>
            </Button>
          )
        }
      >
        {t("serviceSource.github.noAppBody")}
      </Callout>
    );
  }
  const install = installationId ?? list[0]?.id ?? null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!install || !repo || !branch) return;
        connect.mutate({ serviceId: service.id, installationId: install, repo, branch, rootDir, deployOnPush });
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("serviceSource.github.account")}>
          <Select
            value={install ?? undefined}
            onValueChange={(v) => {
              setInstallationId(v);
              setRepo(null);
              setBranch(null);
            }}
          >
            <SelectTrigger aria-label={t("serviceSource.github.account")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {list.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.accountLogin}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("serviceSource.github.branch")}>
          {install && repo ? (
            <BranchSelect projectId={service.projectId} installationId={install} repo={repo} value={branch} onChange={setBranch} />
          ) : (
            <Input disabled placeholder={t("serviceSource.github.pickRepoFirst")} aria-label={t("serviceSource.github.branch")} />
          )}
        </Field>
      </div>
      {install && (
        <RepoPicker
          projectId={service.projectId}
          installationId={install}
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
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!install || !repo || !branch || connect.isPending}>
          {t("serviceSource.github.connect")}
        </Button>
        <MutationError error={connect.error} />
      </div>
    </form>
  );
}

function RepoPicker({
  projectId,
  installationId,
  value,
  onChange,
}: {
  projectId: string;
  installationId: string;
  value: string | null;
  onChange: (repo: string, defaultBranch: string) => void;
}) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const repos = useOp(github.repos, { projectId, installationId, query: deferred || undefined }, { retry: retryOp });
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
          <p className="m-0 p-3 text-[12.5px] text-muted-foreground">{t("serviceSource.github.noRepos")}</p>
        ) : (
          repos.data.repos.map((r) => (
            <button
              key={r.fullName}
              type="button"
              role="option"
              aria-selected={value === r.fullName}
              onClick={() => onChange(r.fullName, r.defaultBranch)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-chip border-0 bg-transparent px-2.5 py-2 text-left text-[13px] hover:bg-card",
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

function BranchSelect({
  projectId,
  installationId,
  repo,
  value,
  onChange,
}: {
  projectId: string;
  installationId: string;
  repo: string;
  value: string | null;
  onChange: (branch: string) => void;
}) {
  const branches = useOp(github.branches, { projectId, installationId, repo }, { retry: retryOp });
  const list = branches.data?.branches ?? (value ? [value] : []);
  return (
    <Select value={value ?? undefined} onValueChange={onChange} disabled={branches.isPending && !value}>
      <SelectTrigger aria-label={t("serviceSource.github.branch")} className="font-mono">
        <SelectValue placeholder={branches.isError ? t("service.notBuilt.title") : t("service.loading")} />
      </SelectTrigger>
      <SelectContent>
        {list.map((b) => (
          <SelectItem key={b} value={b} className="font-mono">
            {b}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
