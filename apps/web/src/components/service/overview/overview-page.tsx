// The Overview tab. Apps: the console on top (with the same Console | Shell
// switch as the Console tab) and the latest deploy under it; on the right
// where it runs, its domains, a usage graph and quick actions. Compose stacks: their members.
// Cron services: the schedule and recent runs. Boxes: the editor's state.
// Databases have no overview; their first tab is Connection.

import { boxes, deployments, domains, metrics, services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip } from "@seylo/ui/components/chip";
import { CopyCode } from "@seylo/ui/components/code-block";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { KeyValue } from "@seylo/ui/components/key-value";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { SmoothChart } from "@seylo/ui/components/smooth-chart";
import { IconArrowUpRight, IconLock, IconPlus, IconWorld } from "@tabler/icons-react";
import { Link, Navigate } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { useLiveUp } from "../../../lib/live";
import { CronRuns } from "../cron/cron-page";
import { describeCron } from "../cron-text";
import { StepChips } from "../deploy-steps";
import { deploymentTitle, deploymentVersion } from "../deployment-meta";
import { AddDomainDialog } from "../domains/domain-dialogs";
import { NoRouteChip } from "../domains/no-route";
import { formatBytes, formatPercent, formatRelative } from "../format";
import { KindBadge } from "../kind-badge";
import { OpErrorNote, retryOp } from "../op-state";
import { PrivateRepoHint } from "../private-repo-hint";
import { TerminalSkeleton } from "../service-skeletons";
import { hasRunningInstance, isActiveDeployment, isDatabaseKind } from "../status";
import { DeploymentStatusChip, ServiceStatusChip } from "../status-chip";
import { latestDeployLimit } from "../tab-prefetch";
import { pickMode, type TerminalMode, useTerminalModes } from "../terminal/access";
import { ModeSwitch, ServiceTerminal } from "../terminal/console-pages";
import { consoleMayAttach, consoleRun } from "../terminal/follow";
import { TerminalNote } from "../terminal/terminal-panel";
import { crashPolicyLabel } from "../usage-strip";
import type { ServiceDetail } from "../use-service";

/** The Overview console card's height: about 20 lines of output with the header and the stdin line. */
export const consoleCardHeight = 480;
/** The tallest the Overview's console gets while it follows the right column (owner request). */
const consoleCardMaxHeight = 600;

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
  const right = useRef<HTMLDivElement>(null);
  const deploys = useRef<HTMLDivElement>(null);
  const consoleHeight = useConsoleHeight(right, deploys);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <ConsoleCard service={service} height={consoleHeight} />
        <div ref={deploys} className="flex flex-col">
          <LatestDeploy service={service} />
        </div>
      </div>
      {/* self-start: the column is as tall as its cards, so the console can be sized to end level with it. */}
      <div ref={right} className="flex min-w-0 flex-col gap-4 lg:self-start">
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
                // A portless app built from a repository still listens somewhere: the PORT the panel gives it.
                value:
                  service.ports.map((x) => `${x.containerPort}/${x.protocol}`).join(", ") ||
                  (service.appPort ? t("serviceOverview.portFromEnv", { port: service.appPort }) : "-"),
                mono: true,
              },
              { key: "crash", label: t("service.usage.crashPolicy"), value: crashPolicyLabel(service) },
              { key: "gen", label: t("serviceOverview.generation"), value: String(service.generation), mono: true },
            ]}
          />
        </Panel>
        <DomainsPanel service={service} />
        <UsagePanel service={service} />
        <Panel title={t("serviceOverview.quick")}>
          {/* No Console here: the console card on the left has it, with Open full to the tab. */}
          <div className="flex flex-wrap gap-2">
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
  // service:<id> refreshes this list when a deployment moves; poll fast only while the socket is down.
  const liveUp = useLiveUp();
  const list = useOp(
    deployments.list,
    { serviceId: service.id, limit: latestDeployLimit },
    {
      retry: retryOp,
      refetchInterval: (q) => (q.state.data?.deployments.some((d) => isActiveDeployment(d.status)) ? (liveUp ? 15_000 : 2000) : false),
    },
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
        <LoadingRegion label={t("common.loading")} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <SkeletonText className="w-44 text-[13.5px]" />
            <SkeletonText className="w-14 text-xs" />
            <Skeleton className="h-[22px] w-14 rounded-chip" />
            <SkeletonText className="ml-auto w-16 text-xs" />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {["w-16", "w-28", "w-28", "w-24", "w-[104px]"].map((width, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
              <Skeleton key={i} className={`h-[22px] rounded-chip ${width}`} />
            ))}
          </div>
        </LoadingRegion>
      ) : list.isError ? (
        <OpErrorNote error={list.error} compact />
      ) : !latest ? (
        <EmptyState compact title={t("serviceDeploys.empty")} description={t("serviceDeploys.emptyHint")} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-[13.5px] font-semibold">{deploymentTitle(latest, service.source)}</b>
            <span className="font-mono text-xs text-muted-foreground">{deploymentVersion(latest)}</span>
            <DeploymentStatusChip status={latest.status} buildWaiting={latest.buildWait != null} />
            <span className="ml-auto text-xs text-muted-foreground">{formatRelative(latest.createdAt)}</span>
          </div>
          <StepChips steps={latest.steps} buildWait={latest.buildWait} />
          {latest.error && <span className="text-[12.5px] text-chip-red-fg">{latest.error}</span>}
          <PrivateRepoHint service={service} d={latest} />
          {live && live.id !== latest.id && (
            <span className="text-[12.5px] text-muted-foreground">
              {t("serviceOverview.liveIs", {
                version: deploymentVersion(live) || deploymentTitle(live, service.source),
                when: formatRelative(live.createdAt),
              })}
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * The console on the Overview: the Console tab's terminal at a fixed
 * height, with the same Console | Shell switch. It is that height in every
 * state (loading, nothing running yet, connected, exited), so the column
 * never moves when the status changes. The first session waits for a
 * container that runs or starts (a shell: one that runs); after that the
 * terminal stays until the page is left, so a crash or a restart keeps the
 * last output and the exit note, a status change while it is connected
 * opens no new ticket, and the console connects again by itself while the
 * app runs and once it starts ("The app is not running." while nothing
 * does). It watches the console by itself
 * (output only, not in the audit log: looking at the page is no console
 * use) and opens the real console when a line is sent, a shell only when
 * asked (the switch, or Open shell for a person who may open only the
 * shell), never takes focus until clicked, and offers only the modes the
 * person may open: none at all hides it.
 */
export function ConsoleCard({ service, height, fullLink = true }: { service: ServiceDetail; height: number; fullLink?: boolean }) {
  const modes = useTerminalModes(service);
  const [wanted, setWanted] = useState<TerminalMode>("console");
  // The person used the switch: the mode they picked opens at once, a shell too.
  const [picked, setPicked] = useState(false);
  const [shown, setShown] = useState(false);
  const mode = modes ? pickMode(wanted, modes) : null;
  // The console shows and tries while the app starts too, so a slow start's output is there as it boots;
  // a shell needs a running container.
  const running = mode === "shell" ? hasRunningInstance(service) : consoleMayAttach(consoleRun(service));
  if (mode && running && !shown) setShown(true);
  if (modes === null) return <TerminalSkeleton height={height} />;
  if (!mode) return null;
  const choose = (next: TerminalMode) => {
    setWanted(next);
    setPicked(true);
  };
  if (!shown && !running)
    return (
      <TerminalNote
        label={t(`serviceTerminal.modes.${mode}`)}
        switcher={<ModeSwitch mode={mode} modes={modes} onChange={choose} />}
        height={height}
      >
        {t(mode === "shell" ? "serviceTerminal.notRunningShell" : "serviceTerminal.notRunning")}
      </TerminalNote>
    );
  return (
    <ServiceTerminal
      service={service}
      mode={mode}
      modes={modes}
      onModeChange={choose}
      height={height}
      start={mode === "shell" && !picked ? t("serviceTerminal.openShell") : undefined}
      subtitle={false}
      // Looking at the Overview is no console use: output only, until a line is sent.
      watch
      actions={
        // Kinds without a Console tab (databases) show the card without the way to it.
        fullLink && (
          <Link
            to="/p/$projectId/s/$serviceId/console"
            params={{ projectId: service.projectId, serviceId: service.id }}
            search={{ mode: mode === "shell" ? "shell" : undefined }}
            className="ml-1 inline-flex cursor-pointer items-center gap-1 rounded-chip px-2 py-[5px] text-[12.5px] font-medium text-terminal-muted hover:text-terminal-foreground max-sm:ml-0 max-sm:p-[7px]"
          >
            <IconArrowUpRight size={14} stroke={1.9} aria-hidden="true" />
            {/* Just the arrow on a phone, so the switch and the buttons share one row. */}
            <span className="max-sm:sr-only">{t("serviceTerminal.openFull")}</span>
          </Link>
        )
      }
    />
  );
}

/**
 * The console's height on a wide screen: the right column's height less the
 * deploys card under the console (and the gap between them), so both columns
 * end on one line; between consoleCardHeight (480) and 600 px. One column
 * (under lg): consoleCardHeight.
 */
function useConsoleHeight(right: RefObject<HTMLDivElement | null>, below: RefObject<HTMLDivElement | null>): number {
  const [height, setHeight] = useState(consoleCardHeight);
  useLayoutEffect(() => {
    const a = right.current;
    const b = below.current;
    if (!a || !b || typeof ResizeObserver === "undefined") return;
    const wide = window.matchMedia("(min-width: 1024px)");
    const update = () => {
      const fit = Math.round(a.offsetHeight - b.offsetHeight - 16);
      const next = wide.matches ? Math.min(consoleCardMaxHeight, Math.max(consoleCardHeight, fit)) : consoleCardHeight;
      setHeight((current) => (Math.abs(current - next) < 2 ? current : next));
    };
    const observer = new ResizeObserver(update);
    observer.observe(a);
    observer.observe(b);
    wide.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      wide.removeEventListener("change", update);
    };
  }, [right, below]);
  return height;
}

function UsagePanel({ service }: { service: ServiceDetail }) {
  // "service:<id>" (followed by the service layout) refreshes this; poll only while the socket is down.
  const liveUp = useLiveUp();
  const data = useOp(metrics.service, { serviceId: service.id, range: "1h" }, { retry: retryOp, refetchInterval: liveUp ? false : 60_000 });
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
      {/* In the right column: the two graphs side by side only where the card is wide enough. */}
      <div className="@container">
        {data.isError ? (
          <OpErrorNote error={data.error} compact />
        ) : data.isPending ? (
          <LoadingRegion label={t("common.loading")} className="grid gap-4 @md:grid-cols-2">
            {[t("service.usage.cpu"), t("service.usage.memory")].map((label) => (
              <div key={label} className="flex flex-col gap-1">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {label} · <SkeletonText className="w-10" />
                </span>
                <Skeleton className="h-[90px]" />
              </div>
            ))}
          </LoadingRegion>
        ) : points.length < 2 ? (
          <p className="m-0 text-[12.5px] text-muted-foreground">{t("serviceMetrics.noData")}</p>
        ) : (
          <div className="grid gap-4 @md:grid-cols-2">
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
                series={[
                  { id: "mem", label: t("service.usage.memory"), values: points.map((x) => x.memoryBytes), color: "var(--chart-5)" },
                ]}
                formatValue={(v) => formatBytes(v)}
              />
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function DomainsPanel({ service }: { service: ServiceDetail }) {
  const list = useOp(domains.list, { serviceId: service.id }, { retry: retryOp });
  const rows = list.data?.domains.slice(0, 4) ?? [];
  const [adding, setAdding] = useState(false);
  // Mounted once first opened (and kept, so it can close with its animation): the Overview pays nothing for it before.
  const [dialogUsed, setDialogUsed] = useState(false);
  return (
    <Panel
      title={t("service.tabs.domains")}
      action={
        <button
          type="button"
          onClick={() => {
            setDialogUsed(true);
            setAdding(true);
          }}
          aria-label={t("serviceDomains.add")}
          title={t("serviceDomains.add")}
          className="flex size-7 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent p-0 text-ink-faint transition-colors duration-200 hover:bg-muted hover:text-foreground"
        >
          <IconPlus size={15} stroke={2} aria-hidden="true" />
        </button>
      }
    >
      {dialogUsed && (
        <AddDomainDialog
          service={service}
          open={adding}
          onOpenChange={setAdding}
          // The panel makes the first routed domain primary: the same rule as the Domains tab.
          becomesPrimary={list.data !== undefined && !list.data.domains.some((d) => d.primary)}
        />
      )}
      {list.isError ? (
        <OpErrorNote error={list.error} compact />
      ) : list.isPending ? (
        <DomainRowsSkeleton />
      ) : rows.length === 0 ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">{t("serviceDomains.empty")}</p>
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
              {/* No route on the node (not deployed yet, or the node's error): the Domains tab says why. */}
              {d.noRoute ? (
                <NoRouteChip noRoute={d.noRoute} />
              ) : /* The origin check found another server answering (the Domains tab says what to fix). */
              !d.auto && !d.forward && d.origin === "elsewhere" && (d.dnsStatus === "ok" || d.dnsStatus === "proxied") ? (
                <Chip
                  tone="amber"
                  title={t(d.dnsStatus === "proxied" ? "serviceDomains.originElsewhereProxiedHint" : "serviceDomains.originElsewhereHint", {
                    host: d.host,
                    ip: d.pointsTo?.[0] ?? t("serviceDomains.theNode"),
                  })}
                >
                  {t("serviceDomains.originElsewhereShort")}
                </Chip>
              ) : d.dnsStatus === "ok" || d.auto || d.forward ? null : (
                // Behind Cloudflare's proxy is how it is set up, not a problem: gray, not amber.
                <Chip tone={d.dnsStatus === "proxied" ? "gray" : "amber"}>{t(`serviceDomains.dns.${d.dnsStatus}`)}</Chip>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Domain rows while domains.list loads: the lock or globe, and the host. */
function DomainRowsSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="flex flex-col gap-2">
      {["w-44", "w-36"].map((width) => (
        <span key={width} className="flex items-center gap-2 text-[12.5px]">
          <Skeleton className="size-[13px] shrink-0 rounded-full" />
          <SkeletonText className={`${width} font-mono`} />
        </span>
      ))}
    </LoadingRegion>
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
            <ServiceStatusChip status={m.status} buildWaiting={m.buildWaiting} />
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
              {
                key: "cmd",
                label: t("serviceCron.command"),
                value: c.command.join(" ") ? (
                  <CopyCode code={c.command.join(" ")} aria-label={t("serviceCron.command")} />
                ) : (
                  t("serviceOverview.imageDefault")
                ),
              },
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

/** The Box card. Open editor is the header's button, so the card has none of its own. */
function BoxOverview({ service }: { service: ServiceDetail }) {
  const box = useOp(boxes.get, { serviceId: service.id }, { retry: retryOp, refetchInterval: 15_000 });
  if (box.isPending)
    return (
      <LoadingRegion label={t("common.loading")}>
        <Card>
          <div className="flex items-center gap-2">
            <SkeletonText className="w-24 text-[15px]" />
          </div>
          <SkeletonText className="w-96 max-w-full text-[13px]" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-6 gap-y-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-1">
                <SkeletonText className="w-14 text-[12px]" />
                <SkeletonText className="w-24 text-[13.5px]" />
              </div>
            ))}
          </div>
        </Card>
      </LoadingRegion>
    );
  if (box.isError) return <OpErrorNote error={box.error} />;
  const b = box.data;
  const tone = b.state === "running" ? "green" : b.state === "starting" ? "amber" : "gray";
  return (
    <Panel title={t("serviceOverview.box.title")}>
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

/** The app overview's two columns while the service loads: console and deploys on the left, facts, domains and usage on the right. */
export function OverviewSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <TerminalSkeleton height={consoleCardHeight} inRegion />
        <Card>
          <SkeletonText className="w-20 text-[15px]" />
          <div className="flex items-center gap-2">
            <SkeletonText className="w-44 text-[13.5px]" />
            <Skeleton className="h-[22px] w-14 rounded-chip" />
            <SkeletonText className="ml-auto w-16 text-xs" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["w-16", "w-28", "w-28", "w-24", "w-[104px]"].map((width, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
              <Skeleton key={i} className={`h-[22px] rounded-chip ${width}`} />
            ))}
          </div>
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <SkeletonText className="w-16 text-[15px]" />
          <div className="flex flex-col">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex min-h-10 items-center gap-4 border-t border-divider py-2 first:border-t-0">
                <SkeletonText className="w-28 shrink-0 text-[13px] sm:w-36" />
                <SkeletonText className="w-28 text-[13.5px]" />
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <SkeletonText className="w-20 text-[15px]" />
          {[0, 1, 2].map((i) => (
            <SkeletonText key={i} className="w-44 text-[12.5px]" />
          ))}
        </Card>
        <Card>
          <SkeletonText className="w-20 text-[15px]" />
          <div className="@container">
            <div className="grid gap-4 @md:grid-cols-2">
              <Skeleton className="h-[106px]" />
              <Skeleton className="h-[106px]" />
            </div>
          </div>
        </Card>
      </div>
    </LoadingRegion>
  );
}
