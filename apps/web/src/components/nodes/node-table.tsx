// The node list (Nodes.dc.html): status, name, location and badges;
// addresses; CPU, memory and disk bars; agent version with "Update now";
// the can-build and games-first switches; Health and Settings. The live
// topic "panel" refreshes it when a node changes or reports usage.

import { nodes, updates } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { Tip } from "@seylo/ui/components/tooltip";
import { cn } from "@seylo/ui/lib/utils";
import { IconHeart, IconServer2 } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { formatPercent, formatUsedOfTotal } from "../../lib/format";
import type { NodeRow } from "../../lib/types";
import { QueryError } from "../query-error";
import type { NodeView } from "./node-sheet";

const statusRing: Record<NodeRow["status"], { ring: string; dot: string }> = {
  online: { ring: "bg-chip-green-bg", dot: "bg-status-ok" },
  offline: { ring: "bg-chip-red-bg", dot: "bg-status-error" },
  disabled: { ring: "bg-muted", dot: "bg-status-off" },
};

const healthTone = { pass: "text-status-ok", warn: "text-status-busy", fail: "text-status-error", skipped: "text-ink-faint" } as const;

export function NodeTable({ onOpen }: { onOpen: (nodeId: string, view: NodeView) => void }) {
  const list = useOp(nodes.list, {});
  const failed = (error: unknown) => toast.error(errorMessage(error, t("common.unknownError")));
  const setCanBuild = useOpMutation(nodes.setCanBuild, { onSuccess: () => void list.refetch(), onError: failed });
  const setGamesFirst = useOpMutation(nodes.setGamesFirstCpu, { onSuccess: () => void list.refetch(), onError: failed });
  const updateNode = useOpMutation(updates.updateNode, {
    onSuccess: () => toast.info(t("nodes.updateStarted")),
    onError: failed,
  });

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <section aria-label={t("nodes.list")} className="relative overflow-x-auto rounded-card bg-card shadow-card">
      <table className="w-full min-w-[980px] border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <Th first>{t("nodes.columns.node")}</Th>
            <Th>{t("nodes.columns.address")}</Th>
            <Th>{t("nodes.columns.usage")}</Th>
            <Th>{t("nodes.columns.version")}</Th>
            <Th>{t("nodes.columns.canBuild")}</Th>
            <Th>{t("nodes.columns.gamesFirst")}</Th>
            <Th last>
              <span className="sr-only">{t("nodes.columns.actions")}</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {list.isPending && (
            <tr>
              <td colSpan={7} className="px-[18px] py-4">
                <Skeleton className="h-16" />
              </td>
            </tr>
          )}
          {list.data?.nodes.length === 0 && (
            <tr>
              <td colSpan={7}>
                <EmptyState compact icon={<IconServer2 />} title={t("nodes.empty")} description={t("nodes.emptyHint")} />
              </td>
            </tr>
          )}
          {list.data?.nodes.map((node) => {
            const ring = statusRing[node.status];
            const usage = node.usage;
            return (
              <tr key={node.id}>
                <Td first>
                  <div className="flex items-start gap-3">
                    <Tip content={t(`nodes.status.${node.status}`)}>
                      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", ring.ring)}>
                        <span className={cn("size-2 rounded-full", ring.dot)} />
                        <span className="sr-only">{t(`nodes.status.${node.status}`)}</span>
                      </span>
                    </Tip>
                    <div className="flex min-w-0 flex-col">
                      <button
                        type="button"
                        onClick={() => onOpen(node.id, "overview")}
                        className="cursor-pointer border-0 bg-transparent p-0 text-left text-[13.5px] leading-[18px] font-semibold text-foreground hover:text-link"
                      >
                        {node.name}
                      </button>
                      <div className="mt-0.5 text-xs text-muted-foreground">{node.location ?? t("nodes.noLocation")}</div>
                      <Badges node={node} />
                    </div>
                  </div>
                </Td>
                <Td>
                  <div className="font-mono text-[12.5px] leading-[18px]">
                    {node.publicAddress ?? node.publicIpv4 ?? node.publicIpv6 ?? "-"}
                  </div>
                  <div className="mt-[3px] font-mono text-xs text-muted-foreground">
                    {node.wildcardDomain ? `*.${node.wildcardDomain}` : t("nodes.noWildcard")}
                  </div>
                </Td>
                <Td className="w-[230px]">
                  {usage ? (
                    <div className="grid grid-cols-[34px_minmax(0,1fr)_76px] items-center gap-x-2.5 gap-y-2 text-xs text-muted-foreground">
                      <Bar label={t("nodes.cpu")} percent={usage.cpuPercent} text={formatPercent(usage.cpuPercent)} />
                      <Bar
                        label={t("nodes.ram")}
                        percent={(usage.memoryUsedBytes / Math.max(1, usage.memoryTotalBytes)) * 100}
                        text={formatUsedOfTotal(usage.memoryUsedBytes, usage.memoryTotalBytes)}
                      />
                      <Bar
                        label={t("nodes.disk")}
                        percent={(usage.diskUsedBytes / Math.max(1, usage.diskTotalBytes)) * 100}
                        text={formatPercent((usage.diskUsedBytes / Math.max(1, usage.diskTotalBytes)) * 100)}
                      />
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t("nodes.noUsage")}</span>
                  )}
                </Td>
                <Td>
                  <div className="font-mono text-[12.5px] leading-[18px]">
                    {node.agentVersion ? `v${node.agentVersion.replace(/^v/, "")}` : "-"}
                  </div>
                  {node.updateAvailable && (
                    <button
                      type="button"
                      disabled={updateNode.isPending || node.status !== "online"}
                      onClick={() => updateNode.mutate({ nodeId: node.id })}
                      className="mt-[7px] h-7 cursor-pointer rounded-[7px] border-0 bg-accent px-2.5 text-xs font-medium whitespace-nowrap text-accent-foreground disabled:opacity-50"
                    >
                      {t("nodes.updateNow")}
                    </button>
                  )}
                </Td>
                <Td>
                  <label htmlFor={`build-${node.id}`} className="flex items-center gap-2 text-[12.5px] leading-[18px] text-ink-strong">
                    <Checkbox
                      id={`build-${node.id}`}
                      checked={node.canBuild}
                      disabled={setCanBuild.isPending}
                      onCheckedChange={(value) => setCanBuild.mutate({ nodeId: node.id, canBuild: value === true })}
                      aria-label={t("nodes.canBuildFor", { name: node.name })}
                    />
                    {node.canBuild
                      ? t("common.yes")
                      : node.canBuildWarning
                        ? t("nodes.noBecause", { reason: node.canBuildWarning })
                        : t("common.no")}
                  </label>
                </Td>
                <Td className="text-[12.5px] leading-[18px] text-muted-foreground">
                  {node.wings.detected ? (
                    <label htmlFor={`games-${node.id}`} className="flex items-center gap-2 text-foreground">
                      <Checkbox
                        id={`games-${node.id}`}
                        checked={node.gamesFirstCpu}
                        disabled={setGamesFirst.isPending}
                        onCheckedChange={(value) => setGamesFirst.mutate({ nodeId: node.id, enabled: value === true })}
                        aria-label={t("nodes.gamesFirstFor", { name: node.name })}
                      />
                      {node.gamesFirstCpu ? t("common.on") : t("common.off")}
                    </label>
                  ) : (
                    t("nodes.noWings")
                  )}
                </Td>
                <Td last className="text-right whitespace-nowrap">
                  <Button
                    size="sm"
                    className="mr-1.5 h-7 rounded-[7px] bg-muted px-2.5 shadow-none"
                    onClick={() => onOpen(node.id, "health")}
                  >
                    <IconHeart
                      size={14}
                      stroke={2}
                      aria-hidden="true"
                      className={node.health.worst ? healthTone[node.health.worst] : "text-status-error"}
                    />
                    {t("nodes.health")}
                  </Button>
                  <Button size="sm" className="h-7 rounded-[7px] bg-muted px-2.5 shadow-none" onClick={() => onOpen(node.id, "settings")}>
                    {t("nodes.settings")}
                  </Button>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Badges({ node }: { node: NodeRow }) {
  const badges: { text: string; tone: "blue" | "violet" | "gray" | "red" | "amber" }[] = [];
  if (node.isPanelNode) badges.push({ text: t("nodes.badges.panel"), tone: "blue" });
  if (node.wings.detected) badges.push({ text: t("nodes.badges.wings"), tone: "violet" });
  if (node.wings.sharedProxy) badges.push({ text: t("nodes.badges.sharedProxy"), tone: "gray" });
  if (node.status === "offline") badges.push({ text: t("nodes.badges.offline"), tone: "red" });
  if (node.health.worst === "fail") badges.push({ text: t("nodes.badges.healthFail"), tone: "red" });
  else if (node.health.worst === "warn") badges.push({ text: t("nodes.badges.healthWarn"), tone: "amber" });
  for (const tag of node.tags) badges.push({ text: tag, tone: "gray" });
  if (badges.length === 0) return null;
  return (
    <div className="mt-[7px] flex flex-wrap gap-1.5">
      {badges.map((badge) => (
        <Chip key={badge.text} tone={badge.tone} className="px-[7px] py-0.5 text-[11.5px]">
          {badge.text}
        </Chip>
      ))}
    </div>
  );
}

function Bar({ label, percent, text }: { label: string; percent: number; text: string }) {
  return (
    <>
      <span>{label}</span>
      <span className="h-1.5 rounded-[3px] bg-muted" aria-hidden="true">
        <span
          className={cn("block h-1.5 rounded-[3px]", percent >= 90 ? "bg-status-error" : percent >= 75 ? "bg-status-busy" : "bg-primary")}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </span>
      <span className="font-medium whitespace-nowrap text-ink-strong">{text}</span>
    </>
  );
}

function Th({ children, first, last }: { children: ReactNode; first?: boolean; last?: boolean }) {
  return (
    <th scope="col" className={cn("border-b border-divider pt-3.5 pb-3 font-medium", first || last ? "px-[18px]" : "px-2.5")}>
      {children}
    </th>
  );
}

function Td({ children, first, last, className }: { children: ReactNode; first?: boolean; last?: boolean; className?: string }) {
  return <td className={cn("border-t border-divider py-4 align-top", first || last ? "px-[18px]" : "px-2.5", className)}>{children}</td>;
}
