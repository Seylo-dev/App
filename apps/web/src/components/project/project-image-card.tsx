// A project's image in its Settings (0.2.6): upload one to show instead of
// the initial in the sidebar, on the dashboard and on the project's page,
// for everyone who sees the project; remove it to bring the initial back.
// The browser crops it to the middle square and scales it like an avatar
// (lib/avatar-image.ts) before projects.setImage.

import { projects } from "@seylo/ops";
import { opQueryKey, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { SectionCard } from "@seylo/ui/components/section-card";
import { toast } from "@seylo/ui/components/toast";
import { IconLoader2, IconUpload } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { AvatarImageError, avatarAccept, squareAvatar } from "../../lib/avatar-image";
import type { Project } from "../../lib/types";
import { ProjectTile } from "../project-tile";

export function ProjectImageCard({ project }: { project: Project }) {
  const cache = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  // The live socket refreshes other tabs; this one refreshes now, so it works without it too.
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: opQueryKey(projects.list) });
    void cache.invalidateQueries({ queryKey: opQueryKey(projects.get) });
  };
  const failed = (error: unknown) => toast.error(errorMessage(error, t("common.unknownError")));
  const upload = useOpMutation(projects.setImage, {
    onSuccess: () => {
      refresh();
      toast.success(t("project.settings.image.uploaded"));
    },
    onError: failed,
  });
  const remove = useOpMutation(projects.removeImage, {
    onSuccess: () => {
      refresh();
      toast.success(t("project.settings.image.removed"));
    },
    onError: failed,
  });
  const busy = preparing || upload.isPending || remove.isPending;
  const hasImage = project.imageUrl !== null;

  async function choose(file: File | undefined) {
    if (!file) return;
    setPreparing(true);
    try {
      upload.mutate({ projectId: project.id, dataUrl: await squareAvatar(file) });
    } catch (error) {
      const problem = error instanceof AvatarImageError ? error.problem : "unreadable";
      toast.error(t(`settingsProfile.avatar.problems.${problem}`));
    } finally {
      setPreparing(false);
    }
  }

  return (
    <SectionCard title={t("project.settings.image.title")} description={t("project.settings.image.description")}>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <ProjectTile id={project.id} name={project.name} imageUrl={project.imageUrl} isProtected={project.protected} size="lg" />
          {busy && (
            <span className="absolute inset-0 flex items-center justify-center rounded-card bg-card/70 text-foreground">
              <IconLoader2 size={20} className="animate-spin" aria-hidden="true" />
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
              <IconUpload size={15} stroke={1.8} aria-hidden="true" />
              {hasImage ? t("project.settings.image.uploadAnother") : t("project.settings.image.upload")}
            </Button>
            {hasImage && (
              <Button variant="ghost" disabled={busy} onClick={() => remove.mutate({ projectId: project.id })}>
                {t("project.settings.image.remove")}
              </Button>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{t("project.settings.image.hint")}</span>
        </div>
        <input
          ref={input}
          type="file"
          accept={avatarAccept}
          aria-label={t("project.settings.image.upload")}
          className="hidden"
          onChange={(e) => {
            void choose(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
    </SectionCard>
  );
}
