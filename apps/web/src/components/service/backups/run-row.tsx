// One row of the Backups and restores card: when, what it backed up or
// restored ("Volume data", "Database", "Restore of the <date> backup of
// Database"), what a database backup holds (databases as chips, their
// tables on expand), and what it offers. A backup that is there to restore
// has Restore, Download and Delete. Once its destination was deleted the
// panel has no keys for that bucket: the row says so and only offers
// Remove from list, which marks it deleted and leaves the file in the
// bucket.

import { backups, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronDown, IconChevronUp, IconDots } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { formatBytes, formatDateTime, formatDuration } from "../format";
import { retryOp } from "../op-state";
import { RowsSkeleton } from "../service-skeletons";
import type { ServiceDetail } from "../use-service";
import { type RunChip, runChips, sizeAndRows, tableLabel } from "./selection";

export type Run = OpOutput<typeof backups.listRuns>["runs"][number];

/** restorable: Restore and Delete. destinationGone: its destination was deleted, only Remove from list. none: nothing to do. */
export type RunActions = "restorable" | "destinationGone" | "none";

export function runActions(r: Run): RunActions {
  if (r.kind !== "backup" || r.status !== "succeeded" || r.deletedAt) return "none";
  // The panel clears destinationId when the destination is deleted.
  return r.destinationId === null ? "destinationGone" : "restorable";
}

/** The menu of a row: Restore, Download and Remove while the backup is there; Remove from list once its destination is gone. */
export type RunMenuItem = "restore" | "download" | "remove" | "forget";

export function runMenu(r: Run): RunMenuItem[] {
  switch (runActions(r)) {
    case "restorable":
      return ["restore", "download", "remove"];
    case "destinationGone":
      return ["forget"];
    default:
      return [];
  }
}

/** What a backup holds: "Database", "Volume data" ("Deleted volume" once the volume is gone). */
export function runSubject(r: Pick<Run, "target" | "volumeName">): string {
  if (r.target === "database") return t("serviceBackups.database");
  return r.volumeName ? t("serviceBackups.volume", { name: r.volumeName }) : t("serviceBackups.volumeGone");
}

/** The words next to a row's date: what it backed up, or for a restore which backup it restored. */
export function runLabel(r: Run): string {
  const what = runSubject(r);
  if (r.kind !== "restore") return what;
  return r.sourceStartedAt
    ? t("serviceBackups.restoreOf", { when: formatDateTime(r.sourceStartedAt), what })
    : t("serviceBackups.restoreOfUnknown", { what });
}

/** The delete dialog's words: Delete takes the file out of the bucket, Remove from list only forgets the backup here. */
export function deleteRunCopy(r: Run | null): { title: string; description: string; confirmLabel: string } {
  if (r && runActions(r) === "destinationGone") {
    return {
      title: t("serviceBackups.forgetRunTitle"),
      description: t("serviceBackups.forgetRunBody"),
      confirmLabel: t("serviceBackups.forgetRun"),
    };
  }
  return { title: t("serviceBackups.deleteRunTitle"), description: t("serviceBackups.deleteRunBody"), confirmLabel: t("service.remove") };
}

/**
 * True when the dialog said the file is deleted from the bucket, but the
 * destination was deleted meanwhile (in another tab, or by someone else,
 * before this list refetched): the panel only marked the backup deleted
 * and the file stayed.
 */
export function fileKept(asked: Run, done: Run): boolean {
  return runActions(asked) === "restorable" && done.destinationId === null;
}

/** Fill-only chips of what a run holds. */
export function RunChips({ chips, label, className }: { chips: RunChip[]; label: string; className?: string }) {
  if (chips.length === 0) return null;
  return (
    <ul aria-label={label} className={cn("m-0 flex list-none flex-wrap items-center gap-1.5 p-0", className)}>
      {chips.map((c) => (
        <li key={c.key}>
          <Chip tone={c.tone}>{c.label}</Chip>
        </li>
      ))}
    </ul>
  );
}

/** A backup's tables or collections per database, loaded when the row opens, and what it skipped. */
function RunContents({ service, run }: { service: ServiceDetail; run: Run }) {
  const full = useOp(backups.runContents, { serviceId: service.id, runId: run.id }, { retry: retryOp });
  if (full.isPending) return <RowsSkeleton rows={2} lines={1} width="w-40" className="py-1.5" />;
  if (full.isError) return <p className="m-0 text-[12.5px] text-chip-red-fg">{t("serviceBackups.contentsFailed")}</p>;
  const databases = full.data.contents?.databases ?? [];
  return (
    <div className="flex flex-col gap-3">
      {databases.map((d) => (
        <section key={d.name} aria-label={d.name} className="flex flex-col gap-1">
          <h3 className="m-0 flex flex-wrap gap-x-2 text-[12.5px] font-semibold">
            {d.name}
            <span className="font-normal text-muted-foreground">{sizeAndRows(d)}</span>
          </h3>
          {d.tables.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[12.5px]">
              {d.tables.map((tab) => (
                <li key={`${tab.schema}.${tab.name}`} className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-mono text-[12px]">{tableLabel(tab)}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{sizeAndRows(tab)}</span>
                </li>
              ))}
            </ul>
          )}
          {d.tableCount > d.tables.length && (
            <span className="text-[12px] text-muted-foreground">
              {t("serviceBackups.andMore", { count: d.tableCount - d.tables.length })}
            </span>
          )}
        </section>
      ))}
      {full.data.warnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[12.5px] text-chip-amber-fg">
          {full.data.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RunRow({
  service,
  run: r,
  onRestore,
  onDownload,
  onDelete,
}: {
  service: ServiceDetail;
  run: Run;
  onRestore: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const failed = r.status === "failed";
  const running = r.status === "running";
  const actions = runActions(r);
  const menu = runMenu(r);
  const took = r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null;
  const chips = runChips(r, service.kind);
  const isDb = r.target === "database";
  const expandable = (r.contents?.databases.length ?? 0) > 0 || r.warnings.length > 0;
  return (
    <div className="border-t border-divider px-5 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full",
            failed ? "bg-chip-red-bg" : running ? "bg-chip-amber-bg" : "bg-chip-green-bg",
          )}
        >
          <span
            className={cn("size-2 rounded-full", failed ? "bg-status-error" : running ? "animate-pulse bg-status-busy" : "bg-status-ok")}
          />
        </span>
        <b className="font-medium">{formatDateTime(r.startedAt)}</b>
        <span className="min-w-0 truncate text-ink-strong">{runLabel(r)}</span>
        {r.kind === "restore" && <Chip tone="violet">{t("serviceBackups.restoreRun")}</Chip>}
        {r.deletedAt && <Chip tone="gray">{t("serviceBackups.deleted")}</Chip>}
        {actions === "destinationGone" && <Chip tone="gray">{t("serviceBackups.destinationDeleted")}</Chip>}
        {r.error && <span className="min-w-0 flex-1 truncate text-[12.5px] text-chip-red-fg">{r.error}</span>}
        {/* A restore's notes: the backup before it was skipped (nothing of it was left to keep). */}
        {r.kind === "restore" && !r.error && r.warnings.length > 0 && (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground" title={r.warnings.join(" ")}>
            {r.warnings.join(" ")}
          </span>
        )}
        <span className="ml-auto text-[12.5px] text-muted-foreground">
          {[
            r.sizeBytes != null ? (isDb ? t("serviceBackups.file", { size: formatBytes(r.sizeBytes) }) : formatBytes(r.sizeBytes)) : null,
            took != null ? formatDuration(took) : running ? t("serviceBackups.running") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {menu.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={t("serviceBackups.actions")}>
                <IconDots size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menu.map((item) =>
                item === "restore" ? (
                  <DropdownMenuItem key={item} onSelect={onRestore}>
                    {t("serviceBackups.restore")}
                  </DropdownMenuItem>
                ) : item === "download" ? (
                  <DropdownMenuItem key={item} onSelect={onDownload}>
                    {t("serviceBackups.download")}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem key={item} destructive onSelect={onDelete}>
                    {item === "remove" ? t("service.remove") : t("serviceBackups.forgetRun")}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          // A row without actions keeps the menu's place, so sizes and times line up on the right.
          <span aria-hidden="true" className="size-[30px] shrink-0" />
        )}
      </div>
      {chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-11">
          <RunChips chips={chips} label={t("serviceBackups.holds")} />
          {expandable && (
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-expanded={open}
              aria-label={open ? t("serviceBackups.hideContents") : t("serviceBackups.showContents")}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
            </Button>
          )}
        </div>
      )}
      {open && (
        <div className="mt-2 max-w-xl pl-11">
          <RunContents service={service} run={r} />
        </div>
      )}
    </div>
  );
}
