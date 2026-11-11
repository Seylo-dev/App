// "Export…" on a service's Settings tab: what goes in the file and what
// stays out (serviceTransfer.exportPreview), which volumes' data goes in
// and whether the service stops while it is read (a database always does),
// the passphrase or leaving secret values out, and the download.
// serviceTransfer.export answers with a one-minute link the browser opens
// as a download; a stale session gets the re-auth dialog first
// (lib/reauth.ts). While the download runs the dialog shows its progress
// from ServiceDetail.transfer, and at the end the zip's sha256.

import { serviceTransfer } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { LoadingRegion, SkeletonText } from "@seylo/ui/components/skeleton";
import { IconCheck } from "@tabler/icons-react";
import { type FormEvent, useEffect, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { isReauthCancelled } from "../../../lib/reauth";
import { CheckLabel, Field } from "../field";
import { formatBytes } from "../format";
import { OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

const minPassphrase = serviceTransfer.transferLimits.passphraseMin;

/** Opens a download link: the response is an attachment, so the page stays. */
function startDownload(url: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ExportDialog({
  service,
  open,
  onOpenChange,
}: {
  service: ServiceDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useOp(serviceTransfer.exportPreview, { serviceId: service.id }, { enabled: open, retry: retryOp });
  const [secrets, setSecrets] = useState<"encrypted" | "omitted">("encrypted");
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [sourceLogin, setSourceLogin] = useState(false);
  const [volumes, setVolumes] = useState<string[] | null>(null);
  const [stopService, setStopService] = useState(true);
  const [done, setDone] = useState<{ exportId: string; fileName: string } | null>(null);

  useEffect(() => {
    if (!open) {
      setPassphrase("");
      setAgain("");
      setDone(null);
      setVolumes(null);
    }
  }, [open]);

  const run = useOpMutation(serviceTransfer.exportService, {
    onSuccess: (res) => {
      startDownload(res.download.url, res.fileName);
      setDone({ exportId: res.exportId, fileName: res.fileName });
      setPassphrase("");
      setAgain("");
    },
  });
  const link = useOpMutation(serviceTransfer.exportLink, { onSuccess: (res) => startDownload(res.download.url, res.fileName) });

  const p = preview.data;
  // Every volume's data by default, when it can go.
  const dataAllowed = p ? p.data.blocker === null && !(p.data.database && secrets === "omitted") : false;
  const picked = dataAllowed ? (volumes ?? p?.volumes.map((v) => v.name) ?? []) : [];
  const stops = picked.length > 0 && p?.data.running === true && (p.data.database || stopService);
  const short = secrets === "encrypted" && passphrase.length > 0 && passphrase.length < minPassphrase;
  const mismatch = secrets === "encrypted" && again.length > 0 && again !== passphrase;
  const ready = secrets === "omitted" || (passphrase.length >= minPassphrase && again === passphrase);
  const blocked = p ? p.blockers.length > 0 : false;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!p || !ready || blocked) return;
    run.mutate({
      serviceId: service.id,
      secrets,
      ...(secrets === "encrypted" ? { passphrase } : {}),
      ...(secrets === "encrypted" && p.sourceLogin ? { includeSourceLogin: sourceLogin } : {}),
      ...(picked.length > 0 ? { volumes: picked, stopService: p.data.database || stopService } : {}),
    });
  };
  const runError = run.error && !isReauthCancelled(run.error) ? run.error : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[6%] max-h-[88vh] max-w-xl overflow-y-auto">
        {done ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <DialogTitle>{t("serviceTransfer.export.title", { name: service.name })}</DialogTitle>
              <DialogDescription>{t("serviceTransfer.export.started", { file: done.fileName })}</DialogDescription>
            </div>
            <p className="m-0 text-[13px] text-muted-foreground">{t("serviceTransfer.export.startedHint")}</p>
            <ExportProgress service={service} exportId={done.exportId} />
            {link.error && !isReauthCancelled(link.error) && <OpErrorNote error={link.error} />}
            <div className="flex justify-end gap-2">
              <Button onClick={() => link.mutate({ serviceId: service.id, exportId: done.exportId })} disabled={link.isPending}>
                {t("serviceTransfer.export.newLink")}
              </Button>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                {t("common.close")}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" aria-label={t("serviceTransfer.export.title", { name: service.name })}>
            <div className="flex flex-col gap-1">
              <DialogTitle>{t("serviceTransfer.export.title", { name: service.name })}</DialogTitle>
              <DialogDescription>{t("serviceTransfer.export.description")}</DialogDescription>
            </div>
            {preview.isError ? (
              <OpErrorNote error={preview.error} />
            ) : !p ? (
              <LoadingRegion label={t("common.loading")} className="flex flex-col gap-2">
                <SkeletonText className="w-28 text-xs" />
                <SkeletonText className="w-64" />
                <SkeletonText className="w-48" />
              </LoadingRegion>
            ) : blocked ? (
              <Alert tone="warning" title={t("serviceTransfer.export.blocked")}>
                {p.blockers.map((b) => b.message).join(" ")}
              </Alert>
            ) : (
              <>
                <Includes preview={p} />
                {p.volumes.length > 0 && (
                  <DataChoice
                    preview={p}
                    name={service.name}
                    picked={picked}
                    onPick={setVolumes}
                    stopService={stopService}
                    onStopService={setStopService}
                    passphraseNeeded={p.data.database && secrets === "omitted"}
                  />
                )}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{t("serviceTransfer.export.secrets")}</span>
                  <RadioGroup
                    value={secrets}
                    onValueChange={(v) => setSecrets(v as "encrypted" | "omitted")}
                    className="grid gap-2"
                    aria-label={t("serviceTransfer.export.secrets")}
                  >
                    <RadioCard
                      value="encrypted"
                      title={t("serviceTransfer.export.encrypted")}
                      description={t("serviceTransfer.export.encryptedDescription")}
                    />
                    <RadioCard
                      value="omitted"
                      title={t("serviceTransfer.export.omitted")}
                      description={t("serviceTransfer.export.omittedDescription")}
                    />
                  </RadioGroup>
                </div>
                {secrets === "encrypted" && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label={t("serviceTransfer.export.passphrase")}
                      htmlFor="export-passphrase"
                      hint={short ? t("serviceTransfer.export.passphraseShort") : t("serviceTransfer.export.passphraseHint")}
                    >
                      <Input
                        id="export-passphrase"
                        type="password"
                        autoComplete="new-password"
                        value={passphrase}
                        maxLength={serviceTransfer.transferLimits.passphraseMax}
                        aria-invalid={short}
                        onChange={(e) => setPassphrase(e.target.value)}
                      />
                    </Field>
                    <Field
                      label={t("serviceTransfer.export.passphraseAgain")}
                      htmlFor="export-passphrase-again"
                      hint={mismatch ? t("serviceTransfer.export.passphraseMismatch") : undefined}
                    >
                      <Input
                        id="export-passphrase-again"
                        type="password"
                        autoComplete="new-password"
                        value={again}
                        aria-invalid={mismatch}
                        onChange={(e) => setAgain(e.target.value)}
                      />
                    </Field>
                  </div>
                )}
                {secrets === "encrypted" && p.sourceLogin && (
                  <CheckLabel checked={sourceLogin} onCheckedChange={(v) => setSourceLogin(v === true)}>
                    {t("serviceTransfer.export.sourceLogin", {
                      kind: t(`serviceTransfer.export.sourceLoginKind.${p.sourceLogin.kind}`),
                      name: p.sourceLogin.name,
                    })}
                  </CheckLabel>
                )}
                {(p.includes.upload || picked.length > 0) && (
                  <p className="m-0 text-[12.5px] text-muted-foreground">{t("serviceTransfer.export.notEncrypted")}</p>
                )}
                {stops && <Alert tone="warning">{t("serviceTransfer.export.stopsUntil", { name: service.name })}</Alert>}
                {p.leftOut.length > 0 && (
                  <details className="text-[12.5px] text-muted-foreground">
                    <summary className="cursor-pointer">{t("serviceTransfer.export.leftOut")}</summary>
                    <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
                      {p.leftOut.map((l) => (
                        <li key={l.what}>
                          <span className="text-ink-strong">{l.what}</span>: {l.why}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
            {runError && (
              <p role="alert" className="m-0 text-[13px] text-destructive">
                {errorMessage(runError, t("common.unknownError"))}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
              <Button type="submit" variant="primary" disabled={!p || blocked || !ready || run.isPending}>
                {run.isPending ? t("serviceTransfer.export.preparing") : t("serviceTransfer.export.download")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type Preview = (typeof serviceTransfer.exportPreview.output)["static"];

function Includes({ preview: p }: { preview: Preview }) {
  const i = p.includes;
  const hosts = i.domains.map((d) => (d.pathPrefix === "/" ? d.host : `${d.host}${d.pathPrefix}`));
  const lines = [
    t("serviceTransfer.export.settings"),
    i.envKeys > 0 && t("serviceTransfer.export.envKeys", { count: i.envKeys }),
    i.fileMounts > 0 && t("serviceTransfer.export.fileMounts", { count: i.fileMounts }),
    hosts.length > 0 && t("serviceTransfer.export.domains", { count: hosts.length, hosts: hosts.join(", ") }),
    i.cronJobs > 0 && t("serviceTransfer.export.cronJobs", { count: i.cronJobs }),
    i.uptimeChecks > 0 && t("serviceTransfer.export.uptimeChecks", { count: i.uptimeChecks }),
    i.alerts > 0 && t("serviceTransfer.export.alerts", { count: i.alerts }),
    i.backups > 0 && t("serviceTransfer.export.backups", { count: i.backups }),
    i.exposures > 0 && t("serviceTransfer.export.exposures", { count: i.exposures }),
    i.maintenance && t("serviceTransfer.export.maintenance"),
    i.tunnel && t("serviceTransfer.export.tunnel"),
    i.deployTrigger && t("serviceTransfer.export.deployTrigger"),
    i.sharedVariables.length > 0 && t("serviceTransfer.export.sharedVariables", { names: i.sharedVariables.join(", ") }),
    i.upload && t("serviceTransfer.export.upload", { file: i.upload.fileName, size: formatBytes(i.upload.sizeBytes) }),
  ].filter((line): line is string => typeof line === "string");
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <span className="text-xs font-medium text-muted-foreground">{t("serviceTransfer.export.includes")}</span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {lines.map((line) => (
          <li key={line} className="flex items-start gap-2 text-ink-strong">
            <IconCheck size={14} stroke={2.2} className="mt-0.5 shrink-0 text-chip-green-fg" aria-hidden="true" />
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Which volumes' data goes in, and whether the service stops while it is read. */
function DataChoice({
  preview: p,
  name,
  picked,
  onPick,
  stopService,
  onStopService,
  passphraseNeeded,
}: {
  preview: Preview;
  name: string;
  picked: string[];
  onPick: (volumes: string[]) => void;
  stopService: boolean;
  onStopService: (on: boolean) => void;
  passphraseNeeded: boolean;
}) {
  const all = p.volumes.map((v) => v.name);
  const blocked = p.data.blocker !== null || passphraseNeeded;
  return (
    <div className="flex flex-col gap-2 text-[13px]" data-testid="export-data">
      <span className="text-xs font-medium text-muted-foreground">{t("serviceTransfer.export.dataTitle")}</span>
      {p.data.blocker ? (
        <p className="m-0 text-muted-foreground">{t("serviceTransfer.export.dataBlocked", { reason: p.data.blocker.message })}</p>
      ) : passphraseNeeded ? (
        <p className="m-0 text-muted-foreground">{t("serviceTransfer.export.databaseNeedsPassphrase")}</p>
      ) : null}
      {p.data.database ? (
        <CheckLabel checked={!blocked && picked.length > 0} disabled={blocked} onCheckedChange={(v) => onPick(v === true ? all : [])}>
          {t("serviceTransfer.export.databaseVolume", { name })}
        </CheckLabel>
      ) : (
        p.volumes.map((v) => (
          <CheckLabel
            key={v.name}
            checked={!blocked && picked.includes(v.name)}
            disabled={blocked}
            onCheckedChange={(on) => onPick(on === true ? [...picked, v.name] : picked.filter((n) => n !== v.name))}
          >
            {t("serviceTransfer.export.volume", { name: v.name, path: v.mountPath })}
          </CheckLabel>
        ))
      )}
      {!blocked && picked.length > 0 && p.data.running && (
        <CheckLabel checked={p.data.database || stopService} disabled={p.data.database} onCheckedChange={(v) => onStopService(v === true)}>
          {p.data.database ? t("serviceTransfer.export.databaseStop", { name }) : t("serviceTransfer.export.stop", { name })}
        </CheckLabel>
      )}
      {picked.length === 0 && !blocked && <p className="m-0 text-muted-foreground">{t("serviceTransfer.export.noData")}</p>}
    </div>
  );
}

/** The running download of this export, from the service page's live state. */
function ExportProgress({ service, exportId }: { service: ServiceDetail; exportId: string }) {
  const cancel = useOpMutation(serviceTransfer.cancelExport);
  const transfer = service.transfer?.kind === "export" && service.transfer.id === exportId ? service.transfer : null;
  if (!transfer) return <p className="m-0 text-[13px] text-muted-foreground">{t("serviceTransfer.export.progress.waiting")}</p>;
  if (transfer.status === "done") {
    return (
      <div className="flex flex-col gap-1.5 text-[13px]">
        <span className="text-ink-strong">{t("serviceTransfer.export.progress.finished")}</span>
        {transfer.sha256 && <CopyField value={transfer.sha256} />}
      </div>
    );
  }
  if (transfer.status !== "streaming") {
    return (
      <Alert tone="danger" role="alert">
        {t("serviceTransfer.export.progress.ended", { error: transfer.error ?? t("common.unknownError") })}
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-[13px]" aria-live="polite">
      <span className="text-ink-strong">
        {transfer.stopped
          ? t("serviceTransfer.export.progress.streamingStopped", { size: formatBytes(transfer.bytes), name: service.name })
          : t("serviceTransfer.export.progress.streaming", { size: formatBytes(transfer.bytes) })}
      </span>
      {transfer.volumes.length > 0 && (
        <div className="flex justify-start">
          <Button
            variant="ghost"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate({ serviceId: service.id, exportId: transfer.id })}
          >
            {t("serviceTransfer.export.progress.stop")}
          </Button>
        </div>
      )}
      {cancel.error && <OpErrorNote error={cancel.error} />}
    </div>
  );
}
