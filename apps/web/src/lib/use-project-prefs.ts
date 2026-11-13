// The signed-in person's project preferences (collapsed in the sidebar and
// on the home page, each on its own, the order of their projects, one for
// both, and of each project's services), shared by the sidebar, the
// dashboard and the project page. Changes show at once (the cached
// projects.list and services.list are patched) and are saved through
// projects.setCollapsed, projects.reorder and services.reorder. A read of the
// list still on its way when a change is patched in is stopped (its answer is
// from before the save), and the list is read again once the save answered,
// so the screen matches the panel again (after a failure too).

import { projects, services } from "@seylo/ops";
import { opQueryKey, useOpMutation } from "@seylo/ops/react";
import { toast } from "@seylo/ui/components/toast";
import type { Mutation, QueryKey } from "@tanstack/react-query";
import { t } from "../i18n/t";
import { errorMessage, queryClient } from "./api";
import type { CollapseWhere, Project, ServiceSummary } from "./types";

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

const servicesKey = (projectId: string) => opQueryKey(services.list, { projectId });

/** Whether `project` is collapsed in the sidebar or on the home page: two flags, set on their own. */
export function isCollapsedIn(project: Pick<Project, "collapsed" | "dashboardCollapsed">, where: CollapseWhere): boolean {
  return where === "dashboard" ? project.dashboardCollapsed : project.collapsed;
}

/** `project` with the flag of `where` set, the other left as it was. */
function withCollapsed(project: Project, where: CollapseWhere, collapsed: boolean): Project {
  return where === "dashboard" ? { ...project, dashboardCollapsed: collapsed } : { ...project, collapsed };
}

/**
 * Writes a change into a cached list. A read of the list still on its way
 * (a live event refetches it while a service deploys) is stopped first: it
 * was asked before the save, so its answer would put the old order back.
 */
function patchList<T>(key: QueryKey, update: (old: T) => T): void {
  if (queryClient.getQueryData<T>(key) === undefined) return;
  void queryClient.cancelQueries({ queryKey: key, exact: true });
  queryClient.setQueryData<T>(key, (old) => (old === undefined ? old : update(old)));
}

function patch(update: (list: Project[]) => Project[]): void {
  patchList<ProjectList>(listKey, (old) => ({ projects: update(old.projects) }));
}

/** The op a save runs (useOpMutation keys them ["op", <op id>]). */
const opOf = (mutation: Mutation<unknown, unknown, unknown>) => mutation.options.mutationKey?.[1];
const projectSaves = new Set<unknown>([projects.setCollapsed.id, projects.reorder.id]);

/**
 * Reads the list again once a save of it answered, for what a stopped read
 * would have brought. Not while another save of the same list is still on
 * its way: a read now could miss that one's change and show the order from
 * before it for a moment. After a failure at once, which puts the panel's
 * order back.
 */
function resync(key: QueryKey, error: unknown, sameList: (mutation: Mutation<unknown, unknown, unknown>) => boolean): void {
  // The save that just answered still counts: its onSettled runs before it leaves "pending".
  if (error || queryClient.isMutating({ predicate: sameList }) <= 1) void queryClient.invalidateQueries({ queryKey: key });
}

function failed(error: unknown): void {
  toast.error(t("sidebar.saveFailed"), { description: errorMessage(error, t("common.unknownError")) });
}

function projectsSaved(_data: unknown, error: unknown): void {
  resync(listKey, error, (mutation) => projectSaves.has(opOf(mutation)));
}

function servicesSaved(_data: unknown, error: unknown, input: { projectId: string }): void {
  resync(servicesKey(input.projectId), error, (mutation) => {
    const variables = mutation.state.variables as { projectId?: string } | undefined;
    return opOf(mutation) === services.reorder.id && variables?.projectId === input.projectId;
  });
}

export function useProjectPrefs() {
  const collapse = useOpMutation(projects.setCollapsed, { onError: failed, onSettled: projectsSaved });
  const reorder = useOpMutation(projects.reorder, { onError: failed, onSettled: projectsSaved });
  const reorderServices = useOpMutation(services.reorder, { onError: failed, onSettled: servicesSaved });

  return {
    /** Collapses or expands a project in the sidebar or on the home page; the other view keeps its own. */
    setCollapsed(projectId: string, collapsed: boolean, where: CollapseWhere) {
      patch((list) => list.map((p) => (p.id === projectId ? withCollapsed(p, where, collapsed) : p)));
      collapse.mutate({ projectId, collapsed, where });
    },
    /** Collapses or expands every project in one view, or only `only` (the cards on screen, without the hidden ones). */
    setAllCollapsed(collapsed: boolean, where: CollapseWhere, only?: readonly { id: string }[]) {
      const list = queryClient.getQueryData<ProjectList>(listKey)?.projects ?? [];
      const ids = only && new Set(only.map((project) => project.id));
      for (const project of list) {
        if (ids && !ids.has(project.id)) continue;
        if (isCollapsedIn(project, where) === collapsed) continue;
        patch((current) => current.map((p) => (p.id === project.id ? withCollapsed(p, where, collapsed) : p)));
        collapse.mutate({ projectId: project.id, collapsed, where });
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
      patchList<ServiceList>(servicesKey(projectId), (old) => ({ services: orderServices(old.services, ids) }));
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
