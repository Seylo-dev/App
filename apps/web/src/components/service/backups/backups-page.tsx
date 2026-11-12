// The Backups tab (also on database pages): schedules of the database or a
// volume to an S3/R2 destination, "Back up now", the run history with
// restore (type the name to confirm) and delete. A failed restore or
// delete says why inside its dialog, which stays open; nothing is left on
// the card after it closes.

import { backups, type OpOutput } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconDots, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { describeCron } from "../cron-text";
import { CheckLabel } from "../field";
import { volumesOf } from "../files/volumes";
import { formatDateTime, formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, OpErrorNote, retryOp } from "../op-state";
import { RowsSkeleton } from "../service-skeletons";
import { isDatabaseKind } from "../status";
import type { ServiceDetail } from "../use-service";
import { PolicyDialog } from "./policy-dialog";
import { deleteRunCopy, fileKept, type Run, RunRow } from "./run-row";

type Policy = OpOutput<typeof backups.listPolicies>["policies"][number];

const fail = (error: unknown) =>
  toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

export function BackupsPage({ service }: { service: ServiceDetail }) {
  const policies = useOp(backups.listPolicies, { serviceId: service.id }, { retry: retryOp });
  const destinations = useOp(backups.listDestinations, {}, { retry: retryOp });
  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  const invalidate = useInvalidate();
  const runNow = useOpMutation(backups.runNow, {
    onSuccess: () => {
      invalidate(backups.listRuns, backups.listPolicies);
      toast.success(t("serviceBackups.started"));
    },
    onError: fail,
  });
  const choices = destinations.data?.choices ?? [];
  const list = policies.data?.policies ?? [];
  const isDb = isDatabaseKind(service.kind);
  const canVolume = volumesOf(service).length > 0;
  const canCreate = choices.length > 0 && (isDb || canVolume);

  const backUpNow = () => {
    const first = list[0];
    if (first) return runNow.mutate({ serviceId: service.id, policyId: first.id });
    const destination = choices[0];
    if (destination && isDb) runNow.mutate({ serviceId: service.id, target: "database", destinationId: destination.id });
  };

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
            <Button size="sm" onClick={backUpNow} disabled={runNow.isPending || (list.length === 0 && !(isDb && choices.length > 0))}>
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
    onError: fail,
  });
  const remove = useOpMutation(backups.deletePolicy, { onSuccess: () => invalidate(backups.listPolicies) });
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-3 text-[13px]">
      <Switch
        size="sm"
        checked={p.enabled}
        onCheckedChange={(enabled) => update.mutate({ serviceId: service.id, policyId: p.id, enabled })}
        aria-label={t("serviceBackups.enabled")}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <b className="font-semibold">
          {p.target === "database" ? t("serviceBackups.database") : t("serviceBackups.volume", { name: p.volumeName ?? "" })}
        </b>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={t("serviceBackups.actions")}>
              <IconDots size={15} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => run.mutate({ serviceId: service.id, policyId: p.id })}>
              {t("serviceBackups.backUpNow")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>{t("service.edit")}</DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={() => setConfirm(true)}>
              {t("service.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("serviceBackups.removeTitle")}
        description={t("serviceBackups.removeBody")}
        confirmLabel={t("service.remove")}
        destructive
        onConfirm={() => remove.mutateAsync({ serviceId: service.id, policyId: p.id }).then(() => undefined)}
      />
    </div>
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
            <RunRow key={r.id} run={r} onRestore={() => restoring.show(r)} onDelete={() => deleting.show(r)} />
          ))}
          {before.map((b) => (
            <OlderRuns key={b} serviceId={service.id} before={b} onRestore={restoring.show} onDelete={deleting.show} />
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
        description={t("serviceBackups.restoreBody", { name: service.name })}
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
  serviceId,
  before,
  onRestore,
  onDelete,
}: {
  serviceId: string;
  before: string;
  onRestore: (r: Run) => void;
  onDelete: (r: Run) => void;
}) {
  const page = useOp(backups.listRuns, { serviceId, limit: 50, before }, { retry: retryOp });
  return (
    <>
      {page.data?.runs.map((r) => (
        <RunRow key={r.id} run={r} onRestore={() => onRestore(r)} onDelete={() => onDelete(r)} />
      ))}
    </>
  );
}
