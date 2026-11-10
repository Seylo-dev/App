// The Profile card on Settings > Personal details: name and email, saved
// together. The email is what the person signs in with, so the panel may
// ask them to confirm it's you first (the re-auth dialog opens by itself,
// lib/reauth.ts); a taken email shows under the field.

import { auth, OpError, users } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { isReauthCancelled } from "../../../lib/reauth";
import { invalidateOps } from "../mutation";
import { errorText, toastError } from "../op-state";
import { Field, FormActions, FormGrid } from "../page";

export function ProfileCard({ name: initialName, email: initialEmail }: { name: string; email: string }) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [emailError, setEmailError] = useState<string | null>(null);
  const rename = useOpMutation(auth.updateProfile);
  const changeEmail = useOpMutation(auth.changeEmail);
  const nameChanged = name.trim() !== initialName;
  const emailChanged = email.trim().toLowerCase() !== initialEmail;
  const pending = rename.isPending || changeEmail.isPending;

  // The name and then the email; the page refetches once at the end, so the form is not reset between the two.
  async function save() {
    setEmailError(null);
    try {
      if (nameChanged) await rename.mutateAsync({ name: name.trim() });
      if (emailChanged) {
        const out = await changeEmail.mutateAsync({ email: email.trim() });
        toast.success(t(out.oldAddressNotified ? "settingsProfile.profile.emailChangedNotified" : "settingsProfile.profile.emailChanged"));
      } else {
        toast.success(t("settingsProfile.profile.saved"));
      }
    } catch (error) {
      // A closed "confirm it's you" dialog is not an error to show; a taken email goes under its field.
      if (isReauthCancelled(error)) return;
      if (error instanceof OpError && (error.details?.field === "email" || error.code === "CONFLICT")) setEmailError(errorText(error));
      else toastError(error);
    } finally {
      await invalidateOps([auth.whoami, users.list]);
    }
  }

  return (
    <SectionCard title={t("settingsProfile.profile.title")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-3"
      >
        <FormGrid>
          <Field label={t("settingsProfile.profile.name")} htmlFor="profile-name">
            <Input id="profile-name" value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label={t("settingsProfile.profile.email")}
            hint={t("settingsProfile.profile.emailHint")}
            error={emailError}
            htmlFor="profile-email"
          >
            <Input
              id="profile-email"
              type="email"
              value={email}
              maxLength={254}
              autoComplete="email"
              aria-invalid={emailError ? true : undefined}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(null);
              }}
            />
          </Field>
        </FormGrid>
        <FormActions>
          <Button type="submit" variant="primary" disabled={(!nameChanged && !emailChanged) || email.trim() === "" || pending}>
            {t("settings.save")}
          </Button>
        </FormActions>
      </form>
    </SectionCard>
  );
}
