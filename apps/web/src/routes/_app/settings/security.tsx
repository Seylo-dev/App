// Settings > Security (your account): your password, authenticator app
// with recovery codes, passkeys, a linked GitHub login and the browsers
// you are signed in on. Name, email and avatar are on Personal details.

import { auth } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { ButtonSkeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { errorText, QueryView } from "../../../components/settings/op-state";
import { Field, FormActions, FormGrid, SettingsPage } from "../../../components/settings/page";
import { GithubLinkSection } from "../../../components/settings/security/github-link";
import { PasskeysSection } from "../../../components/settings/security/passkeys";
import { SessionsSection } from "../../../components/settings/security/sessions";
import { TwoFactorSection } from "../../../components/settings/security/two-factor";
import { FieldSkeleton, FormActionsSkeleton } from "../../../components/settings/skeletons";
import { t } from "../../../i18n/t";
import { isReauthCancelled } from "../../../lib/reauth";

export const Route = createFileRoute("/_app/settings/security")({
  component: SecurityPage,
});

function SecurityPage() {
  const security = useOp(auth.security, {});
  return (
    <SettingsPage title={t("settingsSecurity.title")} subtitle={t("settingsSecurity.subtitle")}>
      <QueryView query={security} skeleton={<SecuritySkeleton />} className="flex flex-col gap-5">
        {(data) => (
          <>
            <PasswordSection passwordSet={data.passwordSet} />
            <TwoFactorSection enabled={data.totp.enabled} confirmedAt={data.totp.confirmedAt} recoveryCodesLeft={data.recoveryCodesLeft} />
            <PasskeysSection passkeys={data.passkeys} available={data.passkeysAvailable} />
            <GithubLinkSection github={data.github} available={data.githubAvailable} />
          </>
        )}
      </QueryView>
      <SessionsSection />
    </SettingsPage>
  );
}

/** Password, two-factor, passkeys and GitHub sign-in while the account's security loads. */
function SecuritySkeleton() {
  return (
    <>
      <SectionCardSkeleton titleWidth="w-24" description="w-80">
        <FormGrid>
          <FieldSkeleton span hint={false} labelWidth="w-32" />
          <FieldSkeleton hint={false} labelWidth="w-28" />
          <FieldSkeleton hint={false} labelWidth="w-32" />
        </FormGrid>
        <FormActionsSkeleton width="w-36" />
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-48" description="w-96">
        <div className="flex gap-2">
          <ButtonSkeleton className="w-44" />
        </div>
      </SectionCardSkeleton>
      <SectionCardSkeleton flush titleWidth="w-20" description="w-96" actions={<ButtonSkeleton size="sm" className="w-28" />}>
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 border-t border-divider px-[18px] py-3.5">
            <SkeletonText className="w-32 text-[13px]" />
            <SkeletonText className="ml-auto w-24 text-[13px]" />
          </div>
        ))}
      </SectionCardSkeleton>
      <SectionCardSkeleton titleWidth="w-36" description="w-96">
        <ButtonSkeleton className="w-44" />
      </SectionCardSkeleton>
    </>
  );
}

const minPassword = 10;

function PasswordSection({ passwordSet }: { passwordSet: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const change = useSettingsMutation(auth.changePassword, {
    invalidates: [auth.security, auth.listSessions],
    failure: false,
    success: (out) => t("settingsSecurity.password.changed", { count: out.revokedSessions }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setAgain("");
      setError(null);
    },
    // A first password needs a fresh sign-in; closing that dialog is not an error to show.
    onError: (e) => setError(isReauthCancelled(e) ? null : errorText(e)),
  });
  const tooShort = next.length > 0 && next.length < minPassword;
  const mismatch = again.length > 0 && again !== next;
  const ready = next.length >= minPassword && again === next && (!passwordSet || current.length > 0);

  return (
    <SectionCard
      title={t("settingsSecurity.password.title")}
      description={t(passwordSet ? "settingsSecurity.password.description" : "settingsSecurity.password.setFirst")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) change.mutate({ ...(passwordSet ? { currentPassword: current } : {}), newPassword: next });
        }}
        className="flex flex-col gap-3"
      >
        <FormGrid>
          {passwordSet && (
            <Field label={t("settingsSecurity.password.current")} htmlFor="pw-current" span>
              <Input
                id="pw-current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className="sm:max-w-[calc(50%-6px)]"
              />
            </Field>
          )}
          <Field
            label={t("settingsSecurity.password.new")}
            hint={t("settingsSecurity.password.rule", { count: minPassword })}
            error={tooShort ? t("settingsSecurity.password.rule", { count: minPassword }) : null}
            htmlFor="pw-new"
          >
            <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field
            label={t("settingsSecurity.password.again")}
            error={mismatch ? t("settingsSecurity.password.mismatch") : null}
            htmlFor="pw-again"
          >
            <Input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
        </FormGrid>
        {error && (
          <p role="alert" className="m-0 text-[12.5px] text-chip-red-fg">
            {error}
          </p>
        )}
        <FormActions>
          <span className="mr-auto self-center text-xs text-muted-foreground">{t("settingsSecurity.password.signsOut")}</span>
          <Button type="submit" variant="primary" disabled={!ready || change.isPending}>
            {passwordSet ? t("settingsSecurity.password.change") : t("settingsSecurity.password.set")}
          </Button>
        </FormActions>
      </form>
    </SectionCard>
  );
}
