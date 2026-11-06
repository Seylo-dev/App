// The permission action catalog, derived from the op contracts so it can
// never drift from what the pipeline checks. Screens use it for the grant
// and API key checkboxes (labels come from i18n, keyed by action).

import type { AnyOpContract } from "./define";
import type { Action, ScopeKind } from "./permission";

export interface ActionInfo {
  action: Action;
  /** "global": only owners and admins hold it (and keys narrowed from them). */
  scope: ScopeKind | "global";
  /** Ops that check this action, sorted. */
  ops: string[];
  /** True when every op behind it is a query; a read-only key can still use it. */
  readOnly: boolean;
}

/** Every action named by an op permission, sorted. */
export function actionCatalog(ops: readonly AnyOpContract[]): ActionInfo[] {
  const byAction = new Map<string, ActionInfo>();
  for (const op of ops) {
    const p = op.permission;
    if (p.kind === "public" || p.kind === "signedIn") continue;
    const scope = p.kind === "global" ? "global" : p.kind;
    const info = byAction.get(p.action) ?? { action: p.action, scope, ops: [], readOnly: true };
    // An action checked on both kinds of resource is a service action:
    // project grants cover services, so it is grantable on either.
    if (info.scope !== scope) info.scope = info.scope === "global" || scope === "global" ? "global" : "service";
    info.ops.push(op.id);
    if (op.kind !== "query") info.readOnly = false;
    byAction.set(p.action, info);
  }
  return [...byAction.values()].map((info) => ({ ...info, ops: info.ops.sort() })).sort((a, b) => a.action.localeCompare(b.action));
}

/**
 * Actions a grant on this kind of resource may hold. A project grant also
 * covers the project's services, so it takes project and service actions;
 * a service grant takes service actions only. Global actions are never
 * granted: they come with the owner and admin roles.
 */
export function grantableActions(ops: readonly AnyOpContract[], scope: ScopeKind): Action[] {
  return actionCatalog(ops)
    .filter((info) => (scope === "project" ? info.scope !== "global" : info.scope === "service"))
    .map((info) => info.action);
}

/**
 * True when an action list (a grant's or an API key's) allows `action`.
 * Entries are "*" (everything), "<area>.*" (every action of one area, for
 * example "services.*") or an exact action.
 */
export function actionAllowed(list: readonly string[], action: string): boolean {
  if (list.includes("*") || list.includes(action)) return true;
  const area = action.slice(0, action.indexOf("."));
  return area !== "" && list.includes(`${area}.*`);
}

/** The concrete actions an entry of an action list stands for, among `known`. */
export function expandActionEntry(entry: string, known: readonly string[]): string[] {
  if (entry === "*") return [...known];
  if (entry.endsWith(".*")) {
    const prefix = entry.slice(0, -1);
    return known.filter((action) => action.startsWith(prefix));
  }
  return known.includes(entry) ? [entry] : [];
}
