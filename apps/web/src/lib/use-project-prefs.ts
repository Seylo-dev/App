// The signed-in person's project preferences (collapsed, the order of their
// projects and of each project's services), shared by the sidebar, the
// dashboard and the project page. Changes show at once (the cached
// projects.list and services.list are patched) and are saved through
// projects.setCollapsed, projects.reorder and services.reorder; a failed save
// refetches the list so the screen matches the panel again.

import { projects, services } from "@seylo/ops";
import { opQueryKey, useOpMutation } from "@seylo/ops/react";
import { toast } from "@seylo/ui/components/toast";
import { t } from "../i18n/t";
import { errorMessage, queryClient } from "./api";
import type { Project, ServiceSummary } from "./types";

type ProjectList = { projects: Project[] };
type ServiceList = { services: ServiceSummary[] };
const listKey = opQueryKey(projects.list, {});

/** Top-level services in `ids` order (the rest after, as they were), each followed by its compose members. */
export function orderServices(list: readonly ServiceSummary[], ids: readonly string[]): ServiceSummary[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const top = list.filter((s) => s.parentId === null);
  const sorted = top
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (rank.get(a.s.id) ?? ids.length + a.i) - (rank.get(b.s.id) ?? ids.length + b.i))
    .map((x) => x.s);
  return sorted.flatMap((s) => [s, ...list.filter((m) => m.parentId === s.id)]);
}

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
  const reorderServices = useOpMutation(services.reorder, {
    onError: (error, input) => {
      toast.error(t("sidebar.saveFailed"), { description: errorMessage(error, t("common.unknownError")) });
      void queryClient.invalidateQueries({ queryKey: opQueryKey(services.list, { projectId: input.projectId }) });
    },
  });

  return {
    setCollapsed(projectId: string, collapsed: boolean) {
      patch((list) => list.map((p) => (p.id === projectId ? { ...p, collapsed } : p)));
      collapse.mutate({ projectId, collapsed });
    },
    /** Collapses or expands every project, or only `only` (the cards on screen, without the hidden ones). */
    setAllCollapsed(collapsed: boolean, only?: readonly { id: string }[]) {
      const list = queryClient.getQueryData<ProjectList>(listKey)?.projects ?? [];
      const ids = only && new Set(only.map((project) => project.id));
      for (const project of list) {
        if (ids && !ids.has(project.id)) continue;
        if (project.collapsed === collapsed) continue;
        patch((current) => current.map((p) => (p.id === project.id ? { ...p, collapsed } : p)));
        collapse.mutate({ projectId: project.id, collapsed });
      }
    },
    /**
     * Saves a new order of the projects on screen (a drag in the sidebar or
     * on the dashboard); projects not in `ids` (hidden ones) keep their places after them.
     */
    setProjectOrder(ids: readonly string[]) {
      const list = queryClient.getQueryData<ProjectList>(listKey)?.projects;
      if (!list) return;
      const shown = new Set(ids);
      const all = [...ids, ...list.map((p) => p.id).filter((id) => !shown.has(id))];
      const byId = new Map(list.map((p) => [p.id, p]));
      patch(() => all.map((id) => byId.get(id)).filter((p): p is Project => p !== undefined));
      reorder.mutate({ projectIds: all });
    },
    /** Saves a new order of a project's services (top-level ids, top to bottom). */
    setServiceOrder(projectId: string, ids: readonly string[]) {
      const key = opQueryKey(services.list, { projectId });
      queryClient.setQueryData<ServiceList>(key, (old) => (old ? { services: orderServices(old.services, ids) } : old));
      reorderServices.mutate({ projectId, serviceIds: [...ids] });
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
