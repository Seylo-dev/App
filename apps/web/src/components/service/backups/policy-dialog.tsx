// Add or change a backup schedule: what (the database, or a volume), where
// (a destination), when (a preset or a cron expression in UTC), how many to
// keep, and for volumes whether to stop the service while copying.

import { backups, type OpOutput } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { describeCron, schedulePresets } from "../cron-text";
import { Field, parseIntOrNull, ToggleRow } from "../field";
import { volumesOf } from "../files/volumes";
import { useInvalidate } from "../invalidate";
import { MutationError } from "../op-state";
import { isDatabaseKind } from "../status";
import type { ServiceDetail } from "../use-service";

type Policy = OpOutput<typeof backups.listPolicies>["policies"][number];
type Choice = OpOutput<typeof backups.listDestinations>["choices"][number];
const custom = "__custom__";
const cronPattern = /^\S+( \S+){4}$/;

export function PolicyDialog({
  service,
  policy,
  choices,
  onClose,
}: {
  service: ServiceDetail;
  policy: Policy | null;
  choices: Choice[];
  onClose: () => void;
}) {
  const isDb = isDatabaseKind(service.kind);
  const volumes = volumesOf(service);
  const [target, setTarget] = useState<string>(
    policy ? (policy.target === "database" ? "database" : (policy.volumeId ?? "")) : isDb ? "database" : (volumes[0]?.id ?? ""),
  );
  const [destinationId, setDestination] = useState(policy?.destinationId ?? choices[0]?.id ?? "");
  const [schedule, setSchedule] = useState(policy?.schedule ?? "0 3 * * *");
  const [preset, setPreset] = useState<string>(
    (schedulePresets as readonly string[]).includes(policy?.schedule ?? "0 3 * * *") ? (policy?.schedule ?? "0 3 * * *") : custom,
  );
  const [keepLast, setKeepLast] = useState(String(policy?.keepLast ?? 14));
  const [stopService, setStopService] = useState(policy?.stopService ?? false);
  const invalidate = useInvalidate();
  const done = () => {
    invalidate(backups.listPolicies);
    toast.success(t("service.saved"));
    onClose();
  };
  const create = useOpMutation(backups.createPolicy, { onSuccess: done });
  const update = useOpMutation(backups.updatePolicy, { onSuccess: done });
  const keep = parseIntOrNull(keepLast);
  const valid = destinationId && cronPattern.test(schedule.trim()) && keep !== null && keep >= 1 && target;
  const isVolume = target !== "database";

  const submit = () => {
    if (!valid || keep === null) return;
    if (policy)
      update.mutate({ serviceId: service.id, policyId: policy.id, destinationId, schedule: schedule.trim(), keepLast: keep, stopService });
    else
      create.mutate({
        serviceId: service.id,
        target: isVolume ? "volume" : "database",
        ...(isVolume ? { volumeId: target } : {}),
        destinationId,
        schedule: schedule.trim(),
        keepLast: keep,
        stopService: isVolume && stopService,
      });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[10%]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{policy ? t("serviceBackups.editSchedule") : t("serviceBackups.addSchedule")}</DialogTitle>
            <DialogDescription>{t("serviceBackups.scheduleBody")}</DialogDescription>
          </div>
          <Field label={t("serviceBackups.what")}>
            <Select value={target} onValueChange={setTarget} disabled={policy !== null}>
              <SelectTrigger aria-label={t("serviceBackups.what")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {isDb && <SelectItem value="database">{t("serviceBackups.database")}</SelectItem>}
                {volumes.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {t("serviceBackups.volume", { name: v.name })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("serviceBackups.where")}>
            <Select value={destinationId} onValueChange={setDestination}>
              <SelectTrigger aria-label={t("serviceBackups.where")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {c.bucket}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("serviceBackups.when")} hint={preset === custom ? describeCron(schedule) : t("serviceBackups.utc")}>
              <Select
                value={preset}
                onValueChange={(v) => {
                  setPreset(v);
                  if (v !== custom) setSchedule(v);
                }}
              >
                <SelectTrigger aria-label={t("serviceBackups.when")}>
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
            <Field label={t("serviceBackups.keep")} htmlFor="b-keep">
              <Input id="b-keep" inputMode="numeric" value={keepLast} onChange={(e) => setKeepLast(e.target.value)} />
            </Field>
          </div>
          {preset === custom && (
            <Field label={t("serviceBackups.cron")} htmlFor="b-cron">
              <Input
                id="b-cron"
                className="font-mono"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                aria-invalid={!cronPattern.test(schedule.trim())}
              />
            </Field>
          )}
          {isVolume && (
            <ToggleRow
              title={t("serviceBackups.stopService")}
              description={t("serviceBackups.stopServiceHint")}
              control={<Switch checked={stopService} onCheckedChange={setStopService} aria-label={t("serviceBackups.stopService")} />}
            />
          )}
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
