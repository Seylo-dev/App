// Pick a GitHub repository and branch through the panel's GitHub App.

import { github, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton } from "@seylo/ui/components/skeleton";
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

  if (installs.isPending) return <Skeleton className="h-24 w-full" />;
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
          <Skeleton className="m-1 h-8" />
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
