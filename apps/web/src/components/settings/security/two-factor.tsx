// Authenticator app (TOTP): enroll with a QR code, confirm with a code,
// get 10 recovery codes once; turn it off or get new recovery codes with a
// current code.

import { auth } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { CopyField, useCopy } from "@seylo/ui/components/copy-field";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { IconCopy, IconDownload } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { formatDate } from "../format";
import { useSettingsMutation } from "../mutation";
import { errorText } from "../op-state";
import { QrCode } from "../qr-code";

type Step =
  | { kind: "idle" }
  | { kind: "enroll"; secret: string; otpauthUrl: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "disable" }
  | { kind: "regenerate" };

export function TwoFactorSection({
  enabled,
  confirmedAt,
  recoveryCodesLeft,
}: {
  enabled: boolean;
  confirmedAt: string | null;
  recoveryCodesLeft: number;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = [auth.security];
  const enroll = useSettingsMutation(auth.totpEnroll, {
    onSuccess: (out) => {
      setCode("");
      setError(null);
      setStep({ kind: "enroll", ...out });
    },
  });
  const confirm = useSettingsMutation(auth.totpConfirm, {
    invalidates: refresh,
    failure: false,
    onSuccess: (out) => setStep({ kind: "codes", codes: out.recoveryCodes }),
    onError: (e) => setError(errorText(e)),
  });
  const disable = useSettingsMutation(auth.totpDisable, {
    invalidates: refresh,
    failure: false,
    success: t("settingsSecurity.totp.disabled"),
    onSuccess: () => setStep({ kind: "idle" }),
    onError: (e) => setError(errorText(e)),
  });
  const regenerate = useSettingsMutation(auth.regenerateRecoveryCodes, {
    invalidates: refresh,
    failure: false,
    onSuccess: (out) => setStep({ kind: "codes", codes: out.recoveryCodes }),
    onError: (e) => setError(errorText(e)),
  });

  function start(kind: "disable" | "regenerate") {
    setCode("");
    setError(null);
    setStep({ kind });
  }

  const sixDigits = /^[0-9]{6}$/.test(code);

  return (
    <SectionCard
      title={t("settingsSecurity.totp.title")}
      description={t("settingsSecurity.totp.description")}
      actions={enabled ? <Chip tone="green">{t("settingsSecurity.on")}</Chip> : <Chip tone="gray">{t("settingsSecurity.off")}</Chip>}
    >
      {step.kind === "idle" &&
        (enabled ? (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-[13px] text-muted-foreground">
              {confirmedAt && t("settingsSecurity.totp.onSince", { date: formatDate(confirmedAt) })}{" "}
              {t("settingsSecurity.totp.codesLeft", { count: recoveryCodesLeft })}
            </p>
            {recoveryCodesLeft <= 3 && <Alert tone="warning">{t("settingsSecurity.totp.fewCodes")}</Alert>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => start("regenerate")}>
                {t("settingsSecurity.totp.newCodes")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => start("disable")}>
                {t("settingsSecurity.totp.turnOff")}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="primary" disabled={enroll.isPending} onClick={() => enroll.mutate({})}>
              {t("settingsSecurity.totp.setUp")}
            </Button>
          </div>
        ))}

      {step.kind === "enroll" && (
        <form
          className="flex flex-col gap-4 sm:flex-row sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            if (sixDigits) confirm.mutate({ code });
          }}
        >
          <QrCode value={step.otpauthUrl} label={t("settingsSecurity.totp.qr")} />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <ol className="m-0 flex flex-col gap-1.5 pl-5 text-[13px] text-ink-strong">
              <li>{t("settingsSecurity.totp.step1")}</li>
              <li>{t("settingsSecurity.totp.step2")}</li>
            </ol>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-strong">{t("settingsSecurity.totp.manual")}</span>
              <CopyField value={step.secret} aria-label={t("settingsSecurity.totp.manual")} />
            </div>
            <CodeInput value={code} onChange={setCode} error={error} />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={!sixDigits || confirm.isPending}>
                {t("settingsSecurity.totp.turnOn")}
              </Button>
              <Button variant="ghost" onClick={() => setStep({ kind: "idle" })}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        </form>
      )}

      {(step.kind === "disable" || step.kind === "regenerate") && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (step.kind === "disable" && code.trim().length >= 6) disable.mutate({ code: code.trim() });
            if (step.kind === "regenerate" && sixDigits) regenerate.mutate({ code });
          }}
        >
          <p className="m-0 text-[13px] text-muted-foreground">
            {step.kind === "disable" ? t("settingsSecurity.totp.disableHint") : t("settingsSecurity.totp.regenerateHint")}
          </p>
          <CodeInput value={code} onChange={setCode} error={error} allowRecovery={step.kind === "disable"} />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant={step.kind === "disable" ? "destructive" : "primary"}
              disabled={disable.isPending || regenerate.isPending || (step.kind === "disable" ? code.trim().length < 6 : !sixDigits)}
            >
              {step.kind === "disable" ? t("settingsSecurity.totp.turnOff") : t("settingsSecurity.totp.newCodes")}
            </Button>
            <Button variant="ghost" onClick={() => setStep({ kind: "idle" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      )}

      {step.kind === "codes" && <RecoveryCodes codes={step.codes} onDone={() => setStep({ kind: "idle" })} />}
    </SectionCard>
  );
}

function CodeInput({
  value,
  onChange,
  error,
  allowRecovery = false,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  allowRecovery?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="totp-code" className="text-[12.5px] font-medium text-ink-strong">
        {allowRecovery ? t("settingsSecurity.totp.codeOrRecovery") : t("settingsSecurity.totp.code")}
      </label>
      <Input
        id="totp-code"
        value={value}
        autoComplete="one-time-code"
        inputMode={allowRecovery ? "text" : "numeric"}
        maxLength={allowRecovery ? 32 : 6}
        className="w-48 font-mono tracking-widest"
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(allowRecovery ? e.target.value : e.target.value.replace(/\D/g, ""))}
      />
      {error && (
        <span role="alert" className="text-xs text-chip-red-fg">
          {error}
        </span>
      )}
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, copy] = useCopy();
  const text = codes.join("\n");
  function download() {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="warning" title={t("settingsSecurity.totp.codesTitle")}>
        {t("settingsSecurity.totp.codesHint")}
      </Alert>
      <ul className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-1.5 rounded-control bg-raised p-4 font-mono text-[13px] sm:grid-cols-3">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void copy(text)}>
          <IconCopy size={15} stroke={1.8} />
          {copied ? t("settingsSecurity.copied") : t("settingsSecurity.copyAll")}
        </Button>
        <Button size="sm" onClick={download}>
          <IconDownload size={15} stroke={1.8} />
          {t("settingsSecurity.download")}
        </Button>
        <Button size="sm" variant="primary" className="ml-auto" onClick={onDone}>
          {t("settingsSecurity.totp.saved")}
        </Button>
      </div>
    </div>
  );
}
