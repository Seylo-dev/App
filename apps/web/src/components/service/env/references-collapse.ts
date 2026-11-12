// Which groups of the References panel are collapsed. A group (the service
// being edited, each other service, the shared variables) collapses and
// expands on its header row. The service itself and groups with up to
// `collapseAbove` chips start expanded; a longer one (an app's built-ins and
// its own 30 variables) starts collapsed and shows only its count. What
// someone expands or collapses is remembered in this browser for the
// project (localStorage, one JSON object per project, every access in
// try/catch: blocked storage keeps the choices until the page is left and
// starts from the defaults next time).

import { slug } from "@seylo/brand";
import type { ReferenceTarget } from "@seylo/env-analyzer";
import { useState } from "react";

/** A group with more chips than this starts collapsed: more than a database's whole set (9), so a database starts expanded. */
export const collapseAbove = 12;

/**
 * The group of the service being edited, whichever service that is. It
 * lists its built-ins only, so it is not the same group as that service on
 * another service's tab, and it always starts expanded.
 */
export const selfGroupKey = "self";

/** A group's key in the remembered choices: a service by its id (it survives a rename), the shared variables by their kind. */
export function groupKey(target: Pick<ReferenceTarget, "kind" | "name" | "serviceId">): string {
  if (target.kind === "shared") return "shared";
  return `service:${target.serviceId ?? target.name}`;
}

export interface RefGroup {
  key: string;
  /** How many chips it shows. */
  chips: number;
}

/** Collapsed (true) or expanded (false) by group key, for the groups someone expanded or collapsed. */
export type CollapseChoices = Record<string, boolean>;

/** How a group starts when nobody chose: the service itself expanded, a long group collapsed. */
export function collapsedByDefault(group: RefGroup): boolean {
  return group.key !== selfGroupKey && group.chips > collapseAbove;
}

export function isCollapsed(choices: CollapseChoices, group: RefGroup): boolean {
  return choices[group.key] ?? collapsedByDefault(group);
}

/** The choices after a click (or Enter, or Space) on the group's header. */
export function toggleCollapsed(choices: CollapseChoices, group: RefGroup): CollapseChoices {
  return { ...choices, [group.key]: !isCollapsed(choices, group) };
}

/** The choices after Expand all (false) or Collapse all (true) over these groups. */
export function setAllCollapsed(choices: CollapseChoices, groups: RefGroup[], collapsed: boolean): CollapseChoices {
  const next = { ...choices };
  for (const group of groups) next[group.key] = collapsed;
  return next;
}

/** localStorage is per scheme, host and port: each panel address remembers its own. */
export const collapseStorageKey = (projectId: string) => `${slug}.envReferences.collapsed.${projectId}`;

type CollapseStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): CollapseStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The project's remembered choices: none when nothing (or something unreadable) is saved or storage is blocked. */
export function readCollapseChoices(projectId: string, storage: CollapseStorage | null = browserStorage()): CollapseChoices {
  try {
    const saved = storage?.getItem(collapseStorageKey(projectId));
    if (!saved) return {};
    const parsed: unknown = JSON.parse(saved);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return {};
  }
}

export function saveCollapseChoices(projectId: string, choices: CollapseChoices, storage: CollapseStorage | null = browserStorage()): void {
  try {
    storage?.setItem(collapseStorageKey(projectId), JSON.stringify(choices));
  } catch {
    // Storage blocked or full: the choices hold until the page is left.
  }
}

/**
 * The project's choices, read once before the first render (so a collapsed
 * group never flashes open) and saved on every change.
 */
export function useCollapseChoices(projectId: string): [CollapseChoices, (next: CollapseChoices) => void] {
  const [state, setState] = useState(() => ({ projectId, choices: readCollapseChoices(projectId) }));
  let current = state;
  // Another project's panel in the same component: that project's choices.
  if (state.projectId !== projectId) {
    current = { projectId, choices: readCollapseChoices(projectId) };
    setState(current);
  }
  return [
    current.choices,
    (next) => {
      setState({ projectId, choices: next });
      saveCollapseChoices(projectId, next);
    },
  ];
}
