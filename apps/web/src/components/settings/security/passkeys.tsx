// Passkeys: add one with the browser's WebAuthn prompt, name it, remove it.
// Only offered once the panel has a domain (WebAuthn needs one).

import { auth, type OpOutput } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { DataTable } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { IconFingerprint, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { formatDate, formatRelative } from "../format";
import { invalidateOps, useSettingsMutation } from "../mutation";
import { toastError } from "../op-state";

type Passkey = OpOutput<typeof auth.security>["passkeys"][number];

export function PasskeysSection({ passkeys, available }: { passkeys: Passkey[]; available: boolean }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const begin = useSettingsMutation(auth.passkeyRegisterBegin, { failure: false });
  const finish = useSettingsMutation(auth.passkeyRegisterFinish, { failure: false });
  const remove = useSettingsMutation(auth.passkeyRemove, { invalidates: [auth.security], success: t("settingsSecurity.passkeys.removed") });
  const supported = typeof window !== "undefined" && browserSupportsWebAuthn();

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { ticket, options } = await begin.mutateAsync({});
      const response = await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
      await finish.mutateAsync({ ticket, name: name.trim(), response: response as unknown as Record<string, unknown> });
      await invalidateOps([auth.security]);
      toast.success(t("settingsSecurity.passkeys.added"));
      setAdding(false);
      setName("");
    } catch (error) {
      // The browser throws NotAllowedError when the person cancels the prompt; that is not worth a red toast.
      if (error instanceof Error && error.name === "NotAllowedError") toast.info(t("settingsSecurity.passkeys.cancelled"));
      else toastError(error, t("settingsSecurity.passkeys.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title={t("settingsSecurity.passkeys.title")}
      description={t("settingsSecurity.passkeys.description")}
      flush
      actions={
        available &&
        supported &&
        !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <IconPlus size={15} stroke={1.8} />
            {t("settingsSecurity.passkeys.add")}
          </Button>
        )
      }
    >
      {!available && (
        <Alert tone="neutral" className="mx-5 mb-4">
          {t("settingsSecurity.passkeys.needsDomain")}
        </Alert>
      )}
      {available && !supported && (
        <Alert tone="neutral" className="mx-5 mb-4">
          {t("settingsSecurity.passkeys.unsupported")}
        </Alert>
      )}
      {adding && (
        <form onSubmit={add} className="mx-5 mb-4 flex flex-wrap items-end gap-2 rounded-control bg-raised p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label htmlFor="passkey-name" className="text-[12.5px] font-medium text-ink-strong">
              {t("settingsSecurity.passkeys.name")}
            </label>
            <Input
              id="passkey-name"
              value={name}
              maxLength={60}
              placeholder={t("settingsSecurity.passkeys.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {t("settingsSecurity.passkeys.continue")}
          </Button>
          <Button variant="ghost" onClick={() => setAdding(false)}>
            {t("common.cancel")}
          </Button>
        </form>
      )}
      {(available || passkeys.length > 0) && (
        <DataTable<Passkey>
          bare
          aria-label={t("settingsSecurity.passkeys.title")}
          rows={passkeys}
          getRowId={(p) => p.id}
          empty={<EmptyState compact icon={<IconFingerprint />} title={t("settingsSecurity.passkeys.empty")} />}
          rowActions={(p) => [{ label: t("settings.remove"), destructive: true, onSelect: () => setRemoving(p) }]}
          columns={[
            { id: "name", header: t("settingsSecurity.passkeys.name"), cell: (p) => <span className="font-medium">{p.name}</span> },
            { id: "added", header: t("settingsSecurity.passkeys.addedOn"), cell: (p) => formatDate(p.createdAt), hideOnMobile: true },
            {
              id: "used",
              header: t("settingsKeys.lastUsed"),
              align: "right",
              cell: (p) => (
                <span className="text-muted-foreground">{p.lastUsedAt ? formatRelative(p.lastUsedAt) : t("settings.never")}</span>
              ),
            },
          ]}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("settingsSecurity.passkeys.removeTitle", { name: removing?.name ?? "" })}
        description={t("settingsSecurity.passkeys.removeDescription")}
        confirmLabel={t("settings.remove")}
        destructive
        onConfirm={() => (removing ? remove.mutateAsync({ passkeyId: removing.id }).then(() => undefined) : undefined)}
      />
    </SectionCard>
  );
}
