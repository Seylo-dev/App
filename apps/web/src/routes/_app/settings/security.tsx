// Settings > Security (your account): your name, password, authenticator
// app with recovery codes, passkeys, a linked GitHub login and the
// browsers you are signed in on.

import { auth } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { errorText, QueryView } from "../../../components/settings/op-state";
import { Field, FormActions, FormGrid, SettingsPage } from "../../../components/settings/page";
import { GithubLinkSection } from "../../../components/settings/security/github-link";
import { PasskeysSection } from "../../../components/settings/security/passkeys";
import { SessionsSection } from "../../../components/settings/security/sessions";
import { TwoFactorSection } from "../../../components/settings/security/two-factor";
import { t } from "../../../i18n/t";
import { isReauthCancelled } from "../../../lib/reauth";

export const Route = createFileRoute("/_app/settings/security")({
  component: SecurityPage,
});

function SecurityPage() {
  const security = useOp(auth.security, {});
  return (
    <SettingsPage title={t("settingsSecurity.title")} subtitle={t("settingsSecurity.subtitle")}>
      <ProfileSection />
      <QueryView query={security}>
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

function ProfileSection() {
  const me = useOp(auth.whoami, {});
  return (
    <SectionCard title={t("settingsSecurity.profile.title")}>
      <QueryView query={me} skeletonRows={1}>
        {(data) => <ProfileForm key={data.viewer.name} name={data.viewer.name} email={data.viewer.email} />}
      </QueryView>
    </SectionCard>
  );
}

function ProfileForm({ name: initial, email }: { name: string; email: string }) {
  const [name, setName] = useState(initial);
  const save = useSettingsMutation(auth.updateProfile, { invalidates: [auth.whoami], success: t("settings.saved") });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ name: name.trim() });
      }}
      className="flex flex-col gap-3"
    >
      <FormGrid>
        <Field label={t("settingsPeople.user.name")} htmlFor="profile-name">
          <Input id="profile-name" value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("settingsPeople.invite.email")} hint={t("settingsSecurity.profile.emailHint")} htmlFor="profile-email">
          <Input id="profile-email" value={email} readOnly className="bg-field text-muted-foreground" />
        </Field>
      </FormGrid>
      <FormActions>
        <Button type="submit" variant="primary" disabled={name.trim() === initial || save.isPending}>
          {t("settings.save")}
        </Button>
      </FormActions>
    </form>
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
