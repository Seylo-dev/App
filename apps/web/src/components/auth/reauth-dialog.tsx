// The re-auth dialog. lib/reauth.ts opens it when the
// panel refuses a change for want of a recent sign-in; it confirms with the
// password, an authenticator code or a passkey through auth.reauth, or with
// the linked GitHub login through the device flow (auth.reauthGithubStart
// and Poll), whichever the account has, and the refused call then runs
// again by itself. An account with none of them signs in again instead. The
// /reauth page (for the server-rendered MCP consent page) uses the same form.

import { auth, OpError } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { IconFingerprint } from "@tabler/icons-react";
import { type FormEvent, useEffect, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage, opClient } from "../../lib/api";
import { setReauthPrompt } from "../../lib/reauth";
import { getPasskeyAssertion, passkeysSupported } from "../../lib/webauthn";
import { DeviceCodeCard, type DeviceCodeView, GitHubMark, useDevicePolling } from "./device-code";

type Method = "password" | "totp" | "passkey" | "github";

/** Mounted once at the root; every refused call in the app shows this one dialog. */
export function ReauthHost() {
  const [pending, setPending] = useState<((confirmed: boolean) => void) | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      setReauthPrompt(
        () =>
          new Promise<boolean>((resolve) => {
            setBusy(false);
            setPending(() => resolve);
          }),
      ),
    [],
  );

  const finish = (confirmed: boolean) => {
    pending?.(confirmed);
    setPending(null);
  };

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && !busy && finish(false)}>
      <DialogContent className="flex max-w-md flex-col gap-4" data-testid="reauth-dialog">
        <div className="flex flex-col gap-1.5">
          <DialogTitle>{t("auth.reauth.title")}</DialogTitle>
          <DialogDescription className="leading-relaxed">{t("auth.reauth.hint")}</DialogDescription>
        </div>
        {pending && (
          <ReauthForm
            busy={busy}
            setBusy={setBusy}
            returnTo={`${window.location.pathname}${window.location.search}`}
            onDone={() => finish(true)}
            onCancel={() => finish(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ReauthForm({
  busy,
  setBusy,
  returnTo,
  onDone,
  onCancel,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** Where "sign in again" comes back to after the new sign-in. */
  returnTo: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  // Always fresh: a passkey or 2FA added a minute ago counts.
  const security = useOp(auth.security, {}, { staleTime: 0 });
  const [chosen, setChosen] = useState<Method | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reauth = useOpMutation(auth.reauth);
  // The GitHub device flow while it runs: the code on screen, polled until GitHub answers.
  const [device, setDevice] = useState<DeviceCodeView | null>(null);
  useDevicePolling(
    device,
    (ticket) => opClient.call(auth.reauthGithubPoll, { ticket }),
    (result) => {
      setDevice(null);
      if (result.status === "done") onDone();
      else setError(t(result.status === "denied" ? "auth.reauth.githubDenied" : "auth.reauth.githubExpired"));
    },
    (cause) => {
      setDevice(null);
      setError(errorMessage(cause, t("common.unknownError")));
    },
  );

  if (security.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label={t("common.loading")} className="flex flex-col gap-2.5">
        <Skeleton className="h-9" />
        <Skeleton className="h-9 w-2/3" />
      </div>
    );
  }
  if (security.error || !security.data) {
    return (
      <Alert tone="danger" title={t("auth.reauth.loadFailed")}>
        {errorMessage(security.error, t("common.unknownError"))}
      </Alert>
    );
  }

  const data = security.data;
  const methods: Method[] = [];
  if (data.passwordSet) methods.push("password");
  if (data.totp.enabled) methods.push("totp");
  if (data.passkeysAvailable && data.passkeys.length > 0 && passkeysSupported()) methods.push("passkey");
  if (data.github && data.githubAvailable) methods.push("github");
  const method = chosen && methods.includes(chosen) ? chosen : methods[0];

  async function run(confirm: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await confirm();
      onDone();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "NotAllowedError") setError(t("auth.reauth.passkeyCancelled"));
      else setError(errorMessage(cause, t("common.unknownError")));
    } finally {
      setBusy(false);
    }
  }

  if (!method) {
    return (
      <>
        <p className="m-0 text-[13px] text-ink-strong">{t("auth.reauth.signInAgainHint")}</p>
        {error && <ErrorLine text={error} />}
        <div className="flex justify-end gap-2">
          <Button disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await opClient.call(auth.logout, {});
                window.location.assign(`/login?redirect=${encodeURIComponent(returnTo)}`);
              })
            }
          >
            {t("auth.reauth.signInAgain")}
          </Button>
        </div>
      </>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (method === "password" && password) void run(() => reauth.mutateAsync({ password }));
    if (method === "totp" && code.trim().length >= 6) void run(() => reauth.mutateAsync({ code: code.replace(/\s/g, "") }));
    if (method === "passkey")
      void run(async () => {
        const begin = await opClient.call(auth.reauthPasskeyBegin, {});
        const response = await getPasskeyAssertion(begin.options);
        await reauth.mutateAsync({ passkey: { ticket: begin.ticket, response } });
      });
    if (method === "github" && !device) void startGithub();
  };

  // Shows the code; the polling above confirms and closes once GitHub says yes.
  async function startGithub() {
    setError(null);
    setBusy(true);
    try {
      setDevice(await opClient.call(auth.reauthGithubStart, {}));
    } catch (cause) {
      setError(errorMessage(cause, t("common.unknownError")));
    } finally {
      setBusy(false);
    }
  }

  const fieldError = error && reauth.error instanceof OpError ? reauth.error.details?.field : undefined;
  const ready = method === "password" ? password !== "" : method === "totp" ? code.trim().length >= 6 : true;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {methods.length > 1 && (
        <Segmented
          aria-label={t("auth.reauth.method")}
          value={method}
          onValueChange={(next) => {
            setChosen(next as Method);
            setDevice(null);
            setError(null);
          }}
          className="max-w-full flex-wrap self-start"
        >
          {methods.map((m) => (
            <SegmentedItem key={m} value={m}>
              {t(`auth.reauth.methods.${m}`)}
            </SegmentedItem>
          ))}
        </Segmented>
      )}
      {method === "password" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reauth-password">{t("auth.reauth.password")}</Label>
          <Input
            id="reauth-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={fieldError === "password" ? true : undefined}
            autoFocus
          />
        </div>
      )}
      {method === "totp" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reauth-code">{t("auth.reauth.code")}</Label>
          <Input
            id="reauth-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={32}
            className="w-48 font-mono tracking-[0.2em]"
            aria-invalid={fieldError === "code" ? true : undefined}
            autoFocus
          />
        </div>
      )}
      {method === "passkey" && <p className="m-0 text-[13px] text-muted-foreground">{t("auth.reauth.passkeyHint")}</p>}
      {method === "github" && data.github && (
        <p className="m-0 text-[13px] text-muted-foreground">
          {t(device ? "auth.reauth.githubCode" : "auth.reauth.githubHint", { login: data.github.login })}
        </p>
      )}
      {method === "github" && device && <DeviceCodeCard code={device} waiting />}
      {error && <ErrorLine text={error} />}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        {!(method === "github" && device) && (
          <Button type="submit" variant="primary" disabled={busy || !ready} aria-busy={busy}>
            {method === "passkey" && <IconFingerprint size={16} stroke={1.8} aria-hidden="true" />}
            {method === "github" && <GitHubMark size={16} />}
            {busy ? t("auth.reauth.confirming") : t(submitLabel[method])}
          </Button>
        )}
      </div>
    </form>
  );
}

const submitLabel = {
  password: "auth.reauth.confirm",
  totp: "auth.reauth.confirm",
  passkey: "auth.reauth.usePasskey",
  github: "auth.reauth.confirmGithub",
} as const satisfies Record<Method, string>;

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="m-0 rounded-control bg-chip-red-bg px-3 py-2 text-[12.5px] text-chip-red-fg">
      {text}
    </p>
  );
}
