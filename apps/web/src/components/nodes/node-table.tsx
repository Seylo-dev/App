// The node list (Nodes.dc.html): status, name, location and badges;
// addresses; CPU, memory and disk bars; agent version with "Update now";
// the can-build and games-first switches; Health and Settings. The live
// topic "panel" refreshes it when a node changes or reports usage.
//
// The table needs about 1000px. In a narrower list (a phone, a tablet, a
// small laptop next to the sidebar) each node is a stacked row instead:
// the same facts and controls one under the other, with their column
// names as small labels, so nothing is cut off or scrolled out of view.

import { nodes, system, updates } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { Tip } from "@seylo/ui/components/tooltip";
import { cn } from "@seylo/ui/lib/utils";
import { IconHeart, IconServer2 } from "@tabler/icons-react";
import { type ReactNode, useCallback, useState } from "react";
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

/** The list's width from which the table fits without squeezing its columns. */
const tableWidth = 1000;

/**
 * Whether the element is at least `min` px wide, kept in step as it
 * resizes. The ref callback measures before the first paint, so the list
 * never flashes the other layout.
 */
function useAtLeast(min: number): [(el: HTMLElement | null) => (() => void) | undefined, boolean] {
  const [wide, setWide] = useState(true);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;
      const update = () => setWide(el.clientWidth >= min);
      update();
      if (typeof ResizeObserver === "undefined") return undefined;
      const observer = new ResizeObserver(update);
      observer.observe(el);
      return () => observer.disconnect();
    },
    [min],
  );
  return [ref, wide];
}

interface RowProps {
  node: NodeRow;
  onOpen: (nodeId: string, view: NodeView) => void;
  canBuild: { pending: boolean; set: (canBuild: boolean) => void };
  gamesFirst: { pending: boolean; set: (enabled: boolean) => void };
  update: { pending: boolean; run: () => void };
}

export function NodeTable({ onOpen }: { onOpen: (nodeId: string, view: NodeView) => void }) {
  const list = useOp(nodes.list, {});
  // The sidebar already knows how many nodes there are: one placeholder row each.
  const nodeCount = useOp(system.info, {}).data?.nodes.total ?? 3;
  const failed = (error: unknown) => toast.error(errorMessage(error, t("common.unknownError")));
  const setCanBuild = useOpMutation(nodes.setCanBuild, { onSuccess: () => void list.refetch(), onError: failed });
  const setGamesFirst = useOpMutation(nodes.setGamesFirstCpu, { onSuccess: () => void list.refetch(), onError: failed });
  const updateNode = useOpMutation(updates.updateNode, {
    onSuccess: () => toast.info(t("nodes.updateStarted")),
    onError: failed,
  });
  const [measure, wide] = useAtLeast(tableWidth);

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} />;

  const rowProps = (node: NodeRow): RowProps => ({
    node,
    onOpen,
    canBuild: { pending: setCanBuild.isPending, set: (canBuild) => setCanBuild.mutate({ nodeId: node.id, canBuild }) },
    gamesFirst: { pending: setGamesFirst.isPending, set: (enabled) => setGamesFirst.mutate({ nodeId: node.id, enabled }) },
    update: { pending: updateNode.isPending, run: () => updateNode.mutate({ nodeId: node.id }) },
  });
  const placeholders = list.isPending ? Math.max(1, nodeCount) : 0;
  const empty = list.data?.nodes.length === 0 && (
    <EmptyState compact icon={<IconServer2 />} title={t("nodes.empty")} description={t("nodes.emptyHint")} />
  );

  return (
    <section ref={measure} aria-label={t("nodes.list")} aria-busy={list.isPending} className="relative rounded-card bg-card shadow-card">
      {wide ? (
        <table className="w-full border-collapse text-[13px]">
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
            {Array.from({ length: placeholders }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one placeholder per node.
              <NodeRowSkeleton key={i} />
            ))}
            {empty && (
              <tr>
                <td colSpan={7}>{empty}</td>
              </tr>
            )}
            {list.data?.nodes.map((node) => (
              <TableRow key={node.id} {...rowProps(node)} />
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {Array.from({ length: placeholders }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one placeholder per node.
            <StackedRowSkeleton key={i} />
          ))}
          {empty && <li>{empty}</li>}
          {list.data?.nodes.map((node) => (
            <StackedRow key={node.id} {...rowProps(node)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TableRow(props: RowProps) {
  const { node } = props;
  return (
    <tr>
      <Td first>
        <Identity {...props} />
      </Td>
      <Td>
        <Address node={node} />
      </Td>
      <Td className="w-[230px]">
        <Usage node={node} />
      </Td>
      <Td>
        <Version {...props} />
      </Td>
      <Td>
        <CanBuild {...props} />
      </Td>
      <Td className="text-[12.5px] leading-[18px] whitespace-nowrap text-muted-foreground">
        {node.wings.detected ? <GamesFirst {...props} /> : t("nodes.noWings")}
      </Td>
      <Td last className="whitespace-nowrap">
        <Actions {...props} className="justify-end" />
      </Td>
    </tr>
  );
}

/** One node in a narrow list: who it is, where it answers and its version, usage, the two switches, then Health and Settings. */
function StackedRow(props: RowProps) {
  const { node } = props;
  return (
    <li className="flex flex-col gap-3.5 border-t border-divider px-[18px] py-4 first:border-t-0">
      <Identity {...props} />
      <div className="flex flex-wrap gap-x-10 gap-y-3.5">
        <Fact label={t("nodes.columns.address")}>
          <Address node={node} />
        </Fact>
        <Fact label={t("nodes.columns.version")}>
          <Version {...props} />
        </Fact>
      </div>
      <Fact label={t("nodes.columns.usage")} className="max-w-[420px]">
        <Usage node={node} />
      </Fact>
      <div className="flex flex-col gap-2.5">
        <CanBuild {...props} labelled />
        {node.wings.detected && <GamesFirst {...props} labelled />}
      </div>
      <Actions {...props} />
    </li>
  );
}

function Fact({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Identity({ node, onOpen }: RowProps) {
  const ring = statusRing[node.status];
  return (
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
          className="cursor-pointer border-0 bg-transparent p-0 text-left text-[13.5px] leading-[18px] font-semibold text-foreground transition-colors duration-200 hover:text-link"
        >
          {node.name}
        </button>
        <div className="mt-0.5 text-xs text-muted-foreground">{node.location ?? t("nodes.noLocation")}</div>
        <Badges node={node} />
      </div>
    </div>
  );
}

function Address({ node }: { node: NodeRow }) {
  return (
    <div className="break-words">
      <div className="font-mono text-[12.5px] leading-[18px]">{node.publicAddress ?? node.publicIpv4 ?? node.publicIpv6 ?? "-"}</div>
      <div className="mt-[3px] font-mono text-xs text-muted-foreground">
        {node.wildcardDomain ? `*.${node.wildcardDomain}` : t("nodes.noWildcard")}
      </div>
    </div>
  );
}

function Usage({ node }: { node: NodeRow }) {
  const usage = node.usage;
  if (!usage) return <span className="text-xs text-muted-foreground">{t("nodes.noUsage")}</span>;
  return (
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
  );
}

function Version({ node, update }: RowProps) {
  return (
    <>
      <div className="font-mono text-[12.5px] leading-[18px]">{node.agentVersion ? `v${node.agentVersion.replace(/^v/, "")}` : "-"}</div>
      {node.updateAvailable && (
        <button
          type="button"
          disabled={update.pending || node.status !== "online"}
          onClick={update.run}
          className="mt-[7px] h-7 cursor-pointer rounded-[7px] border-0 bg-accent px-2.5 text-xs font-medium whitespace-nowrap text-accent-foreground transition-interactive disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("nodes.updateNow")}
        </button>
      )}
    </>
  );
}

/**
 * The can-build switch, the same control the node's Settings view uses.
 * In the table the column names it and the cell says Yes or No; a stacked
 * row names it next to the switch. A warning (no buildx, a small machine)
 * stays in view under it: on, builds fail or are slow there; off, it says why.
 */
function CanBuild({ node, canBuild, labelled = false }: RowProps & { labelled?: boolean }) {
  return (
    <div>
      <label
        htmlFor={`build-${node.id}`}
        className="flex items-center gap-2 text-[12.5px] leading-[18px] whitespace-nowrap text-ink-strong"
      >
        <Switch
          id={`build-${node.id}`}
          size="sm"
          checked={node.canBuild}
          disabled={canBuild.pending}
          onCheckedChange={canBuild.set}
          aria-label={t("nodes.canBuildFor", { name: node.name })}
        />
        {labelled ? t("nodes.columns.canBuild") : node.canBuild ? t("common.yes") : t("common.no")}
      </label>
      {node.canBuildWarning && (
        <div
          className={cn(
            "mt-1 pl-9 text-xs leading-4",
            !labelled && "whitespace-nowrap",
            node.canBuild ? "text-chip-amber-fg" : "text-muted-foreground",
          )}
        >
          {node.canBuildWarning}
        </div>
      )}
    </div>
  );
}

function GamesFirst({ node, gamesFirst, labelled = false }: RowProps & { labelled?: boolean }) {
  return (
    <label htmlFor={`games-${node.id}`} className="flex items-center gap-2 text-[12.5px] leading-[18px] whitespace-nowrap text-foreground">
      <Switch
        id={`games-${node.id}`}
        size="sm"
        checked={node.gamesFirstCpu}
        disabled={gamesFirst.pending}
        onCheckedChange={gamesFirst.set}
        aria-label={t("nodes.gamesFirstFor", { name: node.name })}
      />
      {labelled ? t("nodes.columns.gamesFirst") : node.gamesFirstCpu ? t("common.on") : t("common.off")}
    </label>
  );
}

function Actions({ node, onOpen, className }: RowProps & { className?: string }) {
  return (
    // A flex row: two inline buttons line up by their text baseline, and the icon pushed Health down.
    <div className={cn("flex items-center gap-1.5", className)}>
      <Button size="sm" className="h-7 rounded-[7px] bg-muted px-2.5 shadow-none" onClick={() => onOpen(node.id, "health")}>
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
    </div>
  );
}

/**
 * A node row while the list loads, in the real row's cells and line
 * heights. The cells carry the widths the columns get with typical data,
 * so the header stays put when the rows arrive.
 */
function NodeRowSkeleton() {
  return (
    <tr>
      <Td first className="w-[257px]">
        <IdentitySkeleton />
      </Td>
      <Td className="w-[142px]">
        <SkeletonText className="w-24 text-[12.5px] leading-[18px]" />
        <SkeletonText className="mt-[3px] w-28 text-xs" />
      </Td>
      <Td className="w-[230px]">
        <UsageSkeleton />
      </Td>
      <Td className="w-[107px]">
        <SkeletonText className="w-12 text-[12.5px] leading-[18px]" />
      </Td>
      <Td className="w-[98px]">
        <SkeletonText className="w-12 text-[12.5px] leading-[18px]" />
      </Td>
      <Td className="w-[131px]">
        <SkeletonText className="w-16 text-[12.5px] leading-[18px]" />
      </Td>
      <Td last className="w-[190px] text-right whitespace-nowrap">
        <div className="flex justify-end gap-1.5">
          <Skeleton className="h-7 w-[74px] rounded-[7px]" />
          <Skeleton className="h-7 w-[66px] rounded-[7px]" />
        </div>
      </Td>
    </tr>
  );
}

function StackedRowSkeleton() {
  return (
    <li className="flex flex-col gap-3.5 border-t border-divider px-[18px] py-4 first:border-t-0">
      <IdentitySkeleton />
      <div className="flex flex-wrap gap-x-10 gap-y-3.5">
        {[t("nodes.columns.address"), t("nodes.columns.version")].map((label) => (
          <div key={label} className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            <SkeletonText className="w-24 text-[12.5px] leading-[18px]" />
          </div>
        ))}
      </div>
      <div className="flex max-w-[420px] flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{t("nodes.columns.usage")}</span>
        <UsageSkeleton />
      </div>
      <SkeletonText className="w-28 text-[12.5px] leading-[18px]" />
      <div className="flex gap-1.5">
        <Skeleton className="h-7 w-[74px] rounded-[7px]" />
        <Skeleton className="h-7 w-[66px] rounded-[7px]" />
      </div>
    </li>
  );
}

function IdentitySkeleton() {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-col">
        <SkeletonText className="w-20 text-[13.5px] leading-[18px]" />
        <SkeletonText className="mt-0.5 w-32 text-xs" />
        <Skeleton className="mt-[7px] h-[21px] w-20 rounded-chip" />
      </div>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="grid grid-cols-[34px_minmax(0,1fr)_76px] items-center gap-x-2.5 gap-y-2 text-xs text-muted-foreground">
      {[t("nodes.cpu"), t("nodes.ram"), t("nodes.disk")].map((label) => (
        <span key={label} className="contents">
          <span>{label}</span>
          <Skeleton className="h-1.5 rounded-[3px]" />
          <SkeletonText className="w-12" />
        </span>
      ))}
    </div>
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
    <th
      scope="col"
      className={cn("border-b border-divider pt-3.5 pb-3 font-medium whitespace-nowrap", first || last ? "px-[18px]" : "px-2.5")}
    >
      {children}
    </th>
  );
}

function Td({ children, first, last, className }: { children: ReactNode; first?: boolean; last?: boolean; className?: string }) {
  return <td className={cn("border-t border-divider py-4 align-top", first || last ? "px-[18px]" : "px-2.5", className)}>{children}</td>;
}
