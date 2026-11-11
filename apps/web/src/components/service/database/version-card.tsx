// The Version card of a database's Settings tab: what the database runs,
// the catalog versions it may change to (databases.versionChoices; refused
// ones are disabled with their reason), and the confirm dialog: the
// restart, no way back, a backup first and MongoDB's compatibility step.
// While the change deploys the card shows the deploy and its log.

import { backups, databases, deployments, type OpOutput, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { KeyValue } from "@seylo/ui/components/key-value";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { toast } from "@seylo/ui/components/toast";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { shortImage } from "../../new-service/short-image";
import { useActiveDeploy } from "../active-deploy";
import { DeployLogModal } from "../deploy-log-modal";
import { Field } from "../field";
import { formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import { DeploymentStatusChip } from "../status-chip";
import type { ServiceDetail } from "../use-service";

type Choices = OpOutput<typeof databases.versionChoices>;
type Choice = Choices["choices"][number];

/** The card's id: the version chip in the service header links here. */
export const versionCardId = "version";

/** The repository of an image, for the custom tag hint: "mongo" of "mongo:8.0.34". */
function repositoryOf(image: string): string {
  return image.replace(/@.*$/, "").replace(/:[^/:]*$/, "");
}

function choiceLabel(c: Choice, newest: string): string {
  const version = c.version === newest ? t("databaseVersion.newest", { version: c.version }) : c.version;
  return `${version} · ${t(`databaseVersion.kind.${c.kind}`, { image: c.image })}`;
}

export function VersionCard({ service }: { service: ServiceDetail }) {
  const active = useActiveDeploy(service.id);
  const choices = useOp(
    databases.versionChoices,
    { serviceId: service.id },
    // The deploy's own events refresh deployments.list; this follows until it is done.
    { retry: retryOp, refetchInterval: (q) => (q.state.data?.blocked?.reason === "deployRunning" ? 5000 : false) },
  );
  const [picked, setPicked] = useState("");
  const [confirming, setConfirming] = useState<Choice | null>(null);
  const [log, setLog] = useState(false);
  const refetch = choices.refetch;
  const activeId = active?.id ?? null;
  // A deploy that starts or ends changes what may be picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId is the trigger, not an input
  useEffect(() => {
    void refetch();
  }, [activeId, refetch]);

  if (choices.isPending) return <SectionCardSkeleton titleWidth="w-20" description="w-80" />;
  if (choices.isError) {
    return (
      <SectionCard id={versionCardId} title={t("databaseVersion.title")}>
        <OpErrorNote error={choices.error} />
      </SectionCard>
    );
  }
  const data = choices.data;
  const newest = data.choices[0]?.version ?? "";
  const options = data.choices.filter((c) => c.kind !== "current" || c.allowed);
  const selected = options.find((c) => `${c.version}|${c.image}` === picked) ?? null;
  const running = data.blocked?.reason === "deployRunning";
  const engine = t(`service.kind.${data.engine}`);

  return (
    <SectionCard
      id={versionCardId}
      aria-label={t("databaseVersion.title")}
      title={t("databaseVersion.title")}
      description={t("databaseVersion.description")}
    >
      <div className="flex flex-col gap-4 pb-5">
        <KeyValue
          layout="grid"
          className="max-w-[520px]"
          items={[
            { label: t("databaseVersion.current"), value: `${engine} ${data.version}${data.variant ? ` + ${data.variant}` : ""}` },
            { label: t("databaseVersion.image"), value: data.image, mono: true },
          ]}
        />
        {running && data.pendingImage ? (
          <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
            {active && <DeploymentStatusChip status={active.status} />}
            <span>{t("databaseVersion.deploying", { image: data.pendingImage })}</span>
            {active && (
              <Button size="sm" className="ml-auto bg-muted shadow-none" onClick={() => setLog(true)}>
                {t("databaseVersion.viewLog")}
              </Button>
            )}
          </div>
        ) : data.pendingImage ? (
          <Callout tone="warning">{t("databaseVersion.pending", { pending: data.pendingImage, image: data.image })}</Callout>
        ) : null}
        {data.blocked && !running && <Callout tone="neutral">{data.blocked.message}</Callout>}
        {options.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">{t("databaseVersion.noChoice")}</span>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t("databaseVersion.changeTo")} htmlFor="dv-version" className="min-w-0 flex-[1_1_320px] max-w-[520px]">
              <Select value={picked} onValueChange={setPicked} disabled={data.blocked !== null}>
                <SelectTrigger id="dv-version" aria-label={t("databaseVersion.changeTo")}>
                  <SelectValue placeholder={t("databaseVersion.pick")} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((c) => (
                    <SelectItem key={`${c.version}|${c.image}`} value={`${c.version}|${c.image}`} disabled={!c.allowed}>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span>{choiceLabel(c, newest)}</span>
                        <span className="font-mono text-xs text-muted-foreground">{shortImage(c.image)}</span>
                        {!c.allowed && c.message && <span className="text-xs whitespace-normal text-muted-foreground">{c.message}</span>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button variant="primary" disabled={!selected || data.blocked !== null} onClick={() => selected && setConfirming(selected)}>
              {t("databaseVersion.change")}
            </Button>
          </div>
        )}
      </div>
      {confirming && <VersionDialog service={service} data={data} choice={confirming} onClose={() => setConfirming(null)} />}
      <DeployLogModal serviceId={service.id} deployment={log ? active : null} onClose={() => setLog(false)} />
    </SectionCard>
  );
}

function VersionDialog({ service, data, choice, onClose }: { service: ServiceDetail; data: Choices; choice: Choice; onClose: () => void }) {
  const invalidate = useInvalidate();
  const lineChange = choice.version !== data.version;
  const [custom, setCustom] = useState(false);
  const [image, setImage] = useState(choice.image);
  const [withoutBackup, setWithoutBackup] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const needsBackup = lineChange && !data.backupFresh;
  const policies = useOp(backups.listPolicies, { serviceId: service.id }, { retry: retryOp, enabled: needsBackup });
  const policy = policies.data?.policies.find((p) => p.target === "database");
  const runs = useOp(
    backups.listRuns,
    { serviceId: service.id, limit: 5 },
    {
      retry: retryOp,
      enabled: runId !== null,
      refetchInterval: (q) => (q.state.data?.runs.find((r) => r.id === runId)?.status === "running" ? 3000 : false),
    },
  );
  const run = runId ? runs.data?.runs.find((r) => r.id === runId) : undefined;
  const runStatus = run?.status ?? (runId ? "running" : null);
  // A finished backup lets the change go ahead: versionChoices says so.
  useEffect(() => {
    if (runStatus === "succeeded") invalidate(databases.versionChoices);
  }, [runStatus, invalidate]);
  const backUp = useOpMutation(backups.runNow, {
    onSuccess: (r) => {
      setRunId(r.id);
      invalidate(backups.listRuns);
    },
  });
  const change = useOpMutation(databases.setVersion, {
    onSuccess: () => {
      toast.success(t("databaseVersion.confirm.done", { image: custom ? image.trim() : choice.image }));
      invalidate(databases.versionChoices, databases.get, deployments.list, services.get);
      onClose();
    },
  });
  const engine = t(`service.kind.${data.engine}`);
  const target = custom ? image.trim() : choice.image;
  const title =
    choice.kind === "current"
      ? t("databaseVersion.confirm.stay", { image: choice.image })
      : lineChange
        ? t("databaseVersion.confirm.titleLine", { engine, version: choice.version })
        : t("databaseVersion.confirm.titlePatch", { image: choice.image });
  const backupOk = !needsBackup || withoutBackup || runStatus === "succeeded";
  const customOffered = data.engine !== "keydb" && data.engine !== "dragonfly";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[12%]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate({
              serviceId: service.id,
              version: choice.version,
              ...(custom && target !== choice.image ? { image: target } : {}),
              ...(needsBackup && withoutBackup ? { confirmNoBackup: true } : {}),
            });
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t("databaseVersion.confirm.restart", { image: target })}</DialogDescription>
          </div>
          {lineChange && <Callout tone="warning">{t("databaseVersion.confirm.undo")}</Callout>}
          {lineChange && data.engine === "mongo" && (
            <p className="m-0 text-[13px] leading-normal text-ink-strong">
              {t("databaseVersion.confirm.mongoFcv", { version: data.version })}
            </p>
          )}
          {customOffered && choice.kind !== "current" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="dv-custom" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
                <Checkbox id="dv-custom" checked={custom} onCheckedChange={(v) => setCustom(v === true)} />
                {t("databaseVersion.customToggle")}
              </label>
              {custom && (
                <Field
                  label={t("databaseVersion.customLabel")}
                  htmlFor="dv-image"
                  hint={t("databaseVersion.customHint", { repo: repositoryOf(choice.image), version: choice.version, image: choice.image })}
                >
                  <Input id="dv-image" className="font-mono" value={image} onChange={(e) => setImage(e.target.value)} />
                </Field>
              )}
            </div>
          )}
          {lineChange && (
            <section
              aria-label={t("databaseVersion.confirm.backupTitle")}
              className="flex flex-col gap-2 rounded-control bg-muted px-3.5 py-3"
            >
              <b className="text-[13px] font-medium">{t("databaseVersion.confirm.backupTitle")}</b>
              {data.backupFresh && data.recentBackupAt ? (
                <span className="text-[13px]">
                  {t("databaseVersion.confirm.backupFresh", { when: formatRelative(data.recentBackupAt) })}
                </span>
              ) : (
                <>
                  <span className="text-[13px]">{t("databaseVersion.confirm.backupMissing")}</span>
                  {runStatus === "succeeded" && run?.finishedAt ? (
                    <span className="text-[13px] text-chip-green-fg">
                      {t("databaseVersion.confirm.backupDone", { when: formatRelative(run.finishedAt) })}
                    </span>
                  ) : runStatus === "failed" ? (
                    <span className="text-[13px] text-chip-red-fg">
                      {t("databaseVersion.confirm.backupFailed", { error: run?.error ?? "" })}
                    </span>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    {policy ? (
                      <Button
                        size="sm"
                        disabled={backUp.isPending || runStatus === "running"}
                        onClick={() => backUp.mutate({ serviceId: service.id, policyId: policy.id })}
                      >
                        {runStatus === "running" ? t("databaseVersion.confirm.backingUp") : t("databaseVersion.confirm.backUpNow")}
                      </Button>
                    ) : policies.data ? (
                      <span className="text-[13px] text-muted-foreground">
                        {t("databaseVersion.confirm.backupNone")}{" "}
                        <Link to="/p/$projectId/s/$serviceId/backups" params={{ projectId: service.projectId, serviceId: service.id }}>
                          {t("databaseVersion.confirm.setUpBackups")}
                        </Link>
                      </span>
                    ) : null}
                  </div>
                  <MutationError error={backUp.error} />
                  <label htmlFor="dv-nobackup" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
                    <Checkbox id="dv-nobackup" checked={withoutBackup} onCheckedChange={(v) => setWithoutBackup(v === true)} />
                    {t("databaseVersion.confirm.withoutBackup")}
                  </label>
                </>
              )}
            </section>
          )}
          {change.error && <Callout tone="danger">{errorMessage(change.error, t("service.actionFailed"))}</Callout>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={change.isPending || !backupOk || (custom && target === "")}>
              {lineChange ? t("databaseVersion.confirm.button") : t("databaseVersion.confirm.buttonPatch")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
