// One row of the Backups and restores card, and what it offers. A backup
// that is there to restore has Restore and Delete. Once its destination
// was deleted the panel has no keys for that bucket: the row says so and
// only offers Remove from list, which marks it deleted and leaves the file
// in the bucket.

import type { backups, OpOutput } from "@seylo/ops";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { cn } from "@seylo/ui/lib/utils";
import { IconDots } from "@tabler/icons-react";
import { t } from "../../../i18n/t";
import { formatBytes, formatDateTime, formatDuration } from "../format";

export type Run = OpOutput<typeof backups.listRuns>["runs"][number];

/** restorable: Restore and Delete. destinationGone: its destination was deleted, only Remove from list. none: nothing to do. */
export type RunActions = "restorable" | "destinationGone" | "none";

export function runActions(r: Run): RunActions {
  if (r.kind !== "backup" || r.status !== "succeeded" || r.deletedAt) return "none";
  // The panel clears destinationId when the destination is deleted.
  return r.destinationId === null ? "destinationGone" : "restorable";
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

export function RunRow({ run: r, onRestore, onDelete }: { run: Run; onRestore: () => void; onDelete: () => void }) {
  const failed = r.status === "failed";
  const running = r.status === "running";
  const actions = runActions(r);
  const took = r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-2.5 text-[13px]">
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
      {r.kind === "restore" && <Chip tone="violet">{t("serviceBackups.restoreRun")}</Chip>}
      {r.deletedAt && <Chip tone="gray">{t("serviceBackups.deleted")}</Chip>}
      {actions === "destinationGone" && <Chip tone="gray">{t("serviceBackups.destinationDeleted")}</Chip>}
      {r.error && <span className="min-w-0 flex-1 truncate text-[12.5px] text-chip-red-fg">{r.error}</span>}
      <span className="ml-auto text-[12.5px] text-muted-foreground">
        {[
          r.sizeBytes != null ? formatBytes(r.sizeBytes) : null,
          took != null ? formatDuration(took) : running ? t("serviceBackups.running") : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {actions !== "none" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={t("serviceBackups.actions")}>
              <IconDots size={15} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions === "restorable" && <DropdownMenuItem onSelect={onRestore}>{t("serviceBackups.restore")}</DropdownMenuItem>}
            <DropdownMenuItem destructive onSelect={onDelete}>
              {actions === "restorable" ? t("service.remove") : t("serviceBackups.forgetRun")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // A row without actions keeps the menu's place, so sizes and times line up on the right.
        <span aria-hidden="true" className="size-[30px] shrink-0" />
      )}
    </div>
  );
}
