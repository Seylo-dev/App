// Permission actions as the grant and API key screens show them: labels
// from the i18n catalog (settingsActions.<area>.<verb>), grouped by area,
// with a readable fallback for actions added after the catalog was written.
// The list itself always comes from the op contracts (actionCatalog), so it
// never drifts from what the pipeline checks.

import { type ActionInfo, actionCatalog, allOps, grantableActions } from "@seylo/ops";
import { type MessageKey, t } from "../../i18n/t";

export const allActions: readonly ActionInfo[] = actionCatalog(allOps);

const byName = new Map(allActions.map((info) => [info.action, info]));

export function actionInfo(action: string): ActionInfo | undefined {
  return byName.get(action as ActionInfo["action"]);
}

/** "services.deploy" -> "Deploy". Falls back to the verb with spaces when the catalog has no label. */
export function actionLabel(action: string): string {
  if (action === "*") return t("settingsActions.all");
  const key = `settingsActions.${action}` as MessageKey;
  const label = t(key);
  return label === key ? humanize(action.slice(action.indexOf(".") + 1)) : label;
}

/** "services" -> "Services". */
export function areaLabel(area: string): string {
  const key = `settingsActions.areas.${area}` as MessageKey;
  const label = t(key);
  return label === key ? humanize(area) : label;
}

export function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface ActionGroup {
  area: string;
  actions: ActionInfo[];
}

/** Groups actions by the part before the dot, keeping catalog order (sorted by name). */
export function groupActions(actions: readonly ActionInfo[]): ActionGroup[] {
  const groups = new Map<string, ActionInfo[]>();
  for (const info of actions) {
    const area = info.action.slice(0, info.action.indexOf("."));
    const list = groups.get(area) ?? [];
    list.push(info);
    groups.set(area, list);
  }
  return [...groups.entries()].map(([area, list]) => ({ area, actions: list }));
}

export type GrantKind = "project" | "service";

export function grantable(scope: GrantKind): ActionInfo[] {
  const allowed = new Set(grantableActions(allOps, scope));
  return allActions.filter((info) => allowed.has(info.action));
}

/**
 * Actions that only look: every op behind them is a query, or the verb is
 * "view" (projects.view also guards per-person view prefs like collapsing
 * a project, which change nothing anyone else sees).
 */
export function isViewAction(info: ActionInfo): boolean {
  return info.readOnly || info.action.endsWith(".view");
}

/** The "view only" pick for grants and read-only keys. */
export function readOnlyActions(actions: readonly ActionInfo[]): string[] {
  return actions.filter(isViewAction).map((info) => info.action);
}

/**
 * Normalises a picked set for saving: every grantable action picked
 * becomes "*" (so future actions are covered too), otherwise the sorted list.
 */
export function compactActions(picked: ReadonlySet<string>, available: readonly ActionInfo[]): string[] {
  if (picked.has("*")) return ["*"];
  const names = available.map((info) => info.action);
  if (names.length > 0 && names.every((name) => picked.has(name))) return ["*"];
  return names.filter((name) => picked.has(name));
}

/** The opposite of compactActions: "*" expands to every available action. */
export function expandActions(actions: readonly string[], available: readonly ActionInfo[]): Set<string> {
  if (actions.includes("*")) return new Set(available.map((info) => info.action));
  return new Set(actions);
}

/** Short summary for a table cell: "Everything", "3 actions", or the single label. */
export function summarizeActions(actions: readonly string[]): string {
  if (actions.includes("*")) return t("settingsActions.all");
  if (actions.length === 1 && actions[0]) return `${areaLabel(actions[0].slice(0, actions[0].indexOf(".")))}: ${actionLabel(actions[0])}`;
  return t("settingsActions.count", { count: actions.length });
}
