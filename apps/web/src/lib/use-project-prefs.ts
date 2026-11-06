// The signed-in person's project preferences (collapsed and order), shared
// by the sidebar and the dashboard. Changes show at once (the cached
// projects.list is patched) and are saved through projects.setCollapsed and
// projects.reorder; a failed save refetches the list so the screen matches
// the panel again.

import { projects } from "@seylo/ops";
import { opQueryKey, useOpMutation } from "@seylo/ops/react";
import { toast } from "@seylo/ui/components/toast";
import { t } from "../i18n/t";
import { errorMessage, queryClient } from "./api";
import type { Project } from "./types";

type ProjectList = { projects: Project[] };
const listKey = opQueryKey(projects.list, {});

function patch(update: (list: Project[]) => Project[]): void {
  queryClient.setQueryData<ProjectList>(listKey, (old) => (old ? { projects: update(old.projects) } : old));
}

function failed(error: unknown): void {
  toast.error(t("sidebar.saveFailed"), { description: errorMessage(error, t("common.unknownError")) });
  void queryClient.invalidateQueries({ queryKey: listKey });
}

export function useProjectPrefs() {
  const collapse = useOpMutation(projects.setCollapsed, { onError: failed });
  const reorder = useOpMutation(projects.reorder, { onError: failed });

  return {
    setCollapsed(projectId: string, collapsed: boolean) {
      patch((list) => list.map((p) => (p.id === projectId ? { ...p, collapsed } : p)));
      collapse.mutate({ projectId, collapsed });
    },
    setAllCollapsed(collapsed: boolean) {
      const list = queryClient.getQueryData<ProjectList>(listKey)?.projects ?? [];
      for (const project of list) {
        if (project.collapsed === collapsed) continue;
        patch((current) => current.map((p) => (p.id === project.id ? { ...p, collapsed } : p)));
        collapse.mutate({ projectId: project.id, collapsed });
      }
    },
    /** Moves `projectId` to just before `beforeId` and saves the whole order. */
    moveBefore(projectId: string, beforeId: string) {
      const list = queryClient.getQueryData<ProjectList>(listKey)?.projects;
      if (!list || projectId === beforeId) return;
      const ids = list.map((p) => p.id).filter((id) => id !== projectId);
      ids.splice(Math.max(0, ids.indexOf(beforeId)), 0, projectId);
      const byId = new Map(list.map((p) => [p.id, p]));
      patch(() => ids.map((id) => byId.get(id)).filter((p): p is Project => p !== undefined));
      reorder.mutate({ projectIds: ids });
    },
  };
}
