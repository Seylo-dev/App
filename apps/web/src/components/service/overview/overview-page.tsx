// The Overview tab. Apps: where it runs, the live and latest deploy, its
// domains, a usage graph and quick actions. Compose stacks: their members.
// Cron services: the schedule and recent runs. Boxes: the editor's state.
// Databases have no overview; their first tab is Connection.

import { boxes, deployments, domains, metrics, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { KeyValue } from "@seylo/ui/components/key-value";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { SmoothChart } from "@seylo/ui/components/smooth-chart";
import { toast } from "@seylo/ui/components/toast";
import { IconLock, IconTerminal2, IconWorld } from "@tabler/icons-react";
import { Link, Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { CronRuns } from "../cron/cron-page";
import { describeCron } from "../cron-text";
import { StepChips } from "../deploy-steps";
import { deploymentTitle, deploymentVersion } from "../deployment-meta";
import { formatBytes, formatPercent, formatRelative } from "../format";
import { KindBadge } from "../kind-badge";
import { isNotBuilt, OpErrorNote, retryOp } from "../op-state";
import { isActiveDeployment, isDatabaseKind } from "../status";
import { DeploymentStatusChip, ServiceStatusChip } from "../status-chip";
import { crashPolicyLabel } from "../usage-strip";
import type { ServiceDetail } from "../use-service";

export function OverviewPage({ service }: { service: ServiceDetail }) {
  if (isDatabaseKind(service.kind))
    return <Navigate to="/p/$projectId/s/$serviceId/connection" params={{ projectId: service.projectId, serviceId: service.id }} replace />;
  if (service.kind === "compose") return <StackOverview service={service} />;
  if (service.kind === "box") return <BoxOverview service={service} />;
  if (service.kind === "cron") return <CronOverview service={service} />;
  return <AppOverview service={service} />;
}

function Panel({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </Card>
  );
}

function AppOverview({ service }: { service: ServiceDetail }) {
  const p = { projectId: service.projectId, serviceId: service.id };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <LatestDeploy service={service} />
        <UsagePanel service={service} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title={t("serviceOverview.runsOn")}>
          <KeyValue
            items={[
              ...service.placements.map((pl) => ({
                key: pl.nodeId,
                label: pl.nodeName,
                value: t("serviceOverview.replicas", { count: pl.replicas }),
              })),
              {
                key: "source",
                label: t("service.tabs.source"),
                value: [service.source.label, service.source.branch].filter(Boolean).join(" · ") || "-",
              },
              {
                key: "ports",
                label: t("serviceOverview.ports"),
                value: service.ports.map((x) => `${x.containerPort}/${x.protocol}`).join(", ") || "-",
                mono: true,
              },
              { key: "crash", label: t("service.usage.crashPolicy"), value: crashPolicyLabel(service) },
              { key: "gen", label: t("serviceOverview.generation"), value: String(service.generation), mono: true },
            ]}
          />
        </Panel>
        <DomainsPanel service={service} />
        <Panel title={t("serviceOverview.quick")}>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link to="/p/$projectId/s/$serviceId/console" params={p}>
                <IconTerminal2 size={14} />
                {t("service.tabs.console")}
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/p/$projectId/s/$serviceId/logs" params={p}>
                {t("service.tabs.logs")}
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/p/$projectId/s/$serviceId/environment" params={p}>
                {t("service.tabs.environment")}
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/p/$projectId/s/$serviceId/domains" params={p}>
                {t("serviceDomains.add")}
              </Link>
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function LatestDeploy({ service }: { service: ServiceDetail }) {
  const list = useOp(
    deployments.list,
    { serviceId: service.id, limit: 5 },
    { retry: retryOp, refetchInterval: (q) => (q.state.data?.deployments.some((d) => isActiveDeployment(d.status)) ? 2000 : false) },
  );
  const p = { projectId: service.projectId, serviceId: service.id };
  const latest = list.data?.deployments[0];
  const live = list.data?.deployments.find((d) => d.live);
  return (
    <Panel
      title={t("serviceOverview.deploys")}
      action={
        <Link to="/p/$projectId/s/$serviceId/deployments" params={p} className="text-[12.5px] font-medium">
          {t("serviceOverview.allDeploys")}
        </Link>
      }
    >
      {list.isPending ? (
        <Skeleton className="h-16" />
      ) : list.isError ? (
        <OpErrorNote error={list.error} compact />
      ) : !latest ? (
        <EmptyState compact title={t("serviceDeploys.empty")} description={t("serviceDeploys.emptyHint")} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-[13.5px] font-semibold">{deploymentTitle(latest)}</b>
            <span className="font-mono text-xs text-muted-foreground">{deploymentVersion(latest)}</span>
            <DeploymentStatusChip status={latest.status} />
            <span className="ml-auto text-xs text-muted-foreground">{formatRelative(latest.createdAt)}</span>
          </div>
          <StepChips steps={latest.steps} />
          {latest.error && <span className="text-[12.5px] text-chip-red-fg">{latest.error}</span>}
          {live && live.id !== latest.id && (
            <span className="text-[12.5px] text-muted-foreground">
              {t("serviceOverview.liveIs", {
                version: deploymentVersion(live) || deploymentTitle(live),
                when: formatRelative(live.createdAt),
              })}
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}

function UsagePanel({ service }: { service: ServiceDetail }) {
  const data = useOp(metrics.service, { serviceId: service.id, range: "1h" }, { retry: retryOp, refetchInterval: 60_000 });
  const points = data.data?.points ?? [];
  return (
    <Panel
      title={t("serviceOverview.lastHour")}
      action={
        <Link
          to="/p/$projectId/s/$serviceId/metrics"
          params={{ projectId: service.projectId, serviceId: service.id }}
          className="text-[12.5px] font-medium"
        >
          {t("service.usage.openMetrics")}
        </Link>
      }
    >
      {data.isError ? (
        <OpErrorNote error={data.error} compact />
      ) : points.length < 2 ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">{data.isPending ? t("service.loading") : t("serviceMetrics.noData")}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("service.usage.cpu")} · {formatPercent(service.cpuPercent)}
            </span>
            <SmoothChart
              aria-label={t("service.usage.cpu")}
              height={90}
              min={0}
              gridLines={2}
              series={[{ id: "cpu", label: t("service.usage.cpu"), values: points.map((x) => x.cpuPercent) }]}
              formatValue={(v) => formatPercent(v)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t("service.usage.memory")} · {formatBytes(service.memoryBytes)}
            </span>
            <SmoothChart
              aria-label={t("service.usage.memory")}
              height={90}
              min={0}
              gridLines={2}
              series={[{ id: "mem", label: t("service.usage.memory"), values: points.map((x) => x.memoryBytes), color: "var(--chart-5)" }]}
              formatValue={(v) => formatBytes(v)}
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

function DomainsPanel({ service }: { service: ServiceDetail }) {
  const list = useOp(domains.list, { serviceId: service.id }, { retry: retryOp });
  const rows = list.data?.domains.slice(0, 4) ?? [];
  return (
    <Panel title={t("service.tabs.domains")}>
      {list.isError ? (
        <OpErrorNote error={list.error} compact />
      ) : rows.length === 0 ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">{list.isPending ? t("service.loading") : t("serviceDomains.empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((d) => (
            <li key={d.id} className="flex items-center gap-2 text-[12.5px]">
              {d.https !== "off" ? <IconLock size={13} className="text-status-ok" /> : <IconWorld size={13} className="text-ink-faint" />}
              <a href={d.url} target="_blank" rel="noreferrer" className="truncate font-mono">
                {d.host}
                {d.pathPrefix !== "/" ? d.pathPrefix : ""}
              </a>
              {d.primary && <Chip tone="blue">{t("serviceDomains.primary")}</Chip>}
              {d.dnsStatus !== "ok" && !d.auto && !d.forward && <Chip tone="amber">{t(`serviceDomains.dns.${d.dnsStatus}`)}</Chip>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function StackOverview({ service }: { service: ServiceDetail }) {
  const list = useOp(services.list, { projectId: service.projectId }, { retry: retryOp });
  const members = list.data?.services.filter((s) => s.parentId === service.id) ?? [];
  const rows = members.length
    ? members
    : service.members.map((m) => ({ ...m, kind: "app" as const, source: null, cpuPercent: null, memoryBytes: null }));
  return (
    <Card className="gap-0 overflow-hidden p-0" aria-label={t("serviceOverview.members")}>
      <div className="flex items-center gap-2 px-5 pt-4 pb-3.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("serviceOverview.members")}</h2>
        <span className="text-[12.5px] text-muted-foreground">{t("serviceOverview.membersHint")}</span>
      </div>
      {rows.length === 0 ? (
        <div className="border-t border-divider">
          <EmptyState compact title={t("serviceOverview.noMembers")} />
        </div>
      ) : (
        rows.map((m) => (
          <Link
            key={m.id}
            to="/p/$projectId/s/$serviceId"
            params={{ projectId: service.projectId, serviceId: m.id }}
            className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-3 text-[13px] text-foreground hover:bg-raised"
          >
            <KindBadge kind={m.kind} size="sm" />
            <b className="font-semibold">{m.name}</b>
            <ServiceStatusChip status={m.status} />
            {m.source && <span className="font-mono text-xs text-muted-foreground">{m.source.label}</span>}
            {m.cpuPercent != null && (
              <span className="ml-auto text-xs text-muted-foreground">
                {formatPercent(m.cpuPercent)} · {formatBytes(m.memoryBytes)}
              </span>
            )}
          </Link>
        ))
      )}
    </Card>
  );
}

function CronOverview({ service }: { service: ServiceDetail }) {
  const c = service.cron;
  return (
    <div className="flex flex-col gap-4">
      <Panel title={t("serviceAdvanced.cron.title")}>
        {c ? (
          <KeyValue
            layout="grid"
            items={[
              { key: "when", label: t("serviceCron.schedule"), value: `${describeCron(c.schedule)} · ${c.timeZone}` },
              { key: "cmd", label: t("serviceCron.command"), value: c.command.join(" ") || t("serviceOverview.imageDefault"), mono: true },
              { key: "limit", label: t("serviceCron.timeout"), value: `${c.timeoutSeconds}s` },
              { key: "conc", label: t("serviceCron.concurrency"), value: t(`serviceCron.concurrencyOptions.${c.concurrency}`) },
            ]}
          />
        ) : (
          <p className="m-0 text-[12.5px] text-muted-foreground">{t("serviceOverview.noSchedule")}</p>
        )}
      </Panel>
      <CronRuns service={service} />
    </div>
  );
}

function BoxOverview({ service }: { service: ServiceDetail }) {
  const box = useOp(boxes.get, { serviceId: service.id }, { retry: retryOp, refetchInterval: 15_000 });
  const open = useOpMutation(boxes.open, {
    onSuccess: (res) => window.open(res.url, "_blank", "noopener"),
    onError: (error) => toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed"))),
  });
  if (box.isPending) return <Skeleton className="h-40 rounded-card" />;
  if (box.isError) return <OpErrorNote error={box.error} />;
  const b = box.data;
  const tone = b.state === "running" ? "green" : b.state === "starting" ? "amber" : "gray";
  return (
    <Panel
      title={t("serviceOverview.box.title")}
      action={
        <Button variant="primary" size="sm" onClick={() => open.mutate({ serviceId: service.id })} disabled={open.isPending}>
          {t("service.header.openBox")}
        </Button>
      }
    >
      <p className="m-0 text-[13px] text-ink-strong">{t("serviceOverview.box.description")}</p>
      <KeyValue
        layout="grid"
        items={[
          {
            key: "state",
            label: t("serviceOverview.box.state"),
            value: <Chip tone={tone}>{t(`serviceOverview.box.states.${b.state}`)}</Chip>,
          },
          { key: "node", label: t("serviceOverview.runsOn"), value: b.nodeName },
          { key: "repo", label: t("serviceOverview.box.repository"), value: b.repository ?? "-", mono: true },
          {
            key: "idle",
            label: t("serviceOverview.box.sleeps"),
            value: b.idleMinutes ? t("serviceOverview.box.afterIdle", { count: b.idleMinutes }) : t("serviceOverview.box.never"),
          },
          { key: "used", label: t("serviceOverview.box.lastUsed"), value: b.lastUsedAt ? formatRelative(b.lastUsedAt) : "-" },
        ]}
      />
    </Panel>
  );
}
