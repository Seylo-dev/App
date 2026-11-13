// Full logs of one deployment in a modal (Deployments.dc.html): title with
// commit, status and who/when, the five step cards, the whole log in a
// virtualized LogViewer, and Copy / Download / Close. Up to 1280px wide, so
// build output lines fit; on a phone it takes the screen less 16px a side
// and the step cards wrap. A failed deploy shows its error, Use port when
// the app listened on another port, and the new container's last output
// collapsed under it (deploy-failure.tsx), apart from the step log.

import { deployments } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { useCopy } from "@seylo/ui/components/copy-field";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { LogViewer, useLogBuffer } from "@seylo/ui/components/log-viewer";
import { IconCopy, IconDownload, IconX } from "@tabler/icons-react";
import { t } from "../../i18n/t";
import { useLiveUp } from "../../lib/live";
import { LastOutput, UsePortButtons, usePortChoices } from "./deploy-failure";
import { bufferText, downloadText, useDeploymentLog } from "./deploy-log";
import { type Deployment, StepCards } from "./deploy-steps";
import { deploymentDurationMs, deploymentTitle, deploymentVersion, healthFailed, type TitleSource, triggerLabel } from "./deployment-meta";
import { formatDuration, formatRelative, formatTimeOfDay } from "./format";
import { OpErrorNote, retryOp } from "./op-state";
import { isActiveDeployment } from "./status";
import { DeploymentStatusChip } from "./status-chip";
import { useNow } from "./use-now";

export function DeployLogModal({
  serviceId,
  source,
  deployment,
  onClose,
}: {
  serviceId: string;
  /** The service's source, for the title of a deploy without a commit (deploymentTitle: only an inline Dockerfile's label names one). */
  source?: TitleSource;
  deployment: Deployment | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={deployment !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="top-[84px] flex max-h-[calc(100dvh-108px)] max-w-[min(1280px,calc(100vw-32px))] flex-col overflow-hidden p-0">
        {deployment && <ModalBody serviceId={serviceId} source={source} initial={deployment} />}
      </DialogContent>
    </Dialog>
  );
}

function ModalBody({ serviceId, source, initial }: { serviceId: string; source?: TitleSource; initial: Deployment }) {
  const now = useNow(isActiveDeployment(initial.status) ? 1000 : 0);
  // deployment:<id> and service:<id> invalidate this while it runs; poll fast only while the socket is down.
  const liveUp = useLiveUp();
  const live = useOp(
    deployments.get,
    { serviceId, deploymentId: initial.id },
    {
      retry: retryOp,
      refetchInterval: (q) => (q.state.data && !isActiveDeployment(q.state.data.deployment.status) ? false : liveUp ? 10_000 : 2000),
    },
  );
  const d = live.data?.deployment ?? initial;
  const buffer = useLogBuffer(100_000);
  const log = useDeploymentLog(serviceId, d.id, buffer);
  const [copied, copy] = useCopy();
  const version = deploymentVersion(d);
  const took = deploymentDurationMs(d, now);
  const failed = d.status === "failed";

  const meta = [
    d.actor ? t("serviceDeploys.chips.triggerBy", { trigger: triggerLabel(d.trigger), actor: d.actor }) : triggerLabel(d.trigger),
    formatRelative(d.createdAt, now),
    took != null ? t("serviceDeploys.modal.took", { duration: formatDuration(took) }) : null,
  ].filter(Boolean);

  const foot = failed
    ? d.live
      ? null
      : t("serviceDeploys.modal.previousStayed")
    : d.builtOn
      ? t("serviceDeploys.modal.builtShipped", { built: d.builtOn.name, shipped: d.shippedTo.map((n) => n.name).join(", ") || "-" })
      : d.shippedTo.length
        ? t("serviceDeploys.modal.shipped", { shipped: d.shippedTo.map((n) => n.name).join(", ") })
        : null;

  return (
    <>
      {/* Everything above the buttons scrolls when the screen is short (a phone stacks the step cards), so Copy, Download and Close stay in reach. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex items-start gap-3 px-5 pt-[18px] pb-3.5">
          <div className="flex min-w-0 flex-col gap-[7px]">
            <DialogTitle className="text-base leading-[1.35] tracking-[-0.01em]">
              {version ? (
                <>
                  {t("serviceDeploys.modal.deploy")} <span className="font-mono text-[14.5px] font-medium">{version}</span> ·{" "}
                </>
              ) : null}
              {deploymentTitle(d, source)}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                {healthFailed(d) ? (
                  <span className="rounded-chip bg-chip-red-bg px-[7px] py-0.5 text-[11.5px] font-medium text-chip-red-fg">
                    {t("serviceDeploys.healthFailed")}
                  </span>
                ) : (
                  <DeploymentStatusChip status={d.status} buildWaiting={d.buildWait != null} />
                )}
                <span>{meta.join(" · ")}</span>
              </div>
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              size="icon"
              variant="secondary"
              className="ml-auto size-8 rounded-control bg-muted shadow-none"
              aria-label={t("serviceDeploys.modal.closeLogs")}
            >
              <IconX size={14} stroke={2.2} />
            </Button>
          </DialogClose>
        </div>
        <div className="px-5 pb-4">
          <StepCards steps={d.steps} buildWait={d.buildWait} />
        </div>
        {d.error && <p className="m-0 px-5 pb-3 text-[12.5px] leading-[1.45] text-chip-red-fg">{d.error}</p>}
        {usePortChoices(d).length > 0 && (
          <div className="px-5 pb-3">
            <UsePortButtons serviceId={serviceId} d={d} />
          </div>
        )}
        {d.lastOutput && <LastOutput d={d} className="mx-5 mb-3" />}
        <div className="shrink-0 px-5">
          {log.error && log.lines === 0 ? (
            <OpErrorNote error={log.error} />
          ) : (
            <LogViewer
              buffer={buffer}
              aria-label={t("serviceDeploys.modal.deployLog")}
              title={
                <span className="flex items-center gap-2.5">
                  {t("serviceDeploys.modal.deployLog")}
                  {version && <span className="font-mono text-xs font-normal text-terminal-muted">{version}</span>}
                </span>
              }
              actions={
                <span className="text-xs text-terminal-muted">
                  {t("serviceDeploys.modal.summary", { count: log.lines, duration: took != null ? formatDuration(took) : "-" })}
                </span>
              }
              showTimestamps
              showSource
              formatTime={(ts) => formatTimeOfDay(ts)}
              height="min(360px, 50dvh)"
              empty={
                <span className="text-terminal-muted">
                  {log.done ? t("serviceDeploys.modal.emptyLog") : t("serviceDeploys.modal.waiting")}
                </span>
              }
            />
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-4 pb-[18px]">
        {foot && <span className="text-[12.5px] text-muted-foreground">{foot}</span>}
        <span className="ml-auto flex flex-wrap gap-2">
          <Button className="h-9 bg-muted shadow-none" onClick={() => void copy(bufferText(buffer))} disabled={log.lines === 0}>
            <IconCopy size={14} stroke={1.9} />
            {copied ? t("service.copied") : t("service.copy")}
          </Button>
          <Button
            className="h-9 bg-muted shadow-none"
            onClick={() => downloadText(`deploy-${version || d.id}.log`, bufferText(buffer))}
            disabled={log.lines === 0}
          >
            <IconDownload size={14} stroke={1.9} />
            {t("service.download")}
          </Button>
          <DialogClose asChild>
            <Button variant="primary" className="h-9">
              {t("service.close")}
            </Button>
          </DialogClose>
        </span>
      </div>
    </>
  );
}
