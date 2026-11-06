// Placeholders for the service layout (header, usage strip) and for a tab
// whose screen waits on the service itself, in the real layouts' sizes.

import { SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronDown } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";

/** ServiceHeader while the service loads: kind tile, name, status and node chips, address and the actions. */
export function ServiceHeaderSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="flex flex-wrap items-center gap-3">
      <Skeleton className="h-7 w-[38px] rounded-chip bg-track" />
      <SkeletonText ground className="w-24 text-2xl" />
      <Skeleton className="h-6 w-[76px] rounded-chip bg-track" />
      <Skeleton className="h-6 w-16 rounded-chip bg-track" />
      <SkeletonText ground className="w-32 text-[12.5px]" />
      <div className="ml-auto flex flex-wrap gap-2">
        <ButtonSkeleton className="w-[76px] bg-track" />
        <ButtonSkeleton className="w-[60px] bg-track" />
        <ButtonSkeleton className="w-[74px] bg-track" />
      </div>
    </LoadingRegion>
  );
}

/** UsageStrip's five cells with their labels, values still to come. */
export function UsageStripSkeleton() {
  const labels = [
    t("service.usage.cpu"),
    t("service.usage.memory"),
    t("service.usage.network"),
    t("service.usage.liveVersion"),
    t("service.usage.crashPolicy"),
  ];
  return (
    <LoadingRegion
      label={t("common.loading")}
      className="grid grid-cols-2 gap-1 rounded-card bg-card p-1.5 shadow-card sm:grid-cols-3 lg:grid-cols-5"
    >
      {labels.map((label, i) => (
        <div key={label} className="flex min-w-0 flex-col gap-[3px] px-3.5 py-2.5">
          <span className="flex items-center gap-[5px] text-xs text-muted-foreground">
            {label}
            {i === 1 && <IconChevronDown size={12} stroke={2.2} aria-hidden="true" />}
          </span>
          <SkeletonText className="w-20 text-[17px]" />
        </div>
      ))}
    </LoadingRegion>
  );
}

/** One row of a list inside a flush SectionCard: an icon, two lines, a meta line and a menu button on the right. */
export function ListRowSkeleton({ icon = true, wide = "w-40", meta = true }: { icon?: boolean; wide?: string; meta?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-divider px-5 py-3">
      {icon && <Skeleton className="size-8 shrink-0 rounded-full" />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SkeletonText className={`text-[13.5px] ${wide}`} />
        <SkeletonText className="w-56 text-[12.5px]" />
      </div>
      {meta && <SkeletonText className="ml-auto w-20 text-xs" />}
    </div>
  );
}

/** A card of list rows while it loads. */
export function ListCardSkeleton({ rows = 3, action = true, children }: { rows?: number; action?: boolean; children?: ReactNode }) {
  return (
    <SectionCardSkeleton
      flush
      titleWidth="w-32"
      description="w-72"
      actions={action ? <ButtonSkeleton size="sm" className="w-24" /> : undefined}
    >
      {children ??
        Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
          <ListRowSkeleton key={i} />
        ))}
    </SectionCardSkeleton>
  );
}

/** A tab's screen while the service it shows is still loading: a card with a few rows. */
export function TabSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="flex flex-col gap-5">
      <ListCardSkeleton />
    </LoadingRegion>
  );
}

/** The dark terminal surface of the console, shell and logs tabs while they load. */
export function TerminalSkeleton() {
  return (
    <LoadingRegion
      label={t("common.loading")}
      className="flex min-h-[520px] flex-1 flex-col overflow-hidden rounded-card bg-terminal shadow-card"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 bg-terminal-bar px-3.5">
        <Skeleton className="h-6 w-20 rounded-chip bg-terminal-field" />
        <SkeletonText className="w-64 text-[12.5px] opacity-30" />
      </div>
      <div className="flex flex-col gap-2 p-4">
        {["w-72", "w-56", "w-80", "w-48", "w-64"].map((width) => (
          <Skeleton key={width} className={`h-3 rounded-chip bg-terminal-field ${width}`} />
        ))}
      </div>
    </LoadingRegion>
  );
}

/**
 * Rows of a list card (schedules, runs, checks, alerts, previews, domains)
 * while they load: a leading switch, circle or dot, one or two text lines,
 * a meta line and a menu button, with the list's own row padding.
 */
export function RowsSkeleton({
  rows = 3,
  lead = "circle",
  lines = 2,
  width = "w-40",
  meta = true,
  action = true,
  className,
}: {
  rows?: number;
  lead?: "switch" | "circle" | "dot" | "icon" | "none";
  lines?: 1 | 2;
  width?: string;
  meta?: boolean;
  action?: boolean;
  className?: string;
}) {
  return (
    <LoadingRegion label={t("common.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders.
        <div key={i} className={cn("flex items-center gap-3 border-t border-divider px-5 py-3", className)}>
          {lead === "switch" && <Skeleton className="h-5 w-9 shrink-0 rounded-full" />}
          {lead === "circle" && <Skeleton className="size-8 shrink-0 rounded-full" />}
          {lead === "dot" && <Skeleton className="size-6 shrink-0 rounded-full" />}
          {lead === "icon" && <Skeleton className="size-4 shrink-0 rounded-[4px]" />}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <SkeletonText className={cn("text-[13.5px]", width)} />
            {lines > 1 && <SkeletonText className="w-56 text-[12.5px]" />}
          </div>
          {meta && <SkeletonText className="w-24 text-xs" />}
          {action && <Skeleton className="size-[30px] shrink-0 rounded-chip" />}
        </div>
      ))}
    </LoadingRegion>
  );
}
