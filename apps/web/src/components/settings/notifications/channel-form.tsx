// The "Add a channel" card of the Notifications board: a kind picker (4 x 2
// segmented grid), the fields of that kind, Send test and Save. The same
// card edits a saved channel; secrets left empty keep their stored value.

import { notifications } from "@seylo/ops";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { formatDuration } from "../format";
import { useSettingsMutation } from "../mutation";
import { errorText } from "../op-state";
import {
  buildChannelConfig,
  type ChannelKind,
  emptyForm,
  type FieldError,
  type ChannelForm as FormState,
  formFromView,
} from "./channel-config";

type Channel = notifications.Channel;

const refresh = [notifications.channels, notifications.defaults];

export function ChannelForm({ editing, onDone }: { editing: Channel | null; onDone: () => void }) {
  const [kind, setKind] = useState<ChannelKind>(editing?.kind ?? "smtp");
  const [name, setName] = useState(editing?.name ?? "");
  const [form, setForm] = useState<FormState>(editing ? formFromView(editing.config) : emptyForm);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [isDefault, setIsDefault] = useState(editing?.isDefault ?? false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const create = useSettingsMutation(notifications.createChannel, {
    invalidates: refresh,
    success: t("settingsNotifications.saved"),
    onSuccess: onDone,
  });
  const update = useSettingsMutation(notifications.updateChannel, {
    invalidates: refresh,
    success: t("settingsNotifications.saved"),
    onSuccess: onDone,
  });
  const remove = useSettingsMutation(notifications.deleteChannel, {
    invalidates: refresh,
    success: t("settingsNotifications.deleted"),
    onSuccess: onDone,
  });
  const test = useSettingsMutation(notifications.testChannel, {
    failure: t("settingsNotifications.testFailed"),
    onSuccess: (out) =>
      out.ok
        ? toast.success(t("settingsNotifications.testSent"), { description: formatDuration(out.durationMs) })
        : toast.error(t("settingsNotifications.testFailed"), { description: out.error ?? "" }),
  });

  const stored = editing && editing.kind === kind ? editing.secretsSet : [];
  const set = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [field]: e.target.value });
  const errorFor = (field: keyof FormState) => {
    const problem = errors.find((e) => e.field === field)?.problem;
    return problem ? t(`settingsNotifications.errors.${problem}`) : null;
  };

  function build() {
    const result = buildChannelConfig(kind, form, stored);
    setErrors(result.ok ? [] : result.errors);
    return result.ok ? result.config : null;
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const config = build();
    if (!config || !name.trim()) return;
    if (editing) update.mutate({ channelId: editing.id, name: name.trim(), config, enabled, isDefault });
    else create.mutate({ name: name.trim(), config, enabled, isDefault });
  }

  function sendTest() {
    const config = build();
    if (!config) return;
    test.mutate(editing ? { channelId: editing.id, config } : { config });
  }

  /** A text field of the current kind; `secret` fields show "stored" when one exists. */
  const field = (
    key: keyof FormState,
    opts: { mono?: boolean; secret?: boolean; span?: boolean; placeholder?: string; type?: string } = {},
  ) => {
    const id = `channel-${key}`;
    const error = errorFor(key);
    const hasStored = opts.secret && stored.includes(key);
    return (
      <div className={cn("flex min-w-0 flex-col gap-1.5", opts.span && "sm:col-span-2")}>
        <label htmlFor={id} className="text-[12.5px] font-medium text-ink-strong">
          {t(`settingsNotifications.fields.${key}`)}
        </label>
        <Input
          id={id}
          type={opts.secret ? "password" : (opts.type ?? "text")}
          autoComplete={opts.secret ? "new-password" : "off"}
          value={form[key]}
          placeholder={hasStored ? t("settingsNotifications.storedSecret") : opts.placeholder}
          aria-invalid={error ? true : undefined}
          className={cn(opts.mono && "font-mono text-[12.5px]")}
          onChange={set(key)}
        />
        {error && (
          <span role="alert" className="text-xs text-chip-red-fg">
            {error}
          </span>
        )}
      </div>
    );
  };

  return (
    <Card className="min-w-0 flex-[1_1_380px] gap-4 px-5 pt-[18px] pb-5">
      <h2 className="m-0 text-[15px] font-semibold">
        {editing ? t("settingsNotifications.editTitle") : t("settingsNotifications.addTitle")}
      </h2>
      <div
        role="radiogroup"
        aria-label={t("settingsNotifications.kind")}
        className="grid grid-cols-4 gap-0.5 rounded-control bg-muted p-[3px]"
      >
        {notifications.channelKinds.map((k) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented 4 x 2 grid as in the board, not native radios.
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            disabled={editing !== null && editing.kind !== k}
            onClick={() => {
              setKind(k);
              setErrors([]);
            }}
            className={cn(
              "h-[30px] cursor-pointer truncate rounded-chip border-0 bg-transparent px-1 text-[12.5px] text-ink-strong disabled:cursor-default disabled:opacity-40",
              kind === k && "bg-card font-medium text-foreground shadow-segment",
            )}
          >
            {t(`settingsNotifications.kinds.${k}`)}
          </button>
        ))}
      </div>
      <form onSubmit={save} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="channel-name" className="text-[12.5px] font-medium text-ink-strong">
            {t("settingsNotifications.fields.name")}
          </label>
          <Input
            id="channel-name"
            value={name}
            maxLength={60}
            placeholder={t(`settingsNotifications.namePlaceholders.${kind}`)}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {kind === "smtp" && (
          <>
            {field("host", { mono: true, placeholder: "smtp.example.com" })}
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="channel-port" className="text-[12.5px] font-medium text-ink-strong">
                {t("settingsNotifications.fields.portSecurity")}
              </label>
              <div className="flex gap-2">
                <Input
                  id="channel-port"
                  inputMode="numeric"
                  value={form.port}
                  className="w-20 font-mono text-[12.5px]"
                  onChange={set("port")}
                />
                <Select
                  value={form.security}
                  onValueChange={(security) => setForm({ ...form, security: security as FormState["security"] })}
                >
                  <SelectTrigger aria-label={t("settingsNotifications.fields.security")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="starttls">STARTTLS</SelectItem>
                    <SelectItem value="tls">TLS</SelectItem>
                    <SelectItem value="none">{t("settingsNotifications.noEncryption")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {errorFor("port") && <span className="text-xs text-chip-red-fg">{errorFor("port")}</span>}
            </div>
            {field("username")}
            {field("password", { secret: true })}
            {field("from", { placeholder: "alerts@example.com" })}
            {field("to", { placeholder: "ops@example.com, me@example.com" })}
          </>
        )}
        {kind === "webhook" && (
          <>
            {field("url", { mono: true, span: true, placeholder: "https://example.com/hooks/alerts" })}
            {field("signingSecret", { secret: true, span: true })}
          </>
        )}
        {(kind === "discord" || kind === "slack") && field("webhookUrl", { mono: true, secret: true, span: true, placeholder: "https://" })}
        {kind === "telegram" && (
          <>
            {field("botToken", { secret: true })}
            {field("chatId", { mono: true })}
          </>
        )}
        {kind === "ntfy" && (
          <>
            {field("serverUrl", { mono: true, placeholder: "https://ntfy.sh" })}
            {field("topic", { mono: true })}
            {field("accessToken", { secret: true, span: true })}
          </>
        )}
        {kind === "pushover" && (
          <>
            {field("userKey", { secret: true })}
            {field("appToken", { secret: true })}
          </>
        )}
        {kind === "gotify" && (
          <>
            {field("serverUrl", { mono: true, placeholder: "https://gotify.example.com" })}
            {field("appToken", { secret: true })}
          </>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:col-span-2">
          <label htmlFor="channel-enabled" className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-strong">
            <Switch id="channel-enabled" size="sm" checked={enabled} onCheckedChange={setEnabled} />
            {t("settingsNotifications.enabled")}
          </label>
          <label htmlFor="channel-default" className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-strong">
            <Checkbox id="channel-default" checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} />
            {t("settingsNotifications.makeDefault")}
          </label>
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-1 sm:col-span-2">
          {editing && (
            <>
              <Button variant="ghost" className="mr-auto text-chip-red-fg" onClick={() => setConfirmDelete(true)}>
                {t("common.delete")}
              </Button>
              <Button variant="ghost" onClick={onDone}>
                {t("common.cancel")}
              </Button>
            </>
          )}
          <Button className="bg-muted shadow-none" disabled={test.isPending} onClick={sendTest}>
            {test.isPending ? t("settingsNotifications.sending") : t("settingsNotifications.sendTest")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending || update.isPending}>
            {t("settingsNotifications.save")}
          </Button>
        </div>
      </form>
      {editing && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t("settingsNotifications.deleteTitle", { name: editing.name })}
          description={t("settingsNotifications.deleteDescription", { count: editing.usedBy.services })}
          confirmLabel={t("common.delete")}
          destructive
          onConfirm={() =>
            remove
              .mutateAsync({ channelId: editing.id })
              .then(() => undefined)
              .catch((e) => {
                throw new Error(errorText(e));
              })
          }
        />
      )}
    </Card>
  );
}
