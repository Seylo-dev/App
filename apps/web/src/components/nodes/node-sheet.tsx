// One node in a side sheet, opened from the Nodes table (?node=<id>&view=).
// Five views:
//   overview  machine facts, usage graphs, services placed here, and the
//             machine actions: update the agent, update Docker, reboot,
//             agent logs
//   health    the node health checks (the heart icon) with fix hints
//   cleanup   the cleanup the node runs by itself and its recent cleanups
//   shell     a root shell on the node itself (off until the owner allows it)
//   settings  name, location, tags, wildcard domain, builds, games-first
//             CPU (only next to Wings), log retention, remove the node

import { nodes, updates } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { KeyValue } from "@seylo/ui/components/key-value";
import { EnterOnChange } from "@seylo/ui/components/motion";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { IconFileText, IconPower, IconSparkles } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { formatAgo, formatBytes } from "../../lib/format";
import { useLiveTopic } from "../../lib/live";
import type { NodeDetail } from "../../lib/types";
import { QueryError } from "../query-error";
import { AgentLogsDialog } from "./agent-logs";
import { DockerUpdateButton, DockerVersion } from "./docker-version";
import { NodeCleanup } from "./node-cleanup";
import { NodeGraphs } from "./node-graphs";
import { NodeHealth } from "./node-health";
import { NodeSettingsForm } from "./node-settings";
import { NodeShell, ShellSkeleton } from "./node-shell";

export type NodeView = "overview" | "health" | "cleanup" | "shell" | "settings";

export function NodeSheet({
  nodeId,
  view,
  onViewChange,
  onClose,
}: {
  nodeId: string | null;
  view: NodeView;
  onViewChange: (view: NodeView) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={nodeId !== null} onOpenChange={(open) => !open && onClose()}>
      {/*
        Opening the sheet focuses the sheet itself, not its first view option: Radix's default put
        the 2px keyboard ring on "Overview" whenever the sheet opened from a link. Tab still reaches
        the views first.
      */}
      <SheetContent className="max-w-[640px]" onOpenAutoFocus={focusSheet}>
        {nodeId && <NodeSheetBody nodeId={nodeId} view={view} onViewChange={onViewChange} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

/** Sends the opening focus to the sheet's own box (Radix makes it focusable) instead of its first control. */
function focusSheet(e: Event) {
  e.preventDefault();
  (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
}

function NodeSheetBody({
  nodeId,
  view,
  onViewChange,
  onClose,
}: {
  nodeId: string;
  view: NodeView;
  onViewChange: (view: NodeView) => void;
  onClose: () => void;
}) {
  const node = useOp(nodes.get, { nodeId });
  useLiveTopic(`node:${nodeId}`);

  return (
    <>
      {/* pr-5, not the header's pr-14: the views track may run under the close button; the title and description keep clear of it. */}
      <SheetHeader className="pr-5">
        <SheetTitle className="flex items-center gap-2 pr-9">
          {node.data && <StatusDot status={node.data.status === "online" ? "ok" : node.data.status === "offline" ? "error" : "off"} />}
          {node.data?.name ?? (
            <>
              <span className="sr-only">{t("common.loading")}</span>
              <SkeletonText className="w-28" />
            </>
          )}
        </SheetTitle>
        <SheetDescription className="pr-9">
          {node.data ? (
            [t(`nodes.status.${node.data.status}`), node.data.location].filter(Boolean).join(t("format.separator"))
          ) : (
            <SkeletonText className="w-44" />
          )}
        </SheetDescription>
        <Segmented
          aria-label={t("nodes.sheet.views")}
          value={view}
          onValueChange={(v) => onViewChange(v as NodeView)}
          // Five views: the track may run under the close button (the header keeps room for it beside
          // the title only). On a phone it scrolls inside the header with the current view in sight
          // (Segmented does both), with slimmer items so at 390px all five fit.
          className="mt-2 max-w-full self-start"
        >
          <SegmentedItem value="overview" className="shrink-0 max-sm:px-2">
            {t("nodes.sheet.overview")}
          </SegmentedItem>
          <SegmentedItem value="health" className="shrink-0 max-sm:px-2">
            {t("nodes.health")}
          </SegmentedItem>
          <SegmentedItem value="cleanup" className="shrink-0 max-sm:px-2">
            {t("nodeCleanup.tab")}
          </SegmentedItem>
          <SegmentedItem value="shell" className="shrink-0 max-sm:px-2">
            {t("nodeShell.tab")}
          </SegmentedItem>
          <SegmentedItem value="settings" className="shrink-0 max-sm:px-2">
            {t("nodes.settings")}
          </SegmentedItem>
        </Segmented>
      </SheetHeader>
      <SheetBody className="pb-6">
        {/* A view fades in when you switch views, like a tab's screen. */}
        <EnterOnChange motionKey={view} subtle className="flex flex-col gap-4">
          {node.isError ? (
            <QueryError error={node.error} onRetry={() => void node.refetch()} />
          ) : node.isPending ? (
            // The health checks and the cleanup only need the node's id; the other views wait for the node.
            view === "health" ? (
              <NodeHealth nodeId={nodeId} />
            ) : view === "cleanup" ? (
              <NodeCleanup nodeId={nodeId} />
            ) : view === "shell" ? (
              <ShellSkeleton />
            ) : (
              <LoadingRegion label={t("common.loading")} className="flex flex-col gap-4">
                {view === "overview" ? <OverviewSkeleton /> : <SettingsSkeleton />}
              </LoadingRegion>
            )
          ) : view === "overview" ? (
            <Overview node={node.data} onClose={onClose} />
          ) : view === "health" ? (
            <NodeHealth nodeId={nodeId} />
          ) : view === "cleanup" ? (
            <NodeCleanup nodeId={nodeId} />
          ) : view === "shell" ? (
            <NodeShell node={node.data} />
          ) : (
            <NodeSettingsForm key={node.data.updatedAt} node={node.data} onRemoved={onClose} />
          )}
        </EnterOnChange>
      </SheetBody>
    </>
  );
}

function Overview({ node, onClose }: { node: NodeDetail; onClose: () => void }) {
  const [confirm, setConfirm] = useState<"reboot" | "docker" | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const failed = (error: unknown) => toast.error(errorMessage(error, t("common.unknownError")));
  const reboot = useOpMutation(nodes.reboot);
  const updateAgent = useOpMutation(updates.updateNode, { onSuccess: () => toast.info(t("nodes.updateStarted")), onError: failed });
  const dockerCheck = useOpMutation(nodes.updateDocker, { onError: failed });
  const dockerUpdate = useOpMutation(nodes.updateDocker);
  const facts = node.facts;
  // Where the agent connects (it moves to the panel domain once that is live).
  const panelAddress = node.panelAddress;
  const online = node.status === "online";

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!online || !node.updateAvailable || updateAgent.isPending}
          onClick={() => updateAgent.mutate({ nodeId: node.id })}
        >
          <IconSparkles size={15} aria-hidden="true" />
          {node.updateAvailable ? t("nodes.updateNow") : t("nodes.agentUpToDate")}
        </Button>
        <DockerUpdateButton
          node={node}
          pending={dockerCheck.isPending}
          onClick={() => dockerCheck.mutate({ nodeId: node.id, dryRun: true }, { onSuccess: () => setConfirm("docker") })}
        />
        <Button size="sm" disabled={!online} onClick={() => setConfirm("reboot")}>
          <IconPower size={15} aria-hidden="true" />
          {t("nodes.reboot")}
        </Button>
        <Button size="sm" onClick={() => setLogsOpen(true)}>
          <IconFileText size={15} aria-hidden="true" />
          {t("nodes.agentLogs")}
        </Button>
      </div>

      <NodeGraphs nodeId={node.id} />

      <section aria-label={t("nodes.sheet.machine")} className="flex flex-col gap-3">
        <h3 className="m-0 text-sm font-semibold">{t("nodes.sheet.machine")}</h3>
        {facts ? (
          <KeyValue
            layout="grid"
            items={[
              { label: t("nodes.facts.hostname"), value: facts.hostname, mono: true },
              { label: t("nodes.facts.os"), value: facts.os },
              { label: t("nodes.facts.kernel"), value: facts.kernel, mono: true },
              { label: t("nodes.facts.cpu"), value: t("nodes.facts.cores", { count: facts.cpuCores, arch: facts.arch }) },
              { label: t("nodes.facts.memory"), value: formatBytes(facts.memoryTotalBytes) },
              {
                label: t("nodes.facts.disk"),
                value: t("nodes.facts.diskFree", { free: formatBytes(facts.diskFreeBytes), total: formatBytes(facts.diskTotalBytes) }),
              },
              {
                key: "docker",
                label: t("nodes.facts.docker"),
                value: <DockerVersion version={facts.dockerVersion} docker={node.docker} />,
                mono: true,
              },
              { label: t("nodes.facts.cgroup"), value: `v${facts.cgroupVersion}` },
              // "v0.9.4", as the node list and the sidebar write it.
              { label: t("nodes.facts.agent"), value: node.agentVersion ? `v${node.agentVersion.replace(/^v/, "")}` : "-", mono: true },
              ...(panelAddress ? [{ label: t("nodes.facts.panelAddress"), value: panelAddress, mono: true }] : []),
              { label: t("nodes.facts.booted"), value: facts.bootTime ? formatAgo(facts.bootTime) : "-" },
              { label: t("nodes.facts.lastSeen"), value: node.lastSeenAt ? formatAgo(node.lastSeenAt) : "-" },
              {
                label: t("nodes.facts.revision"),
                value: t("nodes.facts.revisionValue", { applied: node.appliedRevision ?? "-", desired: node.desiredRevision }),
              },
            ]}
          />
        ) : (
          <p className="m-0 text-[13px] text-muted-foreground">{t("nodes.sheet.noFacts")}</p>
        )}
      </section>

      <section aria-label={t("nodes.sheet.services")} className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold">{t("nodes.sheet.services")}</h3>
        {node.services.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">{t("nodes.sheet.noServices")}</p>}
        <ul className="m-0 flex list-none flex-col p-0">
          {node.services.map((service) => (
            <li key={service.serviceId} className="flex items-center gap-2 border-t border-divider py-2 text-[13px]">
              <Link
                to="/p/$projectId/s/$serviceId"
                params={{ projectId: service.projectId, serviceId: service.serviceId }}
                onClick={onClose}
                className="font-medium"
              >
                {service.serviceName}
              </Link>
              <span className="text-muted-foreground">{service.projectName}</span>
              <Chip tone={phaseTone(service.phase)} className="ml-auto">
                {t(`nodes.phase.${service.phase}`)}
              </Chip>
              {service.replicas > 1 && <span className="text-xs text-muted-foreground">×{service.replicas}</span>}
            </li>
          ))}
        </ul>
      </section>

      {node.capabilities.length > 0 && (
        <section aria-label={t("nodes.sheet.capabilities")} className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">{t("nodes.sheet.capabilities")}</h3>
          <div className="flex flex-wrap gap-1.5">
            {node.capabilities.map((capability) => (
              <Chip key={capability} tone="track" mono className="text-[11px]">
                {capability}
              </Chip>
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirm === "reboot"}
        onOpenChange={(open) => !open && setConfirm(null)}
        destructive
        title={t("nodes.rebootTitle", { name: node.name })}
        description={t("nodes.rebootHint", { count: node.services.length })}
        confirmText={node.name}
        confirmLabel={t("nodes.reboot")}
        onConfirm={async () => {
          await reboot.mutateAsync({ nodeId: node.id, confirmName: node.name });
          toast.info(t("nodes.rebooting", { name: node.name }));
        }}
      />
      <ConfirmDialog
        open={confirm === "docker"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("nodes.dockerTitle")}
        description={
          dockerCheck.data
            ? [
                dockerCheck.data.fromVersion === dockerCheck.data.toVersion
                  ? t("nodes.dockerCurrent", { version: dockerCheck.data.fromVersion })
                  : t("nodes.dockerHint", { from: dockerCheck.data.fromVersion, to: dockerCheck.data.toVersion }),
                // The agent warns when Docker's live-restore is off: every service stops while Docker restarts.
                dockerCheck.data.warning ? t("nodes.dockerWarning", { warning: dockerCheck.data.warning }) : "",
              ]
                .filter(Boolean)
                .join(" ")
            : ""
        }
        confirmLabel={t("nodes.updateDocker")}
        onConfirm={async () => {
          await dockerUpdate.mutateAsync({ nodeId: node.id });
          toast.info(t("nodes.dockerStarted", { name: node.name }));
        }}
      />
      <AgentLogsDialog node={node} open={logsOpen} onOpenChange={setLogsOpen} />
    </>
  );
}

/** The overview's layout while the node loads: actions, graphs, machine facts, services. */
function OverviewSkeleton() {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {["w-[132px]", "w-[136px]", "w-[84px]", "w-[112px]"].map((width) => (
          <Skeleton key={width} className={`h-8 ${width}`} />
        ))}
      </div>
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="m-0 text-sm font-semibold">{t("nodes.sheet.usage")}</h3>
          <Skeleton className="ml-auto h-8 w-[220px]" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[t("dashboard.cpu"), t("dashboard.memory"), t("nodes.disk"), t("dashboard.network")].map((title) => (
            <div key={title} className="flex min-w-0 flex-col gap-1.5 rounded-control bg-raised p-3">
              <span className="text-xs font-medium text-ink-strong">{title}</span>
              <Skeleton className="h-20 bg-track" />
            </div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-sm font-semibold">{t("nodes.sheet.machine")}</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-6 gap-y-4">
          {Array.from({ length: 12 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
            <div key={i} className="flex min-w-0 flex-col gap-1">
              <SkeletonText className="w-14 text-[12px]" />
              <SkeletonText className="w-24 text-[13.5px]" />
            </div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold">{t("nodes.sheet.services")}</h3>
        <div className="flex flex-col">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2 border-t border-divider py-2 text-[13px]">
              <SkeletonText className="w-16" />
              <SkeletonText className="w-20" />
              <Skeleton className="ml-auto h-[22px] w-16 rounded-chip" />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** The settings form's fields while the node loads. */
function SettingsSkeleton() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <SkeletonText className="w-28 text-[12.5px]" />
          <Skeleton className="h-[38px]" />
          <SkeletonText className="w-56 text-xs" />
        </div>
      ))}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <SkeletonText className="w-24 text-[12.5px]" />
            <Skeleton className="h-[38px]" />
          </div>
        ))}
      </div>
    </>
  );
}

function phaseTone(phase: NodeDetail["services"][number]["phase"]) {
  if (phase === "running") return "green" as const;
  if (phase === "failed" || phase === "crashLooping") return "red" as const;
  if (phase === "stopped" || phase === "sleeping" || phase === "unknown") return "gray" as const;
  return "amber" as const;
}
