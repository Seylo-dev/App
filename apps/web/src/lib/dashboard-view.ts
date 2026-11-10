// How the dashboard shows its projects: cards (a grid of service cards
// under each project), list (one card per project with its services as
// rows) or table (every service in one sortable table). A per-viewer
// convenience, so it lives in this browser's localStorage, not in the
// panel's preferences; blocked storage falls back to cards.

import { slug } from "@seylo/brand";
import { useState } from "react";

export const dashboardViews = ["cards", "list", "table"] as const;
export type DashboardView = (typeof dashboardViews)[number];

export const defaultDashboardView: DashboardView = "cards";

/** localStorage is per scheme, host and port, so each panel address remembers its own choice. */
export const dashboardViewStorage = `${slug}.dashboardView`;

type ViewStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): ViewStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isDashboardView(value: unknown): value is DashboardView {
  return dashboardViews.includes(value as DashboardView);
}

/** The saved view, or cards when nothing (or something unknown) is saved or storage is blocked. */
export function readDashboardView(storage: ViewStorage | null = browserStorage()): DashboardView {
  try {
    const saved = storage?.getItem(dashboardViewStorage);
    return isDashboardView(saved) ? saved : defaultDashboardView;
  } catch {
    return defaultDashboardView;
  }
}

export function saveDashboardView(view: DashboardView, storage: ViewStorage | null = browserStorage()): void {
  try {
    storage?.setItem(dashboardViewStorage, view);
  } catch {
    // Storage blocked (a private window with storage off): the choice lasts until the page is left.
  }
}

/** The view on screen and a setter that also remembers it. Read once, before the first render, so the page never flashes the default. */
export function useDashboardView(): [DashboardView, (view: DashboardView) => void] {
  const [view, setView] = useState<DashboardView>(() => readDashboardView());
  return [
    view,
    (next) => {
      setView(next);
      saveDashboardView(next);
    },
  ];
}
