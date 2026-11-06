// Pick a GitLab, Gitea/Forgejo or Bitbucket repository and branch through
// one of the panel's connections (Settings > Git providers), and see the
// repository webhook the panel created for it.

import { gitProviders, type OpOutput, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconLock, IconRefresh, IconSearch } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { t } from "../../../i18n/t";
import { Field, ToggleRow } from "../field";
import { formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

export type ProviderKind = "gitlab" | "gitea" | "bitbucket";

export function ProviderForm({ service, kind }: { service: ServiceDetail; kind: ProviderKind }) {
  const connections = useOp(gitProviders.list, {}, { retry: retryOp });
  const src = service.sourceConfig.type === "provider" && service.sourceConfig.provider === kind ? service.sourceConfig : null;
  const [providerId, setProviderId] = useState<string | null>(src?.providerId ?? null);
  const [repo, setRepo] = useState<string | null>(src?.repo ?? null);
  const [branch, setBranch] = useState<string | null>(src?.branch ?? null);
  const [rootDir, setRootDir] = useState(service.build.contextPath);
  const [deployOnPush, setDeployOnPush] = useState(src?.deployOnPush ?? true);
  const invalidate = useInvalidate();
  const connect = useOpMutation(gitProviders.connectRepo, {
    onSuccess: () => {
      invalidate(services.get);
      invalidate(gitProviders.webhook);
      toast.success(t("serviceSource.provider.connected"));
    },
  });

  if (connections.isPending)
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-[58px]" />
          <Skeleton className="h-[58px]" />
        </div>
        <Skeleton className="h-40" />
      </div>
    );
  if (connections.isError) return <OpErrorNote error={connections.error} />;
  const list = connections.data.items.filter((c) => c.kind === kind);
  const providerName = t(`serviceSource.types.${kind}.name`);
  if (list.length === 0) {
    return (
      <Callout
        tone="info"
        title={t("serviceSource.provider.noConnectionTitle", { provider: providerName })}
        action={
          <Button asChild size="sm" variant="primary">
            <Link to="/settings/git-providers">{t("serviceSource.provider.addConnection")}</Link>
          </Button>
        }
      >
        {t("serviceSource.provider.noConnectionBody")}
      </Callout>
    );
  }
  const chosen = providerId ?? list[0]?.id ?? null;

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen || !repo || !branch) return;
          connect.mutate({ serviceId: service.id, providerId: chosen, repo, branch, rootDir, deployOnPush });
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("serviceSource.provider.connection")}>
            <Select
              value={chosen ?? undefined}
              onValueChange={(v) => {
                setProviderId(v);
                setRepo(null);
                setBranch(null);
              }}
            >
              <SelectTrigger aria-label={t("serviceSource.provider.connection")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} <span className="text-muted-foreground">{c.workspace ?? c.host}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("serviceSource.provider.branch")}>
            {chosen && repo ? (
              <BranchSelect projectId={service.projectId} providerId={chosen} repo={repo} value={branch} onChange={setBranch} />
            ) : (
              <Input disabled placeholder={t("serviceSource.provider.pickRepoFirst")} aria-label={t("serviceSource.provider.branch")} />
            )}
          </Field>
        </div>
        {chosen && (
          <RepoPicker
            projectId={service.projectId}
            providerId={chosen}
            value={repo}
            onChange={(r, defaultBranch) => {
              setRepo(r);
              setBranch(defaultBranch);
            }}
          />
        )}
        <Field label={t("serviceSource.rootDir")} htmlFor="provider-root" hint={t("serviceSource.rootDirHint")}>
          <Input
            id="provider-root"
            className="font-mono"
            value={rootDir}
            onChange={(e) => setRootDir(e.target.value)}
            placeholder="apps/web"
          />
        </Field>
        <ToggleRow
          title={t("serviceSource.deployOnPush")}
          description={t("serviceSource.deployOnPushHint")}
          control={<Switch checked={deployOnPush} onCheckedChange={setDeployOnPush} aria-label={t("serviceSource.deployOnPush")} />}
        />
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={!chosen || !repo || !branch || connect.isPending}>
            {t("serviceSource.provider.connect")}
          </Button>
          <MutationError error={connect.error} />
        </div>
      </form>
      {src && <WebhookStatus service={service} kind={kind} />}
    </div>
  );
}

type Repo = OpOutput<typeof gitProviders.repos>["repos"][number];

function RepoPicker({
  projectId,
  providerId,
  value,
  onChange,
}: {
  projectId: string;
  providerId: string;
  value: string | null;
  onChange: (repo: string, defaultBranch: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const deferred = useDeferredValue(query.trim());
  const repos = useOp(gitProviders.repos, { projectId, providerId, query: deferred || undefined, page }, { retry: retryOp });
  return (
    <Field label={t("serviceSource.provider.repository")}>
      <div className="relative">
        <IconSearch size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
        <Input
          className="pl-9"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder={t("serviceSource.provider.searchRepos")}
          aria-label={t("serviceSource.provider.searchRepos")}
        />
      </div>
      <div
        role="listbox"
        aria-label={t("serviceSource.provider.repository")}
        aria-busy={repos.isPending}
        className="flex max-h-64 flex-col overflow-y-auto rounded-control bg-raised p-1"
      >
        {repos.isPending ? (
          <>
            <Skeleton className="m-1 h-8" />
            <Skeleton className="m-1 h-8 w-4/5" />
            <Skeleton className="m-1 h-8 w-3/5" />
          </>
        ) : repos.isError ? (
          <OpErrorNote error={repos.error} compact />
        ) : repos.data.repos.length === 0 ? (
          <p className="m-0 p-3 text-[12.5px] text-muted-foreground">{t("serviceSource.provider.noRepos")}</p>
        ) : (
          <>
            {repos.data.repos.map((r: Repo) => (
              <button
                key={r.fullName}
                type="button"
                role="option"
                aria-selected={value === r.fullName}
                onClick={() => onChange(r.fullName, r.defaultBranch)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-chip border-0 bg-transparent px-2.5 py-2 text-left text-[13px] transition-colors duration-200 hover:bg-card",
                  value === r.fullName && "bg-card shadow-control",
                )}
              >
                <span className="truncate font-mono text-[12.5px]">{r.fullName}</span>
                {r.private && (
                  <Chip tone="gray" className="py-0">
                    <IconLock size={11} />
                    {t("serviceSource.provider.private")}
                  </Chip>
                )}
                {r.defaultBranch === null && (
                  <Chip tone="amber" className="py-0">
                    {t("serviceSource.provider.empty")}
                  </Chip>
                )}
                {r.updatedAt && (
                  <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">{formatRelative(r.updatedAt)}</span>
                )}
              </button>
            ))}
            {(repos.data.hasMore || page > 1) && (
              <div className="m-1 flex gap-1">
                {page > 1 && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))}>
                    {t("serviceSource.provider.previous")}
                  </Button>
                )}
                {repos.data.hasMore && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPage((p) => p + 1)}>
                    {t("serviceSource.provider.next")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Field>
  );
}

function BranchSelect({
  projectId,
  providerId,
  repo,
  value,
  onChange,
}: {
  projectId: string;
  providerId: string;
  repo: string;
  value: string | null;
  onChange: (branch: string) => void;
}) {
  const branches = useOp(gitProviders.branches, { projectId, providerId, repo }, { retry: retryOp });
  const list = branches.data?.branches ?? (value ? [value] : []);
  return (
    <Select value={value ?? undefined} onValueChange={onChange} disabled={branches.isPending && !value}>
      <SelectTrigger aria-label={t("serviceSource.provider.branch")} className="font-mono">
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

function WebhookStatus({ service, kind }: { service: ServiceDetail; kind: ProviderKind }) {
  const hook = useOp(gitProviders.webhook, { serviceId: service.id }, { retry: retryOp });
  const invalidate = useInvalidate();
  const repair = useOpMutation(gitProviders.repairWebhook, {
    onSuccess: (out) => {
      invalidate(gitProviders.webhook);
      if (out.created) toast.success(t("serviceSource.provider.repaired"));
    },
  });
  if (hook.isPending) return <Skeleton className="h-16 w-full" aria-busy="true" />;
  if (hook.isError) return <OpErrorNote error={hook.error} />;
  const data = hook.data;
  const repairButton = (
    <Button size="sm" onClick={() => repair.mutate({ serviceId: service.id })} disabled={repair.isPending}>
      <IconRefresh size={15} stroke={1.8} />
      {t("serviceSource.provider.repair")}
    </Button>
  );
  return (
    <div className="flex flex-col gap-2 border-t border-divider pt-4">
      <h3 className="m-0 text-[13px] font-semibold">{t("serviceSource.provider.webhook")}</h3>
      {data.created && data.url ? (
        <>
          <CopyField value={data.url} aria-label={t("serviceSource.provider.webhook")} />
          <p className="m-0 text-[12.5px] text-muted-foreground">
            {t("serviceSource.provider.webhookOk", { requests: t(`serviceSource.provider.requests.${kind}`) })}{" "}
            {data.lastDeliveryAt
              ? t("serviceSource.provider.lastDelivery", { when: formatRelative(data.lastDeliveryAt) })
              : t("serviceSource.provider.noDelivery")}
          </p>
          {data.insecure && (
            <Callout tone="warning" action={repairButton}>
              {t("serviceSource.provider.insecure")}
            </Callout>
          )}
        </>
      ) : (
        <Callout tone="warning" title={t("serviceSource.provider.webhookFailed")} action={repairButton}>
          {data.error} {t("serviceSource.provider.webhookFailedHint")}
        </Callout>
      )}
      <MutationError error={repair.error} />
    </div>
  );
}
