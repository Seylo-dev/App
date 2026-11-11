// Project settings: name and description, its image (0.2.6), the internal git hosts its nodes
// may clone from (admins only), and deleting an empty project. The
// protected Panel project can be described but not renamed or deleted.

import { projects } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Input, Label } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import type { Project } from "../../lib/types";
import { InternalGitHosts } from "../git/internal-hosts";
import { ProjectImageCard } from "./project-image-card";

export function ProjectSettings({ project }: { project: Project }) {
  const navigate = useNavigate();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const update = useOpMutation(projects.update, { onSuccess: () => toast.success(t("project.settings.saved")) });
  const remove = useOpMutation(projects.remove);
  const dirty = name.trim() !== project.name || description.trim() !== project.description;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({
      projectId: project.id,
      name: project.protected || name.trim() === project.name ? undefined : name.trim(),
      description: description.trim(),
    });
  };

  return (
    // Two columns on wide screens (the details left, git hosts and the danger zone right); one column in
    // the same order below that, so Delete stays last.
    <div className="grid max-w-[1360px] items-start gap-4 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        {/* Save sits on the card's footer strip, on the right, like the shared environment's. */}
        <form onSubmit={submit}>
          <SectionCard
            title={t("project.settings.general")}
            footer={
              <>
                {update.error && (
                  <span className="text-[13px] text-destructive">{errorMessage(update.error, t("common.unknownError"))}</span>
                )}
                <Button type="submit" variant="primary" className="ml-auto" disabled={!dirty || update.isPending}>
                  {t("common.save")}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="project-name">{t("project.name")}</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={40}
                  disabled={project.protected}
                  required
                />
                {project.protected && <span className="text-xs text-muted-foreground">{t("project.settings.protectedName")}</span>}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="project-description">{t("project.description")}</Label>
                <Input id="project-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
              </div>
            </div>
          </SectionCard>
        </form>

        <ProjectImageCard project={project} />
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <InternalGitHosts projectId={project.id} projectName={project.name} />

        {!project.protected && (
          <SectionCard danger title={t("project.dangerZone")} description={t("project.deleteHint")}>
            <div>
              <Button variant="destructive" onClick={() => setConfirmOpen(true)} disabled={project.serviceCount > 0}>
                {t("project.deleteProject")}
              </Button>
              {project.serviceCount > 0 && <p className="m-0 mt-2 text-xs text-muted-foreground">{t("project.deleteHasServices")}</p>}
            </div>
          </SectionCard>
        )}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        destructive
        title={t("project.deleteTitle", { name: project.name })}
        description={t("project.deleteHint")}
        confirmText={project.name}
        confirmLabel={t("project.deleteProject")}
        onConfirm={async () => {
          await remove.mutateAsync({ projectId: project.id, confirmName: project.name });
          toast.success(t("project.deleted", { name: project.name }));
          void navigate({ to: "/" });
        }}
      />
    </div>
  );
}
