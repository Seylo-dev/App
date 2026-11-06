import { projects } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/api";

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // The list refreshes through the live socket's invalidation.
  const create = useOpMutation(projects.create, {
    onSuccess: (project) => {
      onOpenChange(false);
      setName("");
      setDescription("");
      void navigate({ to: "/p/$projectId", params: { projectId: project.id } });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ name: name.trim(), description: description.trim() || undefined });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <DialogTitle>{t("project.newProject")}</DialogTitle>
            <DialogDescription className="sr-only">{t("project.newProject")}</DialogDescription>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">{t("project.name")}</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-description">{t("project.description")}</Label>
            <Input id="project-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
          {create.error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {errorMessage(create.error, t("common.unknownError"))}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={create.isPending || name.trim() === ""}>
              {t("common.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
