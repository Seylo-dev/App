// The Backups tab (also on database pages): schedules of the database or a
// volume to an S3/R2 destination, "Back up now" (every enabled schedule;
// each schedule's menu backs up just that one), the run history with
// what each backup holds (databases as chips, their tables on expand),
// restore (type the name to confirm; the text says what is replaced),
// download (straight from the bucket) and delete. A failed restore or
// delete says why inside its dialog, which stays open; nothing is left on
// the card after it closes. A row's "..." and its right-click menu are
// one list (menus/row-items.tsx).

import { backups, type OpOutput } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { ActionsMenu } from "@seylo/ui/components/menu-items";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconDots, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { backupPolicyMenuEntries } from "../../menus/row-items";
import { RowMenu } from "../../menus/row-menu";
import { describeCron } from "../cron-text";
import { CheckLabel } from "../field";
import { volumesOf } from "../files/volumes";
import { formatDateTime, formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, OpErrorNote, retryOp } from "../op-state";
import { RowsSkeleton } from "../service-skeletons";
import { isDatabaseKind } from "../status";
import type { ServiceDetail } from "../use-service";
import { failRunNow, useBackUpNow } from "./back-up-now";
import { PolicyDialog } from "./policy-dialog";
import { deleteRunCopy, fileKept, type Run, RunChips, RunRow } from "./run-row";
import { policyTitle, restoreText, runChips } from "./selection";

type Policy = OpOutput<typeof backups.listPolicies>["policies"][number];

const fail = (error: unknown) =>
  toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

export function BackupsPage({ service }: { service: ServiceDetail }) {
  const policies = useOp(backups.listPolicies, { serviceId: service.id }, { retry: retryOp });
  const destinations = useOp(backups.listDestinations, {}, { retry: retryOp });
  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  const choices = destinations.data?.choices ?? [];
  const list = policies.data?.policies ?? [];
  const isDb = isDatabaseKind(service.kind);
  const canVolume = volumesOf(service).length > 0;
  const canCreate = choices.length > 0 && (isDb || canVolume);
  const backUpNow = useBackUpNow(service, policies.data?.policies, choices);

  return (
    <div className="flex flex-col gap-4">
      {destinations.data && choices.length === 0 && (
        <Callout
          tone="info"
          title={t("serviceBackups.noDestinationTitle")}
          action={
            <Button asChild size="sm">
              <Link to="/settings/backups">{t("serviceBackups.addDestination")}</Link>
            </Button>
          }
        >
          {t("serviceBackups.noDestinationBody")}
        </Callout>
      )}
      <Card className="gap-0 overflow-hidden p-0" aria-label={t("serviceBackups.schedules")}>
        <div className="flex flex-wrap items-center gap-2.5 px-5 pt-4 pb-3.5">
          <h2 className="m-0 text-[15px] font-semibold">{t("serviceBackups.schedules")}</h2>
          <span className="text-[12.5px] text-muted-foreground">{t("serviceBackups.utc")}</span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" onClick={backUpNow.run} disabled={backUpNow.disabled}>
              {t("serviceBackups.backUpNow")}
            </Button>
            <Button size="sm" variant="primary" onClick={() => setEditing("new")} disabled={!canCreate}>
              <IconPlus size={14} />
              {t("serviceBackups.addSchedule")}
            </Button>
          </span>
        </div>
        {policies.isPending ? (
          <RowsSkeleton rows={1} lead="switch" width="w-24" />
        ) : policies.isError ? (
          <div className="border-t border-divider px-5 py-4">
            <OpErrorNote error={policies.error} />
          </div>
        ) : list.length === 0 ? (
          <div className="border-t border-divider">
            <EmptyState
              compact
              title={t("serviceBackups.noSchedules")}
              description={isDb ? t("serviceBackups.noSchedulesDb") : t("serviceBackups.noSchedulesVolume")}
            />
          </div>
        ) : (
          list.map((p) => <PolicyRow key={p.id} service={service} policy={p} onEdit={() => setEditing(p)} />)
        )}
      </Card>
      <RunsCard service={service} />
      {editing && (
        <PolicyDialog service={service} policy={editing === "new" ? null : editing} choices={choices} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function PolicyRow({ service, policy: p, onEdit }: { service: ServiceDetail; policy: Policy; onEdit: () => void }) {
  const invalidate = useInvalidate();
  const [confirm, setConfirm] = useState(false);
  const update = useOpMutation(backups.updatePolicy, { onSuccess: () => invalidate(backups.listPolicies), onError: fail });
  const run = useOpMutation(backups.runNow, {
    onSuccess: () => {
      invalidate(backups.listRuns, backups.listPolicies);
      toast.success(t("serviceBackups.started"));
    },
    onError: (error) => {
      // A refusal because the schedule is still backing up: its run shows in the list, so refresh that too.
      invalidate(backups.listRuns, backups.listPolicies);
      failRunNow(error);
    },
  });
  const remove = useOpMutation(backups.deletePolicy, { onSuccess: () => invalidate(backups.listPolicies) });
  const menu = backupPolicyMenuEntries({
    act: (action) => {
      if (action === "runNow") run.mutate({ serviceId: service.id, policyId: p.id });
      else if (action === "edit") onEdit();
      else setConfirm(true);
    },
  });
  return (
    <>
      <RowMenu entries={menu} aria-label={t("serviceBackups.actions")}>
        <div className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-3 text-[13px] transition-colors duration-200 data-[state=open]:bg-raised">
          <Switch
            size="sm"
            checked={p.enabled}
            onCheckedChange={(enabled) => update.mutate({ serviceId: service.id, policyId: p.id, enabled })}
            aria-label={t("serviceBackups.enabled")}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <b className="font-semibold">{policyTitle(p, service.kind)}</b>
            <span className="text-[12.5px] text-ink-strong">
              {t("serviceBackups.policyLine", { schedule: describeCron(p.schedule), destination: p.destinationName, keep: p.keepLast })}
            </span>
          </span>
          {p.stopService && <Chip tone="amber">{t("serviceBackups.stopsService")}</Chip>}
          <span className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {p.lastRun && (
              <span className={cn(p.lastRun.status === "failed" && "text-chip-red-fg")}>
                {t(`serviceBackups.last.${p.lastRun.status === "failed" ? "failed" : p.lastRun.status === "running" ? "running" : "ok"}`, {
                  when: p.lastRun.finishedAt ? formatRelative(p.lastRun.finishedAt) : "",
                })}
              </span>
            )}
            {p.enabled && p.nextRunAt && <span>{t("serviceBackups.next", { when: formatRelative(p.nextRunAt) })}</span>}
            <ActionsMenu
              entries={menu}
              trigger={
                <Button size="icon" variant="ghost" aria-label={t("serviceBackups.actions")}>
                  <IconDots size={15} />
                </Button>
              }
            />
          </span>
        </div>
      </RowMenu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("serviceBackups.removeTitle")}
        description={t("serviceBackups.removeBody")}
        confirmLabel={t("service.remove")}
        destructive
        onConfirm={() => remove.mutateAsync({ serviceId: service.id, policyId: p.id }).then(() => undefined)}
      />
    </>
  );
}

function RunsCard({ service }: { service: ServiceDetail }) {
  const [before, setBefore] = useState<string[]>([]);
  const first = useOp(
    backups.listRuns,
    { serviceId: service.id, limit: 50 },
    { retry: retryOp, refetchInterval: (q) => (q.state.data?.runs.some((r) => r.status === "running") ? 3000 : false) },
  );
  const restoring = useRunDialog();
  const deleting = useRunDialog();
  const [backupFirst, setBackupFirst] = useState(true);
  const invalidate = useInvalidate();
  const restore = useOpMutation(backups.restore, {
    onSuccess: () => {
      invalidate(backups.listRuns);
      toast.success(t("serviceBackups.restoreStarted"));
    },
  });
  const remove = useOpMutation(backups.deleteRun, { onSuccess: () => invalidate(backups.listRuns) });
  const download = useOpMutation(backups.downloadUrl, { onSuccess: (link) => openDownload(link.url), onError: fail });
  const downloadRun = (r: Run) => download.mutate({ serviceId: service.id, runId: r.id });
  // A restore of some tables names them: what the backup holds.
  const held = useOp(
    backups.runContents,
    { serviceId: service.id, runId: restoring.run?.id ?? "" },
    { enabled: restoring.run?.scope === "tables", retry: retryOp },
  );
  const lastPage = before[before.length - 1];
  const older = useOp(
    backups.listRuns,
    { serviceId: service.id, limit: 50, before: lastPage ?? "" },
    { enabled: !!lastPage, retry: retryOp },
  );
  const runs = first.data?.runs ?? [];
  const more = lastPage ? older.data?.hasMore : first.data?.hasMore;
  const oldest = (lastPage ? older.data?.runs : runs)?.at(-1);

  return (
    <Card className="gap-0 overflow-hidden p-0" aria-label={t("serviceBackups.runs")}>
      <div className="flex items-center px-5 pt-4 pb-3.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("serviceBackups.runs")}</h2>
      </div>
      {first.isPending ? (
        <RowsSkeleton rows={4} lead="dot" lines={1} width="w-24" className="py-2.5" />
      ) : first.isError ? (
        <OpErrorNote error={first.error} className="mx-5 mb-4" />
      ) : runs.length === 0 ? (
        <div className="border-t border-divider">
          <EmptyState compact title={t("serviceBackups.noRuns")} />
        </div>
      ) : (
        <>
          {runs.map((r) => (
            <RunRow
              key={r.id}
              service={service}
              run={r}
              onRestore={() => restoring.show(r)}
              onDownload={() => downloadRun(r)}
              onDelete={() => deleting.show(r)}
            />
          ))}
          {before.map((b) => (
            <OlderRuns key={b} service={service} before={b} onRestore={restoring.show} onDownload={downloadRun} onDelete={deleting.show} />
          ))}
          {more && oldest && (
            <div className="flex justify-center border-t border-divider py-3">
              <Button size="sm" onClick={() => setBefore((x) => [...x, oldest.startedAt])}>
                {t("serviceBackups.older")}
              </Button>
            </div>
          )}
        </>
      )}
      {/* A failed restore or delete shows its message in the dialog, which stays open (ConfirmDialog). */}
      <ConfirmDialog
        open={restoring.open}
        onOpenChange={restoring.onOpenChange}
        title={t("serviceBackups.restoreTitle", { when: restoring.run ? formatDateTime(restoring.run.startedAt) : "" })}
        description={
          restoring.run
            ? restoreText(
                restoring.run,
                service,
                formatDateTime(restoring.run.startedAt),
                held.data?.contents?.databases[0]?.tablesTruncated ? null : held.data?.contents?.databases[0]?.tables,
              )
            : ""
        }
        confirmText={service.name}
        confirmLabel={t("serviceBackups.restore")}
        destructive
        onConfirm={() =>
          restoring.run
            ? restore
                .mutateAsync({ serviceId: service.id, runId: restoring.run.id, confirmName: service.name, backupFirst })
                .then(() => undefined)
            : undefined
        }
      >
        {restoring.run && restoring.run.scope !== null && restoring.run.scope !== "everything" && (
          <RunChips chips={runChips(restoring.run, service.kind).filter((c) => c.key !== "skipped")} label={t("serviceBackups.holds")} />
        )}
        <CheckLabel
          className="flex items-center gap-2 text-[13px]"
          checked={backupFirst}
          onCheckedChange={(v) => setBackupFirst(v === true)}
        >
          {t("serviceBackups.backupFirst")}
        </CheckLabel>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting.open}
        onOpenChange={deleting.onOpenChange}
        {...deleteRunCopy(deleting.run)}
        destructive
        onConfirm={() => {
          const asked = deleting.run;
          if (!asked) return undefined;
          return remove.mutateAsync({ serviceId: service.id, runId: asked.id }).then((done) => {
            if (fileKept(asked, done)) toast.warning(t("serviceBackups.fileKept"));
          });
        }}
      />
    </Card>
  );
}

/**
 * Opens a backup's download link: a plain navigation to the bucket, whose
 * answer is an attachment (response-content-disposition), so the page
 * stays and the bucket needs no CORS for the panel.
 */
function openDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** A dialog about one run. The run stays set while the dialog closes, so its words do not change on the way out. */
function useRunDialog() {
  const [run, setRun] = useState<Run | null>(null);
  const [open, setOpen] = useState(false);
  const show = (r: Run) => {
    setRun(r);
    setOpen(true);
  };
  return { run, open, show, onOpenChange: setOpen };
}

function OlderRuns({
  service,
  before,
  onRestore,
  onDownload,
  onDelete,
}: {
  service: ServiceDetail;
  before: string;
  onRestore: (r: Run) => void;
  onDownload: (r: Run) => void;
  onDelete: (r: Run) => void;
}) {
  const page = useOp(backups.listRuns, { serviceId: service.id, limit: 50, before }, { retry: retryOp });
  return (
    <>
      {page.data?.runs.map((r) => (
        <RunRow
          key={r.id}
          service={service}
          run={r}
          onRestore={() => onRestore(r)}
          onDownload={() => onDownload(r)}
          onDelete={() => onDelete(r)}
        />
      ))}
    </>
  );
}
