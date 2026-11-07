// Decides whether a principal may perform an action. Owners and admins may
// do everything; members only what a grant on the project or service
// allows. API keys are additionally narrowed to their own action list, and
// read-only keys to queries; keys limited to projects only reach those
// projects and their services. Action lists match with actionAllowed
// ("*", "<area>.*" or the exact action).

import { type Action, type AnyPermission, actionAllowed, OpError, type OpKind } from "@seylo/ops";
import { and, eq, or } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { grants, services } from "../db/schema";
import { type Principal, userOf } from "./principal";

export interface Target {
  type: "project" | "service";
  id: string;
}

export interface Access {
  readonly principal: Principal;
  /**
   * Throws UNAUTHENTICATED or FORBIDDEN unless the op may run with this
   * input. Returns the resource the permission named, for the audit log.
   */
  require(permission: AnyPermission, kind: OpKind, input: unknown): Target | undefined;
  /** Whether the principal holds `action`, panel-wide or on `target`. */
  can(action: Action, target?: Target): boolean;
  /**
   * Whether the principal holds any of `actions` on at least one project or
   * service (admins: anywhere their key reaches). For the shared pickers
   * (registries, git credentials, channels ...): an account with no grants
   * gets empty lists instead of the panel's catalogue.
   */
  canSomewhere(actions: readonly Action[]): boolean;
}

/** Who may pick a stored git credential, provider connection or registry login for a source. */
export const sourcePickerActions: readonly Action[] = ["services.create", "services.update"];

export function createAccess(db: PanelDb, principal: Principal): Access {
  const user = userOf(principal);
  const isAdmin = user?.role === "owner" || user?.role === "admin";

  const projectOf = (target: Target): string | undefined =>
    target.type === "project"
      ? target.id
      : db.select({ projectId: services.projectId }).from(services).where(eq(services.id, target.id)).get()?.projectId;

  const keyAllows = (action: Action, target?: Target): boolean => {
    if (principal.type !== "apiKey") return true;
    if (!actionAllowed(principal.actions, action)) return false;
    if (principal.projectIds === null) return true;
    // A key limited to some projects never holds panel-wide actions.
    if (!target) return false;
    const projectId = projectOf(target);
    return projectId !== undefined && principal.projectIds.includes(projectId);
  };

  const grantAllows = (action: Action, target: Target): boolean => {
    if (!user) return false;
    const scopes = [and(eq(grants.scopeType, target.type), eq(grants.scopeId, target.id))];
    if (target.type === "service") {
      // A project grant covers every service in the project.
      const projectId = projectOf(target);
      if (projectId) scopes.push(and(eq(grants.scopeType, "project"), eq(grants.scopeId, projectId)));
    }
    const rows = db
      .select({ actions: grants.actions })
      .from(grants)
      .where(and(eq(grants.userId, user.id), or(...scopes)))
      .all();
    return rows.some((row) => actionAllowed(row.actions, action));
  };

  const can = (action: Action, target?: Target): boolean => {
    if (!user || !keyAllows(action, target)) return false;
    if (isAdmin) return true;
    return target !== undefined && grantAllows(action, target);
  };

  const canSomewhere = (actions: readonly Action[]): boolean => {
    if (!user) return false;
    const wanted = principal.type === "apiKey" ? actions.filter((a) => actionAllowed(principal.actions, a)) : actions;
    if (wanted.length === 0) return false;
    const keyProjects = principal.type === "apiKey" ? principal.projectIds : null;
    if (isAdmin) return keyProjects === null || keyProjects.length > 0;
    const rows = db
      .select({ scopeType: grants.scopeType, scopeId: grants.scopeId, actions: grants.actions })
      .from(grants)
      .where(eq(grants.userId, user.id))
      .all();
    return rows.some((row) => {
      if (!wanted.some((action) => actionAllowed(row.actions, action))) return false;
      if (keyProjects === null) return true;
      const projectId = projectOf({ type: row.scopeType, id: row.scopeId });
      return projectId !== undefined && keyProjects.includes(projectId);
    });
  };

  return {
    principal,
    can,
    canSomewhere,
    require(permission, kind, input) {
      if (permission.kind === "public") return undefined;
      if (!user) throw new OpError("UNAUTHENTICATED", "Sign in or use a valid API key.");
      if (principal.type === "apiKey" && principal.readOnly && kind !== "query") {
        throw new OpError("FORBIDDEN", "This key is read-only.");
      }
      if (permission.kind === "signedIn") return undefined;

      const target = targetOf(permission, input);
      if (!can(permission.action, target)) {
        throw new OpError("FORBIDDEN", `You do not have the ${permission.action} permission here.`, { action: permission.action });
      }
      return target;
    },
  };
}

/** The project or service a permission names for this input; undefined for panel-wide and unscoped ops. */
export function targetOf(permission: AnyPermission, input: unknown): Target | undefined {
  if (permission.kind !== "project" && permission.kind !== "service") return undefined;
  return { type: permission.kind, id: permission.resource(input as never) };
}
