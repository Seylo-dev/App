// The last drawn shape of the sidebar's projects and of the home page's
// (Cards and List), per person, in this browser: whether each project was
// open in that view and how many services it had. While projects.list (it
// carries the collapsed flags the panel keeps) is on its way, that view's
// placeholders take this shape, so a reload does not draw every project
// open and then fold some, or the other way round. The panel's answer
// replaces it as soon as it arrives and is saved again: the panel wins.
// localStorage is per scheme, host and port; every access is in try/catch,
// and blocked storage draws the usual placeholders.

import { slug } from "@seylo/brand";
import { auth } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { useEffect, useMemo } from "react";
import type { CollapseWhere, Project } from "./types";
import { isCollapsedIn } from "./use-project-prefs";

/** One project as a view last drew it. */
export interface ShapeRow {
  open: boolean;
  /** Its services, for the placeholder rows or cards under an open project. */
  services: number;
}

/** A placeholder, not the whole list: at most this many projects, and services under each. */
export const maxShapeRows = 50;
export const maxShapeServices = 24;

/** Per view and per person, so two people sharing a browser each get their own. */
export const projectsShapeStorage = (where: CollapseWhere, userId: string) => `${slug}.projectsShape.${where}.${userId}`;

type ShapeStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): ShapeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The shape of `projects` (the ones on screen, in order) in one view: each by its own flag. */
export function shapeOf(projects: readonly Project[], where: CollapseWhere): ShapeRow[] {
  return projects
    .slice(0, maxShapeRows)
    .map((project) => ({ open: !isCollapsedIn(project, where), services: Math.min(project.serviceCount, maxShapeServices) }));
}

function isRow(value: unknown): value is ShapeRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.open === "boolean" && Number.isInteger(row.services) && (row.services as number) >= 0;
}

/** The saved shape, or null when nothing (or something unreadable) is saved or storage is blocked. */
export function readProjectsShape(
  where: CollapseWhere,
  userId: string,
  storage: ShapeStorage | null = browserStorage(),
): ShapeRow[] | null {
  try {
    const saved = storage?.getItem(projectsShapeStorage(where, userId));
    if (!saved) return null;
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed) || !parsed.every(isRow)) return null;
    return parsed.slice(0, maxShapeRows).map((row) => ({ open: row.open, services: Math.min(row.services, maxShapeServices) }));
  } catch {
    return null;
  }
}

function writeShape(where: CollapseWhere, userId: string, text: string, storage: ShapeStorage | null): void {
  try {
    storage?.setItem(projectsShapeStorage(where, userId), text);
  } catch {
    // Storage blocked or full: the next reload draws the usual placeholders.
  }
}

export function saveProjectsShape(
  where: CollapseWhere,
  userId: string,
  rows: readonly ShapeRow[],
  storage: ShapeStorage | null = browserStorage(),
): void {
  writeShape(where, userId, JSON.stringify(rows), storage);
}

/** The signed-in person's id (auth.whoami answers before the shell draws). */
function useViewerId(): string | undefined {
  return useOp(auth.whoami, {}).data?.viewer.id;
}

/** The shape this view's placeholders take: read before the first render, so they never draw the default first. */
export function useProjectsShape(where: CollapseWhere): ShapeRow[] | null {
  const userId = useViewerId();
  return useMemo(() => (userId ? readProjectsShape(where, userId) : null), [where, userId]);
}

/** Saves the view's shape whenever its projects on screen change; undefined while they load. */
export function useRememberProjectsShape(where: CollapseWhere, projects: readonly Project[] | undefined): void {
  const userId = useViewerId();
  const text = projects ? JSON.stringify(shapeOf(projects, where)) : null;
  useEffect(() => {
    if (userId && text !== null) writeShape(where, userId, text, browserStorage());
  }, [where, userId, text]);
}
