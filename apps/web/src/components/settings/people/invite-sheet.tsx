// Invite someone: an email, admin or member, and for members the projects
// and services they get with what they may do there. The link is shown
// once after creating, whether or not it was emailed.

import { invites, type OpOutput } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Input } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { compactActions, grantable } from "../actions";
import { type GrantDraft, GrantListEditor } from "../grant-scopes";
import { useSettingsMutation } from "../mutation";
import { Field } from "../page";

const expiryChoices = [1, 3, 7, 14, 30] as const;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-xl">{open && <InviteForm onDone={() => onOpenChange(false)} />}</SheetContent>
    </Sheet>
  );
}

function InviteForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [grants, setGrants] = useState<GrantDraft[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [sendEmail, setSendEmail] = useState(true);
  const [created, setCreated] = useState<OpOutput<typeof invites.create> | null>(null);
  const create = useSettingsMutation(invites.create, { invalidates: [invites.list], onSuccess: setCreated });

  const emailOk = emailPattern.test(email.trim());
  const grantsOk = role === "admin" || grants.every((g) => g.actions.size > 0);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!emailOk || !grantsOk) return;
    create.mutate({
      email: email.trim().toLowerCase(),
      role,
      grants:
        role === "admin"
          ? []
          : grants.map((g) => ({ scopeType: g.scopeType, scopeId: g.scopeId, actions: compactActions(g.actions, grantable(g.scopeType)) })),
      expiresInDays,
      sendEmail,
    });
  }

  if (created) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>{t("settingsPeople.invite.createdTitle")}</SheetTitle>
          <SheetDescription>{t("settingsPeople.invite.createdDescription", { email: created.invite.email })}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <Alert tone={created.emailed ? "success" : "info"}>
            {created.emailed ? t("settingsPeople.invite.emailed") : t("settingsPeople.invite.notEmailed")}
          </Alert>
          <Field label={t("settingsPeople.invite.link")} hint={t("settingsPeople.invite.linkHint")}>
            <CopyField value={created.link} aria-label={t("settingsPeople.invite.link")} />
          </Field>
        </SheetBody>
        <SheetFooter>
          <Button variant="primary" onClick={onDone}>
            {t("settings.done")}
          </Button>
        </SheetFooter>
      </>
    );
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <SheetHeader>
        <SheetTitle>{t("settingsPeople.invite.title")}</SheetTitle>
        <SheetDescription>{t("settingsPeople.invite.description")}</SheetDescription>
      </SheetHeader>
      <SheetBody>
        <Field label={t("settingsPeople.invite.email")} htmlFor="invite-email">
          <Input id="invite-email" type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t("settingsPeople.invite.role")}>
          <RadioGroup
            value={role}
            onValueChange={(v) => setRole(v as "admin" | "member")}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <RadioCard value="member" title={t("roles.member")} description={t("settingsPeople.roleHints.member")} />
            <RadioCard value="admin" title={t("roles.admin")} description={t("settingsPeople.roleHints.admin")} />
          </RadioGroup>
        </Field>
        {role === "member" && (
          <Field label={t("settingsPeople.invite.access")} hint={t("settingsPeople.invite.accessHint")}>
            <GrantListEditor value={grants} onChange={setGrants} />
          </Field>
        )}
        <Field label={t("settingsPeople.invite.expires")} htmlFor="invite-expiry">
          <Select value={String(expiresInDays)} onValueChange={(v) => setExpiresInDays(Number(v))}>
            <SelectTrigger id="invite-expiry" className="sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {expiryChoices.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {t("settingsPeople.invite.days", { count: days })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-center gap-2">
          <Checkbox id="invite-send" checked={sendEmail} onCheckedChange={(v) => setSendEmail(v === true)} />
          <label htmlFor="invite-send" className="cursor-pointer text-[13px] text-ink-strong">
            {t("settingsPeople.invite.sendEmail")}
          </label>
        </div>
        {role === "member" && grants.length === 0 && <Alert tone="neutral">{t("settingsPeople.invite.noGrants")}</Alert>}
      </SheetBody>
      <SheetFooter>
        <Button onClick={onDone}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!emailOk || !grantsOk || create.isPending}>
          {create.isPending ? t("settings.saving") : t("settingsPeople.invite.create")}
        </Button>
      </SheetFooter>
    </form>
  );
}
