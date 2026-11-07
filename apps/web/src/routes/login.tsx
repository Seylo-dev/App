// Sign-in: email and password, a passkey, or GitHub (device flow). When
// the account has two-factor authentication the panel answers with a
// short ticket instead of a session; the second step takes an
// authenticator code or a recovery code (auth.verifySecondFactor).

import { auth, OpError, type OpOutput, setup } from "@seylo/ops";
import { opQueryKey, useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Input, Label } from "@seylo/ui/components/input";
import { toast } from "@seylo/ui/components/toast";
import { IconFingerprint } from "@tabler/icons-react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthFrame } from "../components/auth/auth-frame";
import { DeviceCodeCard, type DeviceCodeView, GitHubMark, useDevicePolling } from "../components/auth/device-code";
import { t } from "../i18n/t";
import { errorMessage, opClient, queryClient } from "../lib/api";
import { safeRedirectPath } from "../lib/redirect";
import { useBoot } from "../lib/theme";
import { ensureViewer } from "../lib/viewer";
import { getPasskeyAssertion, passkeysSupported } from "../lib/webauthn";

type LoginResult = OpOutput<typeof auth.login>;
type Challenge = NonNullable<LoginResult["challenge"]>;

export const Route = createFileRoute("/login")({
  // Only paths on this panel, so the link cannot send people elsewhere after sign-in.
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    // The key is always returned: the router keeps raw search values a route leaves out.
    return { redirect: safeRedirectPath(search.redirect, window.location.origin) };
  },
  beforeLoad: async ({ context }) => {
    // Already signed in: skip the form.
    const signedIn = await ensureViewer(context).then(
      () => true,
      () => false,
    );
    if (signedIn) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { redirect: next } = Route.useSearch();
  const boot = useBoot();
  const status = useOp(setup.status, {}, { retry: false });
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [device, setDevice] = useState<DeviceCodeView | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The panel refused this browser's session because it sent two cookies (another site on the address set one).
  const whoamiError = queryClient.getQueryState(opQueryKey(auth.whoami, {}))?.error;
  const duplicateSession = whoamiError instanceof OpError && whoamiError.details?.reason === "duplicateSession";

  const finish = (result: LoginResult) => {
    if (result.status === "secondFactor" && result.challenge) {
      setDevice(null);
      setChallenge(result.challenge);
      return;
    }
    signedIn(result.viewer);
  };
  const signedIn = (viewer: LoginResult["viewer"]) => {
    queryClient.setQueryData(opQueryKey(auth.whoami, {}), { viewer, via: "session" });
    // The MCP consent page is served by the panel, not the web app: load it for real.
    if (next?.startsWith("/oauth/")) window.location.assign(next);
    else void navigate({ href: next ?? "/" });
  };

  const githubStart = useOpMutation(auth.githubStart, {
    onSuccess: (code) => {
      setGithubError(null);
      setDevice(code);
      window.open(code.verificationUri, "_blank", "noopener");
    },
    onError: (error) => setGithubError(errorMessage(error, t("common.unknownError"))),
  });
  useDevicePolling(
    device,
    (ticket) => opClient.call(auth.githubPoll, { ticket }),
    (result) => {
      if (result.status === "done" && result.result) return finish(result.result);
      setDevice(null);
      setGithubError(
        t(
          result.status === "noAccount"
            ? "auth.github.noAccount"
            : result.status === "denied"
              ? "auth.github.denied"
              : "auth.github.expired",
        ),
      );
    },
    (error) => {
      setDevice(null);
      setGithubError(errorMessage(error, t("common.unknownError")));
    },
  );

  return (
    <AuthFrame>
      <Card className="w-full max-w-[400px] gap-4 p-7">
        {challenge ? (
          <SecondFactor
            challenge={challenge}
            onDone={signedIn}
            onBack={(notice) => {
              setChallenge(null);
              setNotice(notice ?? null);
            }}
          />
        ) : device ? (
          <>
            <div className="flex flex-col gap-1">
              <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{t("auth.github.title")}</h1>
              <p className="m-0 text-[13.5px] text-muted-foreground">{t("auth.github.hint")}</p>
            </div>
            <DeviceCodeCard code={device} waiting />
            <Button variant="ghost" onClick={() => setDevice(null)}>
              {t("auth.backToSignIn")}
            </Button>
          </>
        ) : (
          <>
            <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{t("auth.title", { name: boot?.name ?? "" })}</h1>
            {boot?.loginMessage && <p className="m-0 text-[13.5px] whitespace-pre-line text-ink-strong">{boot.loginMessage}</p>}
            {status.data && !status.data.ownerExists && <Alert tone="info">{t("auth.noOwner")}</Alert>}
            {duplicateSession && <Alert tone="warning">{t("auth.duplicateSession")}</Alert>}
            {notice && <Alert tone="warning">{notice}</Alert>}
            <PasswordForm onResult={finish} />
            <OtherWays
              githubAvailable={status.data?.githubAvailable ?? false}
              onResult={finish}
              onGithub={() => githubStart.mutate({})}
              githubPending={githubStart.isPending}
            />
            {githubError && (
              <p role="alert" className="m-0 text-[13px] text-destructive">
                {githubError}
              </p>
            )}
          </>
        )}
      </Card>
    </AuthFrame>
  );
}

function PasswordForm({ onResult }: { onResult: (result: LoginResult) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useOpMutation(auth.login, { onSuccess: onResult });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ email, password });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("auth.email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username webauthn"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">{t("auth.password")}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {login.error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {errorMessage(login.error, t("common.unknownError"))}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={login.isPending}>
        {login.isPending ? t("auth.submitting") : t("auth.submit")}
      </Button>
    </form>
  );
}

function OtherWays({
  githubAvailable,
  githubPending,
  onGithub,
  onResult,
}: {
  githubAvailable: boolean;
  githubPending: boolean;
  onGithub: () => void;
  onResult: (result: LoginResult) => void;
}) {
  const [passkeyPending, setPasskeyPending] = useState(false);
  const canPasskey = passkeysSupported();
  if (!canPasskey && !githubAvailable) return null;

  const signInWithPasskey = async () => {
    setPasskeyPending(true);
    try {
      const begin = await opClient.call(auth.passkeyLoginBegin, {});
      const response = await getPasskeyAssertion(begin.options);
      onResult(await opClient.call(auth.passkeyLoginFinish, { ticket: begin.ticket, response }));
    } catch (error) {
      // Closing the browser's passkey prompt is not an error worth a toast.
      if (!(error instanceof DOMException && error.name === "NotAllowedError")) {
        toast.error(t("auth.passkeyFailed"), { description: errorMessage(error, t("auth.passkeyFailedHint")) });
      }
    } finally {
      setPasskeyPending(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-divider" />
        {t("auth.or")}
        <span className="h-px flex-1 bg-divider" />
      </div>
      <div className="flex flex-col gap-2">
        {canPasskey && (
          <Button onClick={() => void signInWithPasskey()} disabled={passkeyPending}>
            <IconFingerprint size={17} stroke={1.8} aria-hidden="true" />
            {t("auth.passkey")}
          </Button>
        )}
        {githubAvailable && (
          <Button variant="dark" onClick={onGithub} disabled={githubPending}>
            <GitHubMark />
            {t("auth.github.continue")}
          </Button>
        )}
      </div>
    </>
  );
}

function SecondFactor({
  challenge,
  onDone,
  onBack,
}: {
  challenge: Challenge;
  onDone: (viewer: LoginResult["viewer"]) => void;
  /** Back to the password step, with a reason when the ticket is used up. */
  onBack: (notice?: string) => void;
}) {
  const [method, setMethod] = useState<"totp" | "recovery">(challenge.methods.includes("totp") ? "totp" : "recovery");
  const [code, setCode] = useState("");
  const verify = useOpMutation(auth.verifySecondFactor, {
    onSuccess: (result) => {
      if (method === "recovery" && result.recoveryCodesLeft <= 3) {
        toast.warning(t("auth.secondFactor.fewLeft", { count: result.recoveryCodesLeft }));
      }
      onDone(result.viewer);
    },
    onError: (error) => {
      // At zero attempts the ticket is dead: start over with the password.
      if (error.details?.attemptsLeft === "0") onBack(t("auth.secondFactor.tooManyAttempts"));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    verify.mutate({ ticket: challenge.ticket, method, code: code.replace(/\s/g, "") });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{t("auth.secondFactor.title")}</h1>
        <p className="m-0 text-[13.5px] text-muted-foreground">
          {method === "totp" ? t("auth.secondFactor.totpHint") : t("auth.secondFactor.recoveryHint")}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code">{method === "totp" ? t("auth.secondFactor.code") : t("auth.secondFactor.recoveryCode")}</Label>
        <Input
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode={method === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          maxLength={32}
          minLength={6}
          required
          autoFocus
          className="font-mono tracking-[0.2em]"
        />
      </div>
      {verify.error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {errorMessage(verify.error, t("common.unknownError"))}
          {verify.error.details?.attemptsLeft &&
            ` ${t("auth.secondFactor.attemptsLeft", { count: Number(verify.error.details.attemptsLeft) })}`}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={verify.isPending || code.trim().length < 6}>
        {t("auth.secondFactor.verify")}
      </Button>
      <div className="flex flex-wrap justify-between gap-2 text-[13px]">
        <button type="button" onClick={() => onBack()} className="cursor-pointer border-0 bg-transparent p-0 text-link">
          {t("auth.backToSignIn")}
        </button>
        {challenge.methods.length > 1 && (
          <button
            type="button"
            onClick={() => {
              setMethod(method === "totp" ? "recovery" : "totp");
              setCode("");
            }}
            className="cursor-pointer border-0 bg-transparent p-0 text-link"
          >
            {method === "totp" ? t("auth.secondFactor.useRecovery") : t("auth.secondFactor.useTotp")}
          </button>
        )}
      </div>
    </form>
  );
}
