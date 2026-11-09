// Cron jobs of an app (the Cron jobs tab) and the runs list, which is also
// the overview of a cron service. Jobs run in one-off containers from the
// service's image on its node, so they keep running while the panel is down.

import { cron, type OpOutput } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip } from "@seylo/ui/components/chip";
import { CodeBlock, CopyCode } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DataTable } from "@seylo/ui/components/data-table";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconDots, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { describeCron, schedulePresets } from "../cron-text";
import { Field, parseIntOrNull } from "../field";
import { formatDateTime, formatDuration, formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, MutationError, OpErrorNote, retryOp } from "../op-state";
import { RowsSkeleton } from "../service-skeletons";
import type { ServiceDetail } from "../use-service";

type Job = OpOutput<typeof cron.list>["jobs"][number];
type Run = OpOutput<typeof cron.runs>["runs"][number];
const resultTone = { running: "amber", succeeded: "green", failed: "red", timed_out: "red", skipped: "gray" } as const;
const fail = (error: unknown) =>
  toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

export function CronJobsPage({ service }: { service: ServiceDetail }) {
  const jobs = useOp(cron.list, { serviceId: service.id }, { retry: retryOp });
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-0 overflow-hidden p-0" aria-label={t("serviceCron.jobs")}>
        <div className="flex flex-wrap items-center gap-2.5 px-5 pt-4 pb-3.5">
          <h2 className="m-0 text-[15px] font-semibold">{t("serviceCron.jobs")}</h2>
          <span className="text-[12.5px] text-muted-foreground">{t("serviceCron.jobsHint")}</span>
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => setEditing("new")}>
            <IconPlus size={14} />
            {t("serviceCron.add")}
          </Button>
        </div>
        {jobs.isPending ? (
          <RowsSkeleton rows={1} lead="switch" width="w-28" />
        ) : jobs.isError ? (
          <OpErrorNote error={jobs.error} className="mx-5 mb-4" />
        ) : jobs.data.jobs.length === 0 ? (
          <div className="border-t border-divider">
            <EmptyState compact title={t("serviceCron.none")} description={t("serviceCron.noneHint")} />
          </div>
        ) : (
          jobs.data.jobs.map((j) => <JobRow key={j.id} service={service} job={j} onEdit={() => setEditing(j)} />)
        )}
      </Card>
      <CronRuns service={service} />
      {editing && <JobDialog service={service} job={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function JobRow({ service, job: j, onEdit }: { service: ServiceDetail; job: Job; onEdit: () => void }) {
  const invalidate = useInvalidate();
  const [confirm, setConfirm] = useState(false);
  const update = useOpMutation(cron.update, { onSuccess: () => invalidate(cron.list), onError: fail });
  const run = useOpMutation(cron.runNow, {
    onSuccess: () => {
      invalidate(cron.runs, cron.list);
      toast.success(t("serviceCron.started"));
    },
    onError: fail,
  });
  const remove = useOpMutation(cron.remove, { onSuccess: () => invalidate(cron.list) });
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-3 text-[13px]">
      <Switch
        size="sm"
        checked={j.enabled}
        onCheckedChange={(enabled) => update.mutate({ serviceId: service.id, cronJobId: j.id, enabled })}
        aria-label={t("serviceCron.enabled")}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <b className="font-semibold">{j.name}</b>
        <span className="text-[12.5px] text-ink-strong">
          {describeCron(j.schedule)} · {j.timeZone}
        </span>
      </span>
      {j.command && <CopyCode code={j.command} aria-label={t("serviceCron.command")} />}
      <span className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {j.lastRun && <Chip tone={resultTone[j.lastRun.result]}>{t(`serviceCron.result.${j.lastRun.result}`)}</Chip>}
        {j.enabled && j.nextRunAt && <span>{t("serviceBackups.next", { when: formatRelative(j.nextRunAt) })}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={t("serviceCron.actions", { name: j.name })}>
              <IconDots size={15} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => run.mutate({ serviceId: service.id, cronJobId: j.id })}>
              {t("serviceCron.runNow")}
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
        title={t("serviceCron.removeTitle", { name: j.name })}
        description={t("serviceCron.removeBody")}
        confirmLabel={t("service.remove")}
        destructive
        onConfirm={() => remove.mutateAsync({ serviceId: service.id, cronJobId: j.id }).then(() => undefined)}
      />
    </div>
  );
}

const custom = "__custom__";

function JobDialog({ service, job, onClose }: { service: ServiceDetail; job: Job | null; onClose: () => void }) {
  const [name, setName] = useState(job?.name ?? "");
  const [schedule, setSchedule] = useState(job?.schedule ?? "0 3 * * *");
  const [preset, setPreset] = useState<string>(
    (schedulePresets as readonly string[]).includes(job?.schedule ?? "0 3 * * *") ? (job?.schedule ?? "0 3 * * *") : custom,
  );
  const [timeZone, setTimeZone] = useState(job?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  const [command, setCommand] = useState(job?.command ?? "");
  const [timeout, setTimeoutSeconds] = useState(String(job?.timeoutSeconds ?? 3600));
  const [concurrency, setConcurrency] = useState<Job["concurrency"]>(job?.concurrency ?? "forbid");
  const invalidate = useInvalidate();
  const done = () => {
    invalidate(cron.list);
    toast.success(t("service.saved"));
    onClose();
  };
  const create = useOpMutation(cron.create, { onSuccess: done });
  const update = useOpMutation(cron.update, { onSuccess: done });
  const timeoutSeconds = parseIntOrNull(timeout) ?? 3600;
  const valid = name.trim() && command.trim() && schedule.trim();
  const submit = () => {
    const fields = { name: name.trim(), schedule: schedule.trim(), timeZone, command: command.trim(), timeoutSeconds, concurrency };
    if (job) update.mutate({ serviceId: service.id, cronJobId: job.id, ...fields });
    else create.mutate({ serviceId: service.id, ...fields });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[8%]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{job ? t("serviceCron.edit") : t("serviceCron.add")}</DialogTitle>
            <DialogDescription>{t("serviceCron.dialogBody")}</DialogDescription>
          </div>
          <Field label={t("serviceCron.name")} htmlFor="cj-name">
            <Input id="cj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("serviceCron.namePlaceholder")} />
          </Field>
          <Field label={t("serviceCron.command")} htmlFor="cj-cmd" hint={t("serviceCron.commandHint")}>
            <Input
              id="cj-cmd"
              className="font-mono"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="bun run cleanup"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("serviceCron.schedule")} hint={preset === custom ? describeCron(schedule) : undefined}>
              <Select
                value={preset}
                onValueChange={(v) => {
                  setPreset(v);
                  if (v !== custom) setSchedule(v);
                }}
              >
                <SelectTrigger aria-label={t("serviceCron.schedule")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {schedulePresets.map((p) => (
                    <SelectItem key={p} value={p}>
                      {describeCron(p)}
                    </SelectItem>
                  ))}
                  <SelectItem value={custom}>{t("serviceBackups.custom")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("serviceCron.timeZone")} htmlFor="cj-tz">
              <Input id="cj-tz" className="font-mono" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
            </Field>
          </div>
          {preset === custom && (
            <Field label={t("serviceBackups.cron")} htmlFor="cj-cron">
              <Input id="cj-cron" className="font-mono" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("serviceCron.timeout")} htmlFor="cj-timeout">
              <Input id="cj-timeout" inputMode="numeric" value={timeout} onChange={(e) => setTimeoutSeconds(e.target.value)} />
            </Field>
            <Field label={t("serviceCron.concurrency")}>
              <Select value={concurrency} onValueChange={(v) => setConcurrency(v as Job["concurrency"])}>
                <SelectTrigger aria-label={t("serviceCron.concurrency")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["forbid", "allow", "replace"] as const).map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(`serviceCron.concurrencyOptions.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <MutationError error={create.error ?? update.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!valid || create.isPending || update.isPending}>
              {t("service.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Runs of a service's cron jobs (or of a cron service), newest first; click one for its output. */
export function CronRuns({ service }: { service: ServiceDetail }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const runs = useOp(
    cron.runs,
    { serviceId: service.id, limit: 50, ...(cursor ? { cursor } : {}) },
    { retry: retryOp, refetchInterval: (q) => (q.state.data?.runs.some((r) => r.result === "running") ? 3000 : false) },
  );
  const jobs = useOp(cron.list, { serviceId: service.id }, { retry: retryOp });
  const [open, setOpen] = useState<Run | null>(null);
  const jobName = (id: string | null) => (id ? (jobs.data?.jobs.find((j) => j.id === id)?.name ?? "") : service.name);
  return (
    <Card className="gap-0 overflow-hidden p-0" aria-label={t("serviceCron.runs")}>
      <div className="flex items-center gap-2 px-5 pt-4 pb-3.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("serviceCron.runs")}</h2>
        {cursor && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setCursor(undefined)}>
            {t("serviceCron.newest")}
          </Button>
        )}
      </div>
      {runs.isPending ? (
        <RowsSkeleton rows={3} lead="none" lines={1} width="w-64" action={false} />
      ) : runs.isError ? (
        <OpErrorNote error={runs.error} className="mx-5 mb-4" />
      ) : (
        <>
          <DataTable
            bare
            aria-label={t("serviceCron.runs")}
            rows={runs.data.runs}
            getRowId={(r) => r.id}
            onRowClick={setOpen}
            empty={<EmptyState compact title={t("serviceCron.noRuns")} />}
            columns={[
              {
                id: "result",
                header: t("serviceCron.resultLabel"),
                cell: (r) => <Chip tone={resultTone[r.result]}>{t(`serviceCron.result.${r.result}`)}</Chip>,
              },
              {
                id: "job",
                header: t("serviceCron.name"),
                cell: (r) => (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {jobName(r.cronJobId)}
                    {r.manual && <Chip tone="gray">{t("serviceCron.manual")}</Chip>}
                  </span>
                ),
              },
              {
                id: "started",
                header: t("serviceCron.started"),
                className: "whitespace-nowrap",
                cell: (r) => formatDateTime(r.startedAt),
                sortValue: (r) => r.startedAt,
              },
              // Took stays the last column at every width, so a phone row keeps the card's right padding.
              {
                id: "exit",
                header: t("serviceCron.exitCode"),
                align: "right",
                hideOnMobile: true,
                cell: (r) => (r.exitCode ?? "").toString(),
              },
              {
                id: "took",
                header: t("serviceCron.took"),
                align: "right",
                className: "whitespace-nowrap",
                cell: (r) => (r.durationMs != null ? formatDuration(r.durationMs) : ""),
              },
            ]}
          />
          {runs.data.nextCursor && (
            <div className="flex justify-center border-t border-divider py-3">
              <Button size="sm" onClick={() => setCursor(runs.data.nextCursor ?? undefined)}>
                {t("serviceCron.older")}
              </Button>
            </div>
          )}
        </>
      )}
      {open && <RunOutput service={service} run={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function RunOutput({ service, run, onClose }: { service: ServiceDetail; run: Run; onClose: () => void }) {
  const detail = useOp(cron.run, { serviceId: service.id, runId: run.id }, { retry: retryOp });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[8%] flex max-w-3xl flex-col gap-3">
        <DialogTitle>{t("serviceCron.runTitle", { when: formatDateTime(run.startedAt) })}</DialogTitle>
        {detail.isPending ? (
          <Skeleton className="h-48" />
        ) : detail.isError ? (
          <OpErrorNote error={detail.error} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <Chip tone={resultTone[detail.data.run.result]}>{t(`serviceCron.result.${detail.data.run.result}`)}</Chip>
              {detail.data.command && <CopyCode code={detail.data.command} aria-label={t("serviceCron.command")} />}
              {detail.data.run.exitCode != null && (
                <span className="text-muted-foreground">{t("serviceCron.exit", { code: detail.data.run.exitCode })}</span>
              )}
            </div>
            {detail.data.truncated && <span className="text-xs text-muted-foreground">{t("serviceCron.truncated")}</span>}
            <CodeBlock code={detail.data.output || t("serviceCron.noOutput")} tone="dark" maxHeight={420} title={t("serviceCron.output")} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
