// Reads projects with their counts and the caller's prefs (collapsed in the
// sidebar and on the home page, position), and maps rows to the op shape.

import { slug } from "@seylo/brand";
import { projectImagePath } from "@seylo/ops";
import { and, countDistinct, eq, inArray, or } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { grants, projectImages, projectPrefs, projects, servicePlacements, services } from "../../db/schema";

type ProjectRow = typeof projects.$inferSelect;

export interface ProjectCounts {
  serviceCount: number;
  nodeCount: number;
  guestCount: number;
}

export interface ProjectPrefs {
  /** In the sidebar. */
  collapsed: boolean;
  /** On the home page. */
  dashboardCollapsed: boolean;
  position: number | null;
}

export interface ProjectView {
  project: ProjectRow;
  counts: ProjectCounts;
  prefs: ProjectPrefs;
  /** The uploaded image's hash; null when the project shows its initial. */
  imageHash: string | null;
}

export const noPrefs: ProjectPrefs = { collapsed: false, dashboardCollapsed: false, position: null };

/** Docker network of a project on every node; matches docker.ProjectNetwork in Go. */
export function projectNetwork(projectId: string): string {
  return `${slug}-p-${projectId}`;
}

export function toProject({ project, counts, prefs, imageHash }: ProjectView) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    protected: project.protected,
    ...counts,
    networkName: projectNetwork(project.id),
    collapsed: prefs.collapsed,
    dashboardCollapsed: prefs.dashboardCollapsed,
    position: prefs.position,
    imageUrl: imageHash === null ? null : projectImagePath(project.id, imageHash),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/**
 * Projects (all, or one) with counts and `userId`'s prefs, in that
 * person's sidebar order: positioned ones first, then by name.
 */
export function selectProjects(db: PanelDb, userId: string | null, projectId?: string): ProjectView[] {
  const rows = (projectId ? db.select().from(projects).where(eq(projects.id, projectId)) : db.select().from(projects)).all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const serviceCounts = new Map(
    db
      .select({ projectId: services.projectId, n: countDistinct(services.id) })
      .from(services)
      .where(inArray(services.projectId, ids))
      .groupBy(services.projectId)
      .all()
      .map((r) => [r.projectId, r.n]),
  );
  const nodeCounts = new Map(
    db
      .select({ projectId: services.projectId, n: countDistinct(servicePlacements.nodeId) })
      .from(servicePlacements)
      .innerJoin(services, eq(services.id, servicePlacements.serviceId))
      .where(inArray(services.projectId, ids))
      .groupBy(services.projectId)
      .all()
      .map((r) => [r.projectId, r.n]),
  );
  const guestCounts = guestCountsOf(db, ids);
  const imageHashes = new Map(
    db
      .select({ projectId: projectImages.projectId, hash: projectImages.hash })
      .from(projectImages)
      .where(inArray(projectImages.projectId, ids))
      .all()
      .map((r) => [r.projectId, r.hash]),
  );
  const prefs = new Map<string, ProjectPrefs>();
  if (userId) {
    const rowsForUser = db
      .select()
      .from(projectPrefs)
      .where(and(eq(projectPrefs.userId, userId), inArray(projectPrefs.projectId, ids)))
      .all();
    for (const p of rowsForUser)
      prefs.set(p.projectId, { collapsed: p.collapsed, dashboardCollapsed: p.dashboardCollapsed, position: p.position });
  }

  const views = rows.map((project) => ({
    project,
    counts: {
      serviceCount: serviceCounts.get(project.id) ?? 0,
      nodeCount: nodeCounts.get(project.id) ?? 0,
      guestCount: guestCounts.get(project.id) ?? 0,
    },
    prefs: prefs.get(project.id) ?? noPrefs,
    imageHash: imageHashes.get(project.id) ?? null,
  }));
  return views.sort(sidebarOrder);
}

function sidebarOrder(a: ProjectView, b: ProjectView): number {
  const pa = a.prefs.position;
  const pb = b.prefs.position;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  return a.project.nameKey.localeCompare(b.project.nameKey);
}

/** Distinct people with a grant on each project or on one of its services. */
function guestCountsOf(db: PanelDb, projectIds: string[]): Map<string, number> {
  const serviceProject = new Map(
    db
      .select({ id: services.id, projectId: services.projectId })
      .from(services)
      .where(inArray(services.projectId, projectIds))
      .all()
      .map((r) => [r.id, r.projectId]),
  );
  const projectScope = and(eq(grants.scopeType, "project"), inArray(grants.scopeId, projectIds));
  const scope =
    serviceProject.size > 0
      ? or(projectScope, and(eq(grants.scopeType, "service"), inArray(grants.scopeId, [...serviceProject.keys()])))
      : projectScope;
  const rows = db.select({ userId: grants.userId, scopeType: grants.scopeType, scopeId: grants.scopeId }).from(grants).where(scope).all();

  const people = new Map<string, Set<string>>();
  for (const r of rows) {
    const projectId = r.scopeType === "project" ? r.scopeId : serviceProject.get(r.scopeId);
    if (!projectId) continue;
    const set = people.get(projectId) ?? new Set<string>();
    set.add(r.userId);
    people.set(projectId, set);
  }
  return new Map([...people].map(([id, set]) => [id, set.size]));
}

/** Names compare without case, so "Shop" and "shop" cannot both exist. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}
