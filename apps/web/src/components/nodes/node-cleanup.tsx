// The Cleanup view of the node sheet: the cleanup the node runs by itself
// (a cron expression in the node's time zone, a disk line, what to remove)
// and its recent cleanups with the space they freed. Scheduled and
// disk-triggered runs happen on the node, also while the panel is down,
// and arrive here once it is back. Manual cleanups (Settings > Docker
// cleanup) are listed too.

import { cleanup, type OpInput, type OpOutput } from "@seylo/ops";
import { opQueryKey, useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input, Label } from "@seylo/ui/components/input";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconRecycle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage, queryClient } from "../../lib/api";
import { formatAgo, formatBytes, formatExpiresIn } from "../../lib/format";
import { QueryError } from "../query-error";

type ScheduleData = OpOutput<typeof cleanup.getSchedule>;
type Schedule = OpInput<typeof cleanup.setSchedule>["schedule"];
type Run = OpOutput<typeof cleanup.runs>["runs"][number];
const kinds = ["images", "buildCache", "stoppedContainers", "unusedVolumes"] as const;

export function NodeCleanup({ nodeId }: { nodeId: string }) {
  const schedule = useOp(cleanup.getSchedule, { nodeId });
  const runs = useOp(cleanup.runs, { nodeId, limit: 20 });
  return (
    <div className="flex flex-col gap-6">
      {schedule.isError ? (
        <QueryError error={schedule.error} onRetry={() => void schedule.refetch()} />
      ) : schedule.isPending ? (
        <ScheduleSkeleton />
      ) : (
        <ScheduleForm key={JSON.stringify(schedule.data.schedule)} nodeId={nodeId} data={schedule.data} />
      )}
      <section aria-label={t("nodeCleanup.runs")} aria-busy={runs.isPending} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="m-0 text-sm font-semibold">{t("nodeCleanup.runs")}</h3>
          {runs.data && runs.data.bytesFreed30d > 0 && (
            <span className="text-xs text-muted-foreground">
              {t("nodeCleanup.freed30d", { size: formatBytes(runs.data.bytesFreed30d) })}
            </span>
          )}
        </div>
        {runs.isError ? (
          <QueryError error={runs.error} onRetry={() => void runs.refetch()} />
        ) : runs.isPending ? (
          <RunsSkeleton />
        ) : runs.data.runs.length === 0 ? (
          <EmptyState compact icon={<IconRecycle />} title={t("nodeCleanup.noRuns")} description={t("nodeCleanup.noRunsHint")} />
        ) : (
          <ul aria-label={t("nodeCleanup.runs")} className="m-0 flex list-none flex-col p-0">
            {runs.data.runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ScheduleForm({ nodeId, data }: { nodeId: string; data: ScheduleData }) {
  const saved = data.schedule;
  const [enabled, setEnabled] = useState(saved.enabled);
  const [useCron, setUseCron] = useState(saved.cron !== null);
  const [cron, setCron] = useState(saved.cron ?? "0 4 * * *");
  const [useDisk, setUseDisk] = useState(saved.diskPercent !== null);
  const [disk, setDisk] = useState(String(saved.diskPercent ?? 80));
  const [picked, setPicked] = useState(saved.kinds);
  const save = useOpMutation(cleanup.setSchedule, {
    onSuccess: () => {
      toast.success(t("nodeCleanup.saved"));
      // The live socket refreshes it too; this covers a socket that is down.
      void queryClient.invalidateQueries({ queryKey: opQueryKey(cleanup.getSchedule, { nodeId }) });
    },
  });

  const next: Schedule = {
    enabled,
    cron: useCron ? cron.trim() : null,
    diskPercent: useDisk ? Number(disk) : null,
    kinds: picked,
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ nodeId, schedule: next });
  };

  return (
    <form onSubmit={submit} aria-label={t("nodeCleanup.schedule")} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-sm font-semibold">{t("nodeCleanup.schedule")}</h3>
        <p className="m-0 text-[12.5px] text-muted-foreground">{t("nodeCleanup.scheduleHint")}</p>
      </div>
      {!data.supported && <Alert tone="warning">{t("nodeCleanup.oldAgent")}</Alert>}
      <label htmlFor="cleanup-enabled" className="flex cursor-pointer items-start gap-3">
        <Switch id="cleanup-enabled" checked={enabled} onCheckedChange={setEnabled} className="mt-0.5" />
        <span className="flex flex-col gap-0.5">
          <span className="text-[13.5px] font-medium">{t("nodeCleanup.enabled")}</span>
          {!saved.enabled && <span className="text-[12.5px] text-muted-foreground">{t("nodeCleanup.enabledHint")}</span>}
        </span>
      </label>

      <div className="flex flex-col gap-2 rounded-control bg-raised p-3">
        <label htmlFor="cleanup-use-cron" className="flex cursor-pointer items-center gap-2.5">
          <Checkbox id="cleanup-use-cron" checked={useCron} onCheckedChange={(v) => setUseCron(v === true)} />
          <span className="text-[13px] font-medium">{t("nodeCleanup.onSchedule")}</span>
        </label>
        <div className="flex flex-wrap items-center gap-2 pl-6.5">
          <Label htmlFor="cleanup-cron" className="sr-only">
            {t("nodeCleanup.cron")}
          </Label>
          <Input
            id="cleanup-cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            disabled={!useCron}
            maxLength={120}
            className="w-44 font-mono"
            spellCheck={false}
          />
          {data.nextRunAt && enabled && useCron && cron.trim() === saved.cron && (
            <span className="text-xs text-muted-foreground">{t("nodeCleanup.nextRun", { when: formatExpiresIn(data.nextRunAt) })}</span>
          )}
        </div>
        <span className="pl-6.5 text-xs text-muted-foreground">
          {t("nodeCleanup.cronHint", { zone: data.timeZone ?? t("nodeCleanup.unknownZone") })}
        </span>
      </div>

      <div className="flex flex-col gap-2 rounded-control bg-raised p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <label htmlFor="cleanup-use-disk" className="flex cursor-pointer items-center gap-2.5">
            <Checkbox id="cleanup-use-disk" checked={useDisk} onCheckedChange={(v) => setUseDisk(v === true)} />
            <span className="text-[13px] font-medium">{t("nodeCleanup.onDisk")}</span>
          </label>
          <Input
            id="cleanup-disk"
            aria-label={t("nodeCleanup.percent")}
            type="number"
            min={50}
            max={99}
            value={disk}
            onChange={(e) => setDisk(e.target.value)}
            disabled={!useDisk}
            className="w-20"
          />
          <span className="text-[13px] text-muted-foreground">%</span>
        </div>
        <span className="pl-6.5 text-xs text-muted-foreground">{t("nodeCleanup.diskHint")}</span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-ink-strong">{t("nodeCleanup.what")}</span>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {kinds.map((kind) => (
            <label
              key={kind}
              htmlFor={`cleanup-kind-${kind}`}
              className="flex cursor-pointer items-start gap-2.5 rounded-control bg-raised p-3 transition-colors duration-200 hover:bg-muted"
            >
              <Checkbox
                id={`cleanup-kind-${kind}`}
                className="mt-0.5"
                checked={picked[kind]}
                onCheckedChange={(v) => setPicked({ ...picked, [kind]: v === true })}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium">{t(`nodeCleanup.kinds.${kind}.name`)}</span>
                <span className="text-xs text-muted-foreground">{t(`nodeCleanup.kinds.${kind}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      {picked.unusedVolumes && <Alert tone="warning">{t("nodeCleanup.volumesWarning")}</Alert>}
      {save.error && <Alert tone="danger">{errorMessage(save.error, t("common.unknownError"))}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {t("nodeCleanup.manual")}{" "}
          <Link to="/settings/cleanup" className="font-medium transition-colors duration-200">
            {t("nodeCleanup.manualLink")}
          </Link>
        </span>
        <Button type="submit" variant="primary" className="ml-auto" disabled={!dirty || save.isPending}>
          {t("nodeCleanup.save")}
        </Button>
      </div>
    </form>
  );
}

function triggerLabel(run: Run): string {
  if (run.trigger === "disk") {
    return run.diskPercent !== null ? t("nodeCleanup.trigger.disk", { percent: run.diskPercent }) : t("nodeCleanup.trigger.diskUnknown");
  }
  if (run.trigger === "manual")
    return run.startedBy ? t("nodeCleanup.trigger.manualBy", { name: run.startedBy }) : t("nodeCleanup.trigger.manual");
  return t("nodeCleanup.trigger.schedule");
}

function RunRow({ run }: { run: Run }) {
  const failed = run.status === "failed";
  const hidden = run.removedCount - run.lines.length;
  return (
    <li className="flex flex-col gap-1.5 border-t border-divider py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={run.trigger === "disk" ? "amber" : run.trigger === "manual" ? "gray" : "blue"}>{triggerLabel(run)}</Chip>
        {failed ? (
          <Chip tone="red">{t("nodeCleanup.status.failed")}</Chip>
        ) : (
          <span className="font-medium">{t("nodeCleanup.freed", { size: formatBytes(run.bytesFreed) })}</span>
        )}
        {run.removedCount > 0 && <span className="text-muted-foreground">{t("nodeCleanup.items", { count: run.removedCount })}</span>}
        <time dateTime={run.startedAt} className="ml-auto text-xs text-muted-foreground">
          {formatAgo(run.startedAt)}
        </time>
      </div>
      {run.error && <span className="text-[12.5px] text-chip-red-fg">{run.error}</span>}
      {run.lines.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground">
            {t("nodeCleanup.details")}
          </summary>
          <ul className="m-0 mt-1.5 flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-control bg-raised p-3 pl-7 font-mono text-xs text-ink-strong">
            {run.lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat; their order is the identity.
              <li key={i}>{line}</li>
            ))}
            {hidden > 0 && <li className="list-none text-muted-foreground">{t("nodeCleanup.moreLines", { count: hidden })}</li>}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Shaped like the form: the switch, the two trigger boxes and the four kinds. */
function ScheduleSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label={t("nodeCleanup.loading")} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3 w-80 max-w-full" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-5 w-9 rounded-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-[92px]" />
      <Skeleton className="h-[68px]" />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {kinds.map((kind) => (
          <Skeleton key={kind} className="h-[62px]" />
        ))}
      </div>
    </div>
  );
}

function RunsSkeleton() {
  return (
    <div className="flex flex-col">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-2 border-t border-divider py-3">
          <Skeleton className="h-5 w-20 rounded-chip" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
      ))}
    </div>
  );
}
