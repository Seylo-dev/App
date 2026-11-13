// Renaming and deleting a project from its menus. Delete is the same
// type-to-confirm the project's Settings tab uses (it opens this dialog
// too); Rename saves only the name, with the same rules as the Settings
// form (projects.update, at most 40 characters).

import { projects } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { toast } from "@seylo/ui/components/toast";
import { type FormEvent, useId, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { useInvalidate } from "../service/invalidate";

type ProjectRef = { id: string; name: string };

export function RenameProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inputId = useId();
  const invalidate = useInvalidate();
  const [name, setName] = useState(project.name);
  const update = useOpMutation(projects.update, {
    onSuccess: () => {
      invalidate(projects.list, projects.get);
      toast.success(t("menus.renameProject.done"));
      onOpenChange(false);
    },
  });
  const trimmed = name.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || trimmed === project.name) return onOpenChange(false);
    update.mutate({ projectId: project.id, name: trimmed });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <DialogTitle>{t("menus.renameProject.title", { name: project.name })}</DialogTitle>
            <DialogDescription>{t("menus.renameProject.description")}</DialogDescription>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>{t("menus.renameProject.name")}</Label>
            <Input id={inputId} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
            {update.error && <span className="text-[13px] text-destructive">{errorMessage(update.error, t("common.unknownError"))}</span>}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!trimmed || update.isPending}>
              {t("menus.renameProject.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
  onDeleted,
}: {
  project: ProjectRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const invalidate = useInvalidate();
  const remove = useOpMutation(projects.remove);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      title={t("project.deleteTitle", { name: project.name })}
      description={t("project.deleteHint")}
      confirmText={project.name}
      confirmLabel={t("project.deleteProject")}
      onConfirm={async () => {
        await remove.mutateAsync({ projectId: project.id, confirmName: project.name });
        invalidate(projects.list);
        toast.success(t("project.deleted", { name: project.name }));
        onDeleted?.();
      }}
    />
  );
}
