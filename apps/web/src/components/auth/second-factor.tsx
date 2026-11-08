// The second sign-in step for accounts with an authenticator app: a 6-digit
// code, or one of the recovery codes when the account still has one
// (challenge.hasRecoveryCodes). auth.verifySecondFactor turns the ticket
// into a session.

import { auth, type OpOutput } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input, Label } from "@seylo/ui/components/input";
import { toast } from "@seylo/ui/components/toast";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";

type LoginResult = OpOutput<typeof auth.login>;
type Challenge = NonNullable<LoginResult["challenge"]>;

export function SecondFactor({
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
        {challenge.methods.length > 1 && challenge.hasRecoveryCodes && (
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
      {!challenge.hasRecoveryCodes && <p className="m-0 text-[13px] text-muted-foreground">{t("auth.secondFactor.noRecoveryCodes")}</p>}
    </form>
  );
}
