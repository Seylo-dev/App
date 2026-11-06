// The Storage tab: the service's volumes and file mounts from services.get,
// each with a Files button, plus adding and removing named volumes through
// services.setVolumes (applies on the next deploy; a removed volume's data
// is deleted then). File mounts and compose members are shown read only.

import { services } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconFile, IconFolder, IconFolderOpen, IconPlus, IconTrash } from "@tabler/icons-react";
import { type FormEvent, useId, useState } from "react";
import { t } from "../../../i18n/t";
import { Field } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError } from "../op-state";
import type { ServiceDetail } from "../use-service";
import { FilesDialog } from "./files-dialog";
import { checkNewVolume, type Volume, volumeInputs, volumesOf } from "./volumes";

export function StoragePage({ service }: { service: ServiceDetail }) {
  const volumes = volumesOf(service);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Volume | null>(null);
  const invalidate = useInvalidate();
  const save = useOpMutation(services.setVolumes, {
    onSuccess: () => {
      invalidate(services.get);
      toast.success(t("serviceStorage.savedNextDeploy"));
    },
  });
  const multiNode = service.placements.length > 1;
  // A stack's volumes come from its compose file, and members follow it.
  const editable = service.kind !== "compose" && service.parentId === null;

  return (
    <>
      <Card aria-label={t("serviceStorage.title")} className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2.5 px-5 pt-4 pb-3.5">
          <h2 className="m-0 text-[15px] font-semibold">{t("serviceStorage.title")}</h2>
          <span className="text-[12.5px] text-muted-foreground">{t("serviceStorage.subtitle")}</span>
          {editable && !adding && (
            <Button size="sm" className="ml-auto" onClick={() => setAdding(true)} disabled={multiNode}>
              <IconPlus size={14} />
              {t("serviceStorage.add.button")}
            </Button>
          )}
        </div>
        {adding && (
          <AddVolume
            existing={volumes}
            pending={save.isPending}
            error={save.error}
            onCancel={() => {
              setAdding(false);
              save.reset();
            }}
            onAdd={(v) =>
              save.mutate({ serviceId: service.id, volumes: [...volumeInputs(volumes), v] }, { onSuccess: () => setAdding(false) })
            }
          />
        )}
        {volumes.length === 0
          ? !adding && (
              <div className="border-t border-divider">
                <EmptyState compact title={t("serviceStorage.empty")} description={t("serviceStorage.emptyHint")} />
              </div>
            )
          : volumes.map((v) => (
              <VolumeRow
                key={v.id}
                volume={v}
                onFiles={() => setOpen(v.name)}
                onRemove={editable && v.kind === "volume" ? () => setRemoving(v) : undefined}
              />
            ))}
        {multiNode && (
          <div className="border-t border-divider bg-raised px-5 py-2.5 text-xs text-muted-foreground">
            {editable ? t("serviceStorage.multiNode") : t("serviceStorage.perNode")}
          </div>
        )}
        {!editable && (
          <div className="border-t border-divider bg-raised px-5 py-2.5 text-xs text-muted-foreground">
            {t("serviceStorage.fromCompose")}
          </div>
        )}
      </Card>
      <FilesDialog service={service} volume={open} onClose={() => setOpen(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("serviceStorage.remove.title", { name: removing?.name ?? "" })}
        description={t("serviceStorage.remove.body")}
        confirmLabel={t("serviceStorage.remove.confirm")}
        confirmText={removing?.name}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await save.mutateAsync({ serviceId: service.id, volumes: volumeInputs(volumes.filter((v) => v.id !== removing.id)) });
        }}
      />
    </>
  );
}

function AddVolume({
  existing,
  pending,
  error,
  onAdd,
  onCancel,
}: {
  existing: readonly Volume[];
  pending: boolean;
  error: unknown;
  onAdd: (v: { name: string; mountPath: string; readOnly: boolean }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [touched, setTouched] = useState(false);
  const volume = { name: name.trim(), mountPath: mountPath.trim(), readOnly };
  const problem = checkNewVolume(volume, existing);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!problem) onAdd(volume);
  };

  return (
    <form
      onSubmit={submit}
      aria-label={t("serviceStorage.add.title")}
      className="flex flex-col gap-3 border-t border-divider bg-raised px-5 py-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("serviceStorage.add.name")} htmlFor={`${id}-name`} className="w-48">
          <Input
            id={`${id}-name`}
            className="font-mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="data"
            autoFocus
          />
        </Field>
        <Field label={t("serviceStorage.add.mountPath")} htmlFor={`${id}-path`} className="min-w-56 flex-1">
          <Input
            id={`${id}-path`}
            className="font-mono"
            value={mountPath}
            onChange={(e) => setMountPath(e.target.value)}
            placeholder="/app/data"
          />
        </Field>
        <span className="flex h-[38px] items-center gap-2 text-[13px] text-ink-strong">
          <Switch id={`${id}-ro`} checked={readOnly} onCheckedChange={setReadOnly} />
          <label htmlFor={`${id}-ro`}>{t("serviceStorage.add.readOnly")}</label>
        </span>
      </div>
      {touched && problem && (
        <p role="alert" className="m-0 text-[13px] text-chip-red-fg">
          {t(`serviceStorage.add.problem.${problem}`)}
        </p>
      )}
      <MutationError error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={pending}>
          {t("serviceStorage.add.submit")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("serviceStorage.add.cancel")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("serviceStorage.add.nextDeploy")}</span>
      </div>
    </form>
  );
}

function VolumeRow({ volume: v, onFiles, onRemove }: { volume: Volume; onFiles: () => void; onRemove?: () => void }) {
  const Icon = v.kind === "file" ? IconFile : IconFolder;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-3">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-control bg-chip-blue-bg text-chip-blue-fg"
      >
        <Icon size={15} stroke={2} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <b className="text-[13.5px] font-semibold">{v.name}</b>
        <span className="font-mono text-xs text-muted-foreground">{v.mountPath}</span>
      </span>
      <Chip tone="gray">{t(`serviceStorage.kind.${v.kind}`)}</Chip>
      {v.readOnly && <Chip tone="amber">{t("serviceStorage.readOnly")}</Chip>}
      {v.sharedWith.length > 0 && (
        <Chip tone="violet">{t("serviceStorage.sharedWith", { names: v.sharedWith.map((s) => s.name).join(", ") })}</Chip>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        <Button size="sm" onClick={onFiles}>
          <IconFolderOpen size={14} />
          {t("serviceStorage.files.button")}
        </Button>
        {onRemove && (
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={t("serviceStorage.remove.button", { name: v.name })}
            onClick={onRemove}
          >
            <IconTrash size={15} />
          </Button>
        )}
      </span>
    </div>
  );
}
