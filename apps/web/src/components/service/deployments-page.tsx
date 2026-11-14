// The Deployments tab (Deployments.dc.html): how this service is built and
// shipped, the history with step chips, rollback and redeploy, the running
// deploy's log on the side, and full logs in a modal. A row's "..." and its
// right-click menu are one list (menus/row-items.tsx).

import { builds, deployments, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { LogViewer, useLogBuffer } from "@seylo/ui/components/log-viewer";
import { ActionsMenu } from "@seylo/ui/components/menu-items";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import {
  type Icon,
  IconArrowBackUp,
  IconDots,
  IconGitBranch,
  IconLoader2,
  IconPackage,
  IconRefresh,
  IconServer2,
  IconShieldCheck,
  IconTerminal2,
} from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { useLiveUp } from "../../lib/live";
import { deploysOnPush } from "../../lib/service-display";
import { DeployHostAction } from "../git/internal-hosts";
import { useObjectActions } from "../menus/object-actions";
import { type DeploymentAction, deploymentMenuEntries } from "../menus/row-items";
import { copyWithToast, RowMenu } from "../menus/row-menu";
import { useActiveDeploy } from "./active-deploy";
import { buildNodeText } from "./build-node";
import { movingOf } from "./cancel-move-dialog";
import { firstTcpPort, LastOutput, UsePortButtons } from "./deploy-failure";
import { useDeploymentLog } from "./deploy-log";
import { DeployLogModal } from "./deploy-log-modal";
import { deployListRefresh } from "./deploy-refresh";
import { type Deployment, StepChips } from "./deploy-steps";
import { DeploymentChips, deploymentDurationMs, deploymentTitle, deploymentVersion, healthFailed, runningClockMs } from "./deployment-meta";
import { formatClock, formatRelative, formatTimeOfDay } from "./format";
import { useInvalidate } from "./invalidate";
import { isNotBuilt, OpErrorNote, retryOp } from "./op-state";
import { CloneNetworkHint, PrivateRepoHint } from "./private-repo-hint";
import { deploymentLook, isActiveDeployment } from "./status";
import { DeploymentStatusChip } from "./status-chip";
import { deploymentsPageSize } from "./tab-prefetch";
import { useServerNow } from "./use-now";
import type { ServiceDetail } from "./use-service";

const pageSize = deploymentsPageSize;

export function DeploymentsPage({ service }: { service: ServiceDetail }) {
  const [pages, setPages] = useState<string[]>([]);
  const liveUp = useLiveUp();
  const first = useOp(
    deployments.list,
    { serviceId: service.id, limit: pageSize },
    // service:<id> invalidates this list when a deployment moves; it also polls while one moves (fast while the
    // socket is down) and refetches when the tab is shown again (deploy-refresh.ts).
    { retry: retryOp, ...deployListRefresh(liveUp) },
  );
  const [open, setOpen] = useState<Deployment | null>(null);
  const rows = first.data?.deployments ?? [];
  const active = rows.find((d) => isActiveDeployment(d.status)) ?? null;
  const side = active ?? rows[0] ?? null;

  return (
    <>
      <BuildFacts service={service} />
      <div className="flex flex-wrap items-start gap-4">
        <Card aria-label={t("serviceDeploys.history")} className="min-w-0 flex-[1_1_560px] gap-0 overflow-hidden p-0">
          <div className="flex flex-wrap items-center gap-2.5 px-5 pt-4 pb-3.5">
            <h2 className="m-0 text-[15px] font-semibold">{t("serviceDeploys.history")}</h2>
            {first.data && first.data.keptImages > 0 && (
              <span className="ml-auto text-[12.5px] text-muted-foreground">
                {t("serviceDeploys.keptImages", { count: first.data.keptImages })}
              </span>
            )}
          </div>
          {first.isPending ? (
            <LoadingRegion label={t("common.loading")}>
              {[0, 1, 2, 3].map((i) => (
                <DeploymentRowSkeleton key={i} />
              ))}
            </LoadingRegion>
          ) : first.isError ? (
            <div className="border-t border-divider px-5 py-4">
              <OpErrorNote error={first.error} />
            </div>
          ) : rows.length === 0 ? (
            <div className="border-t border-divider">
              <EmptyState compact title={t("serviceDeploys.empty")} description={t("serviceDeploys.emptyHint")} />
            </div>
          ) : (
            <>
              {rows.map((d) => (
                <DeploymentRow key={d.id} service={service} d={d} onLogs={() => setOpen(d)} />
              ))}
              {pages.map((cursor) => (
                <OlderPage key={cursor} service={service} cursor={cursor} onLogs={setOpen} />
              ))}
              <LoadMore
                service={service}
                cursor={pages.length ? null : first.data.nextCursor}
                pages={pages}
                onMore={(c) => setPages((p) => [...p, c])}
              />
            </>
          )}
        </Card>
        {side && <SideLog service={service} d={side} />}
        {first.isPending && <Skeleton className="min-w-0 flex-[1_1_440px] self-stretch rounded-card bg-terminal" />}
      </div>
      <DeployLogModal
        serviceId={service.id}
        source={service.source}
        servicePort={firstTcpPort(service)}
        deployment={open}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

/** DeploymentRow's layout while the history loads: the status circle, title line, chips and the row buttons. */
function DeploymentRowSkeleton() {
  return (
    <div className="flex items-start gap-3 border-t border-divider px-5 py-3.5">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-[7px]">
        <div className="flex min-h-[22px] items-center gap-2">
          <SkeletonText className="w-48 text-[13.5px]" />
          <SkeletonText className="w-14 text-xs" />
          <SkeletonText className="ml-auto w-16 text-xs" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {["w-28", "w-24", "w-[92px]", "w-14"].map((width) => (
            <Skeleton key={width} className={`h-[22px] rounded-chip ${width}`} />
          ))}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 gap-1.5">
        <Skeleton className="h-8 w-[70px]" />
        <Skeleton className="h-8 w-[92px]" />
        <Skeleton className="size-8" />
      </div>
    </div>
  );
}

/** One page of older deployments, loaded with the cursor of the page before. */
function OlderPage({ service, cursor, onLogs }: { service: ServiceDetail; cursor: string; onLogs: (d: Deployment) => void }) {
  const page = useOp(deployments.list, { serviceId: service.id, limit: pageSize, cursor }, { retry: retryOp });
  if (page.isPending)
    return (
      <LoadingRegion label={t("common.loading")}>
        {[0, 1, 2].map((i) => (
          <DeploymentRowSkeleton key={i} />
        ))}
      </LoadingRegion>
    );
  if (page.isError) return <OpErrorNote error={page.error} className="mx-5 my-3" />;
  return (
    <>
      {page.data.deployments.map((d) => (
        <DeploymentRow key={d.id} service={service} d={d} onLogs={() => onLogs(d)} />
      ))}
    </>
  );
}

function LoadMore({
  service,
  cursor,
  pages,
  onMore,
}: {
  service: ServiceDetail;
  cursor: string | null;
  pages: string[];
  onMore: (cursor: string) => void;
}) {
  // The cursor of the newest loaded page decides whether there is more.
  const last = pages[pages.length - 1];
  const lastPage = useOp(
    deployments.list,
    { serviceId: service.id, limit: pageSize, cursor: last ?? "" },
    { enabled: !!last, retry: retryOp },
  );
  const next = last ? (lastPage.data?.nextCursor ?? null) : cursor;
  if (!next) return null;
  return (
    <div className="flex justify-center border-t border-divider px-5 py-3">
      <Button size="sm" onClick={() => onMore(next)}>
        {t("serviceDeploys.loadMore")}
      </Button>
    </div>
  );
}

function DeploymentRow({ service, d, onLogs }: { service: ServiceDetail; d: Deployment; onLogs: () => void }) {
  // The panel's time: the row's clock counts from the panel's startedAt, whatever this computer's clock says.
  const now = useServerNow(isActiveDeployment(d.status) ? 1000 : 30_000);
  const clock = runningClockMs(d, now);
  const invalidate = useInvalidate();
  const objects = useObjectActions();
  const [confirmRollback, setConfirmRollback] = useState(false);
  const fail = (error: unknown) =>
    toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));
  const done = () => invalidate(deployments.list, services.get);
  const rollback = useOpMutation(deployments.rollback, {
    onSuccess: () => {
      done();
      toast.success(t("serviceDeploys.rollbackStarted"));
    },
    onError: fail,
  });
  const redeploy = useOpMutation(deployments.deploy, {
    onSuccess: () => {
      done();
      toast.success(t("service.header.deployStarted"));
    },
    onError: fail,
  });
  const cancel = useOpMutation(deployments.cancel, { onSuccess: done, onError: fail });
  const running = isActiveDeployment(d.status);
  // One deploy at a time: while one is in progress, Roll back and the Redeploy items wait for it.
  const busy = useActiveDeploy(service.id) !== null;
  const failed = d.status === "failed";
  const version = deploymentVersion(d);
  const act = (action: DeploymentAction) => {
    switch (action) {
      case "viewLog":
        return onLogs();
      case "redeployCommit":
        return redeploy.mutate({ serviceId: service.id, commitSha: d.commit?.sha });
      case "redeployNoCache":
        return redeploy.mutate({ serviceId: service.id, noCache: true });
      case "rollback":
        return setConfirmRollback(true);
      case "cancel":
        return cancel.mutate({ serviceId: service.id, deploymentId: d.id });
      case "cancelMove": {
        const moving = movingOf(d);
        return moving ? objects.openDialog({ kind: "move-cancel", service, deployment: moving }) : undefined;
      }
      case "copyCommit":
        return void copyWithToast(d.commit?.sha ?? "");
      case "copyId":
        return void copyWithToast(d.id);
    }
  };
  const menu = deploymentMenuEntries(
    { id: d.id, commit: d.commit, canRollback: d.canRollback, running, move: d.move && { canCancel: d.move.canCancel } },
    { busy, act },
  );

  return (
    <>
      <RowMenu entries={menu} aria-label={t("menus.actionsFor", { name: version || deploymentTitle(d, service.source) })}>
        <div
          className={cn(
            "flex flex-wrap items-start gap-3 border-t border-divider px-5 py-3.5 transition-colors duration-200 data-[state=open]:bg-raised",
            running && "bg-chip-amber-bg/40",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              running ? "bg-chip-amber-bg" : failed ? "bg-chip-red-bg" : d.status === "cancelled" ? "bg-muted" : "bg-chip-green-bg",
            )}
          >
            {running ? (
              <IconLoader2 size={16} stroke={2.6} className="animate-spin text-status-busy" />
            ) : (
              <span
                className={cn(
                  "size-2 rounded-full",
                  failed ? "bg-status-error" : d.status === "cancelled" ? "bg-status-off" : "bg-status-ok",
                )}
              />
            )}
          </span>
          <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-[7px]">
            <div className="flex min-h-[22px] flex-wrap items-center gap-2">
              <b className="text-[13.5px] font-semibold">{deploymentTitle(d, service.source)}</b>
              {version && <span className="font-mono text-xs text-muted-foreground">{version}</span>}
              {d.live ? (
                <DeploymentStatusChip status="live" />
              ) : healthFailed(d) ? (
                <span className="rounded-chip bg-chip-red-bg px-[7px] py-0.5 text-[11.5px] font-medium text-chip-red-fg">
                  {t("serviceDeploys.healthFailed")}
                </span>
              ) : (
                d.status !== "superseded" && <DeploymentStatusChip status={d.status} buildWaiting={d.buildWait != null} />
              )}
              <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
                {clock !== null ? formatClock(clock) : formatRelative(d.createdAt, now)}
              </span>
            </div>
            {d.error && <span className="text-[12.5px] leading-[1.45] text-ink-strong">{d.error}</span>}
            {failed && <UsePortButtons serviceId={service.id} d={d} servicePort={firstTcpPort(service)} />}
            {failed && <LastOutput d={d} />}
            <PrivateRepoHint service={service} d={d} />
            <CloneNetworkHint d={d} />
            {failed && <DeployHostAction service={service} error={d.error} />}
            {running ? <StepChips steps={d.steps} buildWait={d.buildWait} /> : <DeploymentChips d={d} now={now} />}
          </div>
          <div className="ml-auto flex shrink-0 gap-1.5">
            <RowButton icon={IconTerminal2} onClick={onLogs} haspopup>
              {t("serviceDeploys.logs")}
            </RowButton>
            {d.canRollback && (
              <RowButton
                icon={IconArrowBackUp}
                onClick={() => setConfirmRollback(true)}
                disabled={rollback.isPending || busy}
                title={busy ? t("service.header.deployBusyHint") : undefined}
              >
                {t("serviceDeploys.rollback")}
              </RowButton>
            )}
            <ActionsMenu
              entries={menu}
              trigger={
                <Button size="icon" className="size-8 rounded-control bg-muted shadow-none" aria-label={t("serviceDeploys.more")}>
                  <IconDots size={15} />
                </Button>
              }
            />
          </div>
        </div>
      </RowMenu>
      <ConfirmDialog
        open={confirmRollback}
        onOpenChange={setConfirmRollback}
        title={t("serviceDeploys.rollbackTitle", { version: version || deploymentTitle(d, service.source) })}
        description={t("serviceDeploys.rollbackBody")}
        confirmLabel={t("serviceDeploys.rollback")}
        onConfirm={() => rollback.mutateAsync({ serviceId: service.id, deploymentId: d.id }).then(() => undefined)}
      />
    </>
  );
}

function RowButton({
  icon: Icon,
  children,
  onClick,
  disabled,
  haspopup,
  title,
}: {
  icon: Icon;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  haspopup?: boolean;
  /** Why it is disabled, when it is. */
  title?: string;
}) {
  return (
    <Button
      size="sm"
      className="h-8 bg-muted px-[11px] shadow-none hover:bg-track"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-haspopup={haspopup ? "dialog" : undefined}
    >
      <Icon size={13} stroke={2} />
      {children}
    </Button>
  );
}

/** The dark log panel next to the history: the running deploy, or the latest one. */
function SideLog({ service, d }: { service: ServiceDetail; d: Deployment }) {
  const buffer = useLogBuffer(100_000);
  const log = useDeploymentLog(service.id, d.id, buffer);
  const now = useServerNow(isActiveDeployment(d.status) ? 1000 : 0);
  const running = isActiveDeployment(d.status);
  const took = deploymentDurationMs(d, now);
  return (
    <section aria-label={t("serviceDeploys.buildLog")} className="min-w-0 flex-[1_1_440px]">
      {log.error && log.lines === 0 && !isNotBuilt(log.error) ? (
        <OpErrorNote error={log.error} />
      ) : (
        <LogViewer
          buffer={buffer}
          aria-label={t("serviceDeploys.buildLog")}
          title={
            <span className="flex items-center gap-2.5">
              {running ? t("serviceDeploys.buildLog") : t("serviceDeploys.modal.deployLog")}
              <span className="font-mono text-xs font-normal text-terminal-muted">{deploymentVersion(d)}</span>
            </span>
          }
          actions={
            running ? (
              <span className="flex items-center gap-1.5 rounded-chip bg-status-busy/12 px-2 py-0.5 text-xs font-medium text-ansi-yellow">
                <span className="size-1.5 animate-pulse rounded-full bg-status-busy" />
                {t(deploymentLook(d.status, d.buildWait != null).label)} · {formatClock(took ?? 0)}
              </span>
            ) : (
              <span className="text-xs text-terminal-muted">{t(`serviceDeploys.status.${d.status}`)}</span>
            )
          }
          showSource
          formatTime={(ts) => formatTimeOfDay(ts)}
          height={420}
          empty={
            <span className="text-terminal-muted">
              {isNotBuilt(log.error)
                ? t("service.notBuilt.title")
                : log.done
                  ? t("serviceDeploys.modal.emptyLog")
                  : t("serviceDeploys.modal.waiting")}
            </span>
          }
        />
      )}
    </section>
  );
}

/** The chips above the history: source, builder, push, strategy, build node. Read-only facts, so a plain fill, not the button look. */
function BuildFacts({ service }: { service: ServiceDetail }) {
  const settings = useOp(builds.getSettings, { serviceId: service.id }, { retry: retryOp });
  const src = service.sourceConfig;
  const facts: { icon: Icon; text: string }[] = [];
  if (service.source.type !== "none") {
    const where = [t(`serviceDeploys.source.${service.source.type}`), service.source.label, service.source.branch]
      .filter(Boolean)
      .join(" · ");
    facts.push({ icon: IconGitBranch, text: where });
  }
  if (service.source.builder)
    facts.push({
      icon: IconPackage,
      text: t("serviceDeploys.facts.builder", { builder: t(`serviceSource.builders.${service.source.builder}.name`) }),
    });
  const onPush = deploysOnPush(src);
  if (onPush !== null)
    facts.push({ icon: IconRefresh, text: onPush ? t("serviceDeploys.facts.pushOn") : t("serviceDeploys.facts.pushOff") });
  facts.push({
    icon: IconShieldCheck,
    text: service.deploy.mode === "rolling" ? t("serviceDeploys.facts.rolling") : t("serviceDeploys.facts.recreate"),
  });
  const buildsOn = buildNodeText(settings.data, service);
  if (buildsOn) facts.push({ icon: IconServer2, text: buildsOn });

  return (
    <div className="flex flex-wrap gap-2 text-[12.5px] text-ink-strong">
      {facts.map((f) => (
        <span key={f.text} className="flex items-center gap-[7px] rounded-control bg-track px-[11px] py-1.5">
          <f.icon size={13} stroke={2} className="text-muted-foreground" aria-hidden="true" />
          {f.text}
        </span>
      ))}
    </div>
  );
}
