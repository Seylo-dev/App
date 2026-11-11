// The Notes and Settings tabs. Notes are Markdown text for the team (not
// secret). Settings renames the service and deletes it with type-to-confirm.

import { services } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import { IconPencil } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { Markdown } from "../../markdown";
import { VersionCard } from "../database/version-card";
import { CodeEditor } from "../editor/code-editor";
import { Field } from "../field";
import { formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { MutationError } from "../op-state";
import { isDatabaseKind } from "../status";
import type { ServiceDetail } from "../use-service";

const namePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function NotesPage({ service }: { service: ServiceDetail }) {
  const [text, setText] = useState(service.notes);
  const [editing, setEditing] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const save = useOpMutation(services.setNotes, {
    onSuccess: (res) => {
      setSavedAt(res.updatedAt);
      setEditing(false);
      invalidate(services.get);
      toast.success(t("service.saved"));
    },
  });
  const saved = save.data?.notes ?? service.notes;
  const dirty = text !== saved;
  const onSave = () => save.mutate({ serviceId: service.id, notes: text });
  const cancel = () => {
    setText(saved);
    setEditing(false);
    save.reset();
  };
  return (
    <SectionCard
      title={t("serviceSettings.notes.title")}
      description={t("serviceSettings.notes.description")}
      flush
      actions={
        !editing && (
          <Button size="sm" onClick={() => setEditing(true)}>
            <IconPencil size={14} />
            {saved.trim() ? t("serviceSettings.notes.edit") : t("serviceSettings.notes.add")}
          </Button>
        )
      }
      footer={
        editing ? (
          <>
            <Button size="sm" variant="primary" onClick={onSave} disabled={!dirty || save.isPending}>
              {save.isPending ? t("service.saving") : t("service.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              {t("serviceSettings.notes.cancel")}
            </Button>
            {dirty && <span className="text-chip-amber-fg">{t("service.unsavedChanges")}</span>}
            <MutationError error={save.error} />
          </>
        ) : savedAt ? (
          <span>{t("serviceSettings.notes.savedAt", { when: formatRelative(savedAt) })}</span>
        ) : undefined
      }
    >
      <div className="border-t border-divider">
        {editing ? (
          <CodeEditor
            value={text}
            language="markdown"
            onChange={setText}
            onSave={onSave}
            height={420}
            aria-label={t("serviceSettings.notes.title")}
            options={{ wordWrap: "on", lineNumbers: "off", renderLineHighlight: "none", padding: { top: 16, bottom: 16 } }}
          />
        ) : saved.trim() ? (
          <Markdown aria-label={t("serviceSettings.notes.rendered")} className="px-5 py-4">
            {saved}
          </Markdown>
        ) : (
          <EmptyState compact title={t("serviceSettings.notes.empty")} description={t("serviceSettings.notes.emptyHint")} />
        )}
      </div>
    </SectionCard>
  );
}

export function SettingsPage({ service }: { service: ServiceDetail }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [name, setName] = useState(service.name);
  const [confirm, setConfirm] = useState(false);
  const rename = useOpMutation(services.update, {
    onSuccess: () => {
      invalidate(services.get, services.list);
      toast.success(t("serviceSettings.renamed"));
    },
  });
  const remove = useOpMutation(services.remove, {
    onSuccess: () => {
      invalidate(services.list);
      void navigate({ to: "/p/$projectId", params: { projectId: service.projectId } });
    },
  });
  const valid = namePattern.test(name) && name.length <= 40;
  const member = service.parentId !== null;

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={t("serviceSettings.name.title")} description={t("serviceSettings.name.description")}>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && name !== service.name) rename.mutate({ serviceId: service.id, name });
          }}
        >
          {/* The hint goes under the input and the button, so the button sits on the input's row. */}
          <Field label={t("serviceSettings.name.label")} htmlFor="s-name" hint={t("serviceSettings.name.hint")} className="max-w-[440px]">
            <div className="flex items-center gap-2">
              <Input
                id="s-name"
                className="min-w-0 flex-1 font-mono"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                aria-invalid={!valid}
                disabled={member}
              />
              <Button type="submit" variant="primary" disabled={!valid || name === service.name || rename.isPending || member}>
                {t("serviceSettings.name.rename")}
              </Button>
            </div>
          </Field>
          <MutationError error={rename.error} />
        </form>
        {member && <Callout tone="neutral">{t("serviceSettings.member")}</Callout>}
      </SectionCard>
      {isDatabaseKind(service.kind) && <VersionCard service={service} />}
      <SectionCard title={t("serviceSettings.delete.title")} description={t("serviceSettings.delete.description")} danger>
        {service.protected ? (
          <Callout tone="neutral">{t("serviceSettings.delete.protected")}</Callout>
        ) : member ? (
          <Callout tone="neutral">{t("serviceSettings.member")}</Callout>
        ) : (
          <Button variant="destructive" className="self-start" onClick={() => setConfirm(true)}>
            {t("serviceSettings.delete.button", { name: service.name })}
          </Button>
        )}
      </SectionCard>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("serviceSettings.delete.confirmTitle", { name: service.name })}
        description={service.kind === "compose" ? t("serviceSettings.delete.confirmStack") : t("serviceSettings.delete.confirmBody")}
        confirmText={service.name}
        confirmLabel={t("serviceSettings.delete.confirm")}
        destructive
        onConfirm={() => remove.mutateAsync({ serviceId: service.id, confirmName: service.name }).then(() => undefined)}
      />
    </div>
  );
}
