// The Version card of a database's Settings tab: what the database runs,
// the catalog versions it may change to (databases.versionChoices; the one
// that runs is disabled, the ones that take a risk say so), any other image
// of its engine's repository (Use another image, anyImage), and the confirm
// dialog: the restart, no way back, what can go wrong and "I understand"
// (acceptRisk) for a risky change (from versionChoices, or the panel's
// riskNotAccepted answer for another image), a backup first, MongoDB's
// compatibility step and MySQL 8.4's mysql_native_password check (the
// accounts it would lock out, and keeping their logins working). A MySQL
// 8.4 also turns those logins on or off on the image it runs (a switch and
// Apply, then a confirm dialog). While the change deploys the card shows the
// deploy and its log.

import { backups, databases, deployments, OpError, type OpOutput, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { KeyValue } from "@seylo/ui/components/key-value";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { type RiskRefusal, riskRefusalOf } from "../../../lib/database-image";
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

/** The version recorded for an image whose tag names no release (latest, a digest). */
export const customVersion = "custom";

/** The risks the panel names (VersionChoice.risk), each with its words in databaseVersion.confirm.risk. */
const knownRisks = [
  "downgrade",
  "olderImage",
  "postgresMajor",
  "dataPath",
  "patchOnly",
  "oneStep",
  "otherLine",
  "postgresBase",
  "floatingTag",
  "digest",
] as const;
type Risk = (typeof knownRisks)[number];
const isRisk = (risk: string): risk is Risk => (knownRisks as readonly string[]).includes(risk);

/** The repository of an image, for the image hint: "mongo" of "mongo:8.0.38". */
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
  /** choice null: another image, typed in the dialog. */
  const [confirming, setConfirming] = useState<{ choice: Choice | null } | null>(null);
  const [log, setLog] = useState(false);
  /** MySQL 8.4's mysql_native_password logins on the image it runs: what the switch asks for, and its dialog. */
  const nativeOn = choices.data?.nativePassword?.on ?? false;
  const [nativeWanted, setNativeWanted] = useState(nativeOn);
  const [nativeConfirm, setNativeConfirm] = useState(false);
  // What it is set to run changed (an applied change, another tab): the switch follows.
  useEffect(() => setNativeWanted(nativeOn), [nativeOn]);
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
  const anyImage = data.anyImage && data.blocked === null;
  const runs =
    data.version === customVersion
      ? t("databaseVersion.currentImage", { engine, image: data.image })
      : `${engine} ${data.version}${data.variant ? ` + ${data.variant}` : ""}`;
  // MySQL 8.4 turns mysql_native_password logins on or off on the image it runs; not while a change is pending.
  const nativeHere = data.nativePassword?.lines.includes(data.version) ?? false;
  const nativeLocked = data.blocked !== null || data.pendingImage !== null;

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
            { label: t("databaseVersion.current"), value: runs },
            { label: t("databaseVersion.image"), value: data.image, mono: true },
            ...(data.nativePassword?.on ? [{ label: t("databaseVersion.logins"), value: t("databaseVersion.nativeOn") }] : []),
          ]}
        />
        {nativeHere && (
          <div className="flex max-w-[520px] flex-wrap items-center gap-3">
            <label htmlFor="dv-native-switch" className="flex min-w-0 flex-[1_1_280px] cursor-pointer items-start gap-3">
              <Switch
                id="dv-native-switch"
                checked={nativeWanted}
                disabled={nativeLocked}
                onCheckedChange={setNativeWanted}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium">{t("databaseVersion.nativeSwitch")}</span>
                <span className="text-xs text-muted-foreground">{t("databaseVersion.nativeSwitchHint", { version: data.version })}</span>
              </span>
            </label>
            <Button size="sm" disabled={nativeLocked || nativeWanted === nativeOn} onClick={() => setNativeConfirm(true)}>
              {t("databaseVersion.nativeApply")}
            </Button>
          </div>
        )}
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
        {options.length === 0 && !anyImage ? (
          <span className="text-[13px] text-muted-foreground">{t("databaseVersion.noChoice")}</span>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            {options.length > 0 && (
              <>
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
                            {!c.allowed && c.message && (
                              <span className="text-xs whitespace-normal text-muted-foreground">{c.message}</span>
                            )}
                            {c.allowed && c.risk && (
                              <span className="text-xs whitespace-normal text-chip-amber-fg">
                                {isRisk(c.risk) ? t(`databaseVersion.riskNote.${c.risk}`) : c.message}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Button
                  variant="primary"
                  disabled={!selected || data.blocked !== null}
                  onClick={() => selected && setConfirming({ choice: selected })}
                >
                  {t("databaseVersion.change")}
                </Button>
              </>
            )}
            {anyImage && <Button onClick={() => setConfirming({ choice: null })}>{t("databaseVersion.anotherImage")}</Button>}
          </div>
        )}
      </div>
      {confirming && <VersionDialog service={service} data={data} choice={confirming.choice} onClose={() => setConfirming(null)} />}
      {nativeConfirm && <NativePasswordDialog service={service} data={data} on={nativeWanted} onClose={() => setNativeConfirm(false)} />}
      <DeployLogModal serviceId={service.id} deployment={log ? active : null} onClose={() => setLog(false)} />
    </SectionCard>
  );
}

function VersionDialog({
  service,
  data,
  choice,
  onClose,
}: {
  service: ServiceDetail;
  data: Choices;
  /** A catalog version; null for another image, typed in the dialog starting from what runs. */
  choice: Choice | null;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const lineChange = choice !== null && choice.version !== data.version;
  const [image, setImage] = useState(data.image);
  const [withoutBackup, setWithoutBackup] = useState(false);
  // What the panel answered for another image: the risks (riskNotAccepted), or that it needs a backup.
  const [refused, setRefused] = useState<RiskRefusal | null>(null);
  const [backupAsked, setBackupAsked] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const risk: RiskRefusal | null =
    refused ??
    (choice?.risk
      ? {
          risk: choice.risk,
          risks: [choice.risk],
          message: choice.message ?? "",
          version: choice.version,
          image: choice.image,
          backupRequired: !data.backupFresh,
        }
      : null);
  // The line it would run: the catalog's, or the one the panel read from another image's tag.
  const toVersion = choice?.version ?? (refused?.version || data.version);
  // MySQL 8.4: mysql_native_password logins. The checkbox shows while they are on, or once the
  // panel named accounts that would lose them or could not list them (an admin other than root
  // cannot read MySQL's accounts).
  const nativeLine = data.nativePassword?.lines.includes(toVersion) ?? false;
  const [keepNative, setKeepNative] = useState(data.nativePassword?.on ?? false);
  const [nativeRefused, setNativeRefused] = useState(false);
  const showNative = nativeLine && (data.nativePassword?.on === true || nativeRefused);
  const [runId, setRunId] = useState<string | null>(null);
  // Every change but a newer patch of the line it runs needs a backup: a new line, or a risk taken.
  const backupShown = lineChange || risk !== null || backupAsked;
  const needsBackup = backupShown && !data.backupFresh;
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
  const target = choice ? choice.image : image.trim();
  const change = useOpMutation(databases.setVersion, {
    onSuccess: () => {
      toast.success(t("databaseVersion.confirm.done", { image: target }));
      invalidate(databases.versionChoices, databases.get, deployments.list, services.get);
      onClose();
    },
    onError: (error) => {
      const reason = error instanceof OpError ? (error.details?.reason ?? "") : "";
      if (nativeReasons.includes(reason)) setNativeRefused(true);
      if (reason === "backupRequired") setBackupAsked(true);
      const answer = riskRefusalOf(error);
      if (answer) {
        setRefused(answer);
        if (answer.backupRequired) setBackupAsked(true);
      }
    },
  });
  const nativeUsers = nativeUsersOf(change.error);
  const engine = t(`service.kind.${data.engine}`);
  // The image it runs changes nothing (the panel refuses it), unless a change to
  // another one did not finish: then setting it again stays on what runs.
  const stay = choice ? choice.kind === "current" : target === data.image && data.pendingImage !== null;
  const sameImage = choice === null && (target === "" || (target === data.image && !stay));
  const title = stay
    ? t("databaseVersion.confirm.stay", { image: target })
    : choice === null
      ? t("databaseVersion.confirm.titleImage", { engine })
      : lineChange
        ? t("databaseVersion.confirm.titleLine", { engine, version: choice.version })
        : t("databaseVersion.confirm.titlePatch", { image: choice.image });
  const backupOk = !needsBackup || withoutBackup || runStatus === "succeeded";
  const riskOk = risk === null || accepted;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[8%] max-h-[84vh] overflow-y-auto">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate({
              serviceId: service.id,
              ...(choice ? { version: choice.version } : { image: target }),
              ...(risk && accepted ? { acceptRisk: true } : {}),
              ...(needsBackup && withoutBackup ? { confirmNoBackup: true } : {}),
              ...(showNative ? { keepNativePassword: keepNative } : {}),
            });
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {sameImage
                ? t("databaseVersion.confirm.imageSame", { image: data.image })
                : t("databaseVersion.confirm.restart", { image: target })}
            </DialogDescription>
          </div>
          {lineChange && !risk && <Callout tone="warning">{t("databaseVersion.confirm.undo")}</Callout>}
          {lineChange && !risk && data.engine === "mongo" && (
            <p className="m-0 text-[13px] leading-normal text-ink-strong">
              {t("databaseVersion.confirm.mongoFcv", { version: data.version })}
            </p>
          )}
          {lineChange && nativeLine && !showNative && (
            <p className="m-0 text-[13px] leading-normal text-ink-strong">
              {t("databaseVersion.confirm.mysqlNative", { version: toVersion })}
            </p>
          )}
          {choice === null && (
            <Field
              label={t("databaseVersion.customLabel")}
              htmlFor="dv-image"
              hint={t("databaseVersion.imageHint", { repo: data.repository ?? repositoryOf(data.image), image: data.image })}
            >
              <Input
                id="dv-image"
                className="font-mono"
                value={image}
                onChange={(e) => {
                  setImage(e.target.value);
                  // The panel's answer is about the image that was sent: a new one starts without it.
                  if (change.error) change.reset();
                  setRefused(null);
                  setAccepted(false);
                  setBackupAsked(false);
                }}
              />
            </Field>
          )}
          {risk && (
            <RiskNote
              risk={risk}
              engine={engine}
              mongo={data.engine === "mongo" && (lineChange || choice === null)}
              accepted={accepted}
              onAccepted={setAccepted}
            />
          )}
          {backupShown && (
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
          {nativeUsers ? (
            <NativeUsersCallout users={nativeUsers} version={toVersion} />
          ) : (
            change.error &&
            !riskRefusalOf(change.error) &&
            !(change.error instanceof OpError && change.error.details?.reason === "backupRequired") && (
              <Callout tone="danger">{errorMessage(change.error, t("service.actionFailed"))}</Callout>
            )
          )}
          {showNative && (
            <div className="flex flex-col gap-1">
              <label htmlFor="dv-native" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
                <Checkbox id="dv-native" checked={keepNative} onCheckedChange={(v) => setKeepNative(v === true)} />
                {t("databaseVersion.confirm.keepNative", { version: toVersion })}
              </label>
              <span className="pl-6.5 text-xs text-muted-foreground">
                {t("databaseVersion.confirm.keepNativeHint", { version: toVersion })}
              </span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={change.isPending || !backupOk || !riskOk || sameImage}>
              {lineChange || risk ? t("databaseVersion.confirm.button") : t("databaseVersion.confirm.buttonPatch")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * mysql_native_password logins on or off on the image a MySQL 8.4 runs:
 * setVersion with that image and keepNativePassword alone, which deploys it
 * again with the new command. Off is checked like an upgrade: the accounts
 * that would lose their logins refuse it.
 */
function NativePasswordDialog({ service, data, on, onClose }: { service: ServiceDetail; data: Choices; on: boolean; onClose: () => void }) {
  const invalidate = useInvalidate();
  const change = useOpMutation(databases.setVersion, {
    onSuccess: () => {
      toast.success(t("databaseVersion.confirm.done", { image: data.image }));
      invalidate(databases.versionChoices, databases.get, deployments.list, services.get);
      onClose();
    },
  });
  const nativeUsers = nativeUsersOf(change.error);
  // The catalog's image of the line needs no image; a custom tag that runs is sent as itself.
  const catalogImage = data.choices.find((c) => c.version === data.version)?.image;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[12%]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate({
              serviceId: service.id,
              version: data.version,
              ...(data.image !== catalogImage ? { image: data.image } : {}),
              keepNativePassword: on,
            });
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{on ? t("databaseVersion.native.titleOn") : t("databaseVersion.native.titleOff")}</DialogTitle>
            <DialogDescription>{t("databaseVersion.confirm.restart", { image: data.image })}</DialogDescription>
          </div>
          <p className="m-0 text-[13px] leading-normal text-ink-strong">
            {on
              ? t("databaseVersion.native.bodyOn", { version: data.version })
              : t("databaseVersion.native.bodyOff", { version: data.version })}
          </p>
          {nativeUsers ? (
            <NativeUsersCallout users={nativeUsers} version={data.version} />
          ) : (
            change.error && <Callout tone="danger">{errorMessage(change.error, t("service.actionFailed"))}</Callout>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={change.isPending}>
              {t("databaseVersion.confirm.buttonPatch")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A nativePasswordUsers refusal: the accounts that would lose their logins and how to fix them. */
function NativeUsersCallout({ users, version }: { users: { accounts: string[]; count: number }; version: string }) {
  return (
    <Callout tone="warning">
      <div className="flex flex-col gap-2">
        <span>{t("databaseVersion.confirm.nativeUsers", { count: users.count, version })}</span>
        <ul aria-label={t("databaseVersion.logins")} className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-xs">
          {users.accounts.map((account) => (
            <li key={account}>{account}</li>
          ))}
          {users.count > users.accounts.length && (
            <li className="font-sans">{t("databaseVersion.confirm.nativeMore", { count: users.count - users.accounts.length })}</li>
          )}
        </ul>
        <span>{t("databaseVersion.confirm.nativeFix")}</span>
      </div>
    </Callout>
  );
}

/** What can go wrong, in plain words for each risk the panel found, and the "I understand" that sends acceptRisk. */
function RiskNote({
  risk,
  engine,
  mongo,
  accepted,
  onAccepted,
}: {
  risk: RiskRefusal;
  engine: string;
  /** A MongoDB move the panel runs no compatibility step for. */
  mongo: boolean;
  accepted: boolean;
  onAccepted: (accepted: boolean) => void;
}) {
  const known = risk.risks.filter(isRisk);
  return (
    <Callout tone="warning" title={t("databaseVersion.confirm.riskTitle")}>
      <div className="flex flex-col gap-2">
        <ul aria-label={t("databaseVersion.confirm.riskTitle")} className="m-0 flex list-disc flex-col gap-1 pl-4">
          {known.length > 0 ? (
            known.map((r) => <li key={r}>{t(`databaseVersion.confirm.risk.${r}`, { image: risk.image, engine })}</li>)
          ) : (
            <li>{risk.message}</li>
          )}
          {mongo && <li>{t("databaseVersion.confirm.riskMongo")}</li>}
        </ul>
        <span>{t("databaseVersion.confirm.riskBack")}</span>
        <label htmlFor="dv-risk" className="flex cursor-pointer items-center gap-2.5 font-medium">
          <Checkbox id="dv-risk" checked={accepted} onCheckedChange={(v) => onAccepted(v === true)} />
          {t("databaseVersion.confirm.understand")}
        </label>
      </div>
    </Callout>
  );
}

/** The refusals that keepNativePassword answers: accounts that would lose their logins, or no list of them. */
const nativeReasons = ["nativePasswordUsers", "nativePasswordCheckFailed"];

/** The accounts of a nativePasswordUsers refusal (at most 10 named) and how many there are. */
function nativeUsersOf(error: unknown): { accounts: string[]; count: number } | null {
  if (!(error instanceof OpError) || error.details?.reason !== "nativePasswordUsers") return null;
  const accounts = (error.details.accounts ?? "").split("\n").filter(Boolean);
  return { accounts, count: Math.max(Number(error.details.count) || 0, accounts.length) };
}
