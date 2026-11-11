// "Export…" on a service's Settings tab: what goes in the file and what
// stays out (serviceTransfer.exportPreview), the passphrase or leaving
// secret values out, and the download. serviceTransfer.export answers with
// a one-minute link the browser opens as a download; a stale session gets
// the re-auth dialog first (lib/reauth.ts).

import { serviceTransfer } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
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
const databaseKinds = new Set(["postgres", "mysql", "mariadb", "mongo", "redis", "valkey", "keydb", "dragonfly", "clickhouse"]);

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
  const [done, setDone] = useState<{ exportId: string; fileName: string } | null>(null);

  useEffect(() => {
    if (!open) {
      setPassphrase("");
      setAgain("");
      setDone(null);
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
                <Includes preview={p} name={service.name} kind={service.kind} />
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
                {p.includes.upload && <p className="m-0 text-[12.5px] text-muted-foreground">{t("serviceTransfer.export.notEncrypted")}</p>}
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

function Includes({ preview: p, name, kind }: { preview: Preview; name: string; kind: string }) {
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
      {p.volumes.length > 0 && (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {databaseKinds.has(kind)
            ? t("serviceTransfer.export.databaseData", { name })
            : t("serviceTransfer.export.volumes", { volumes: p.volumes.map((v) => v.name).join(", ") })}
        </p>
      )}
    </div>
  );
}
