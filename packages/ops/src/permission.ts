// Who may run an operation. Every op declares one of these explicitly, so a
// missing check is a type error instead of an open endpoint.

/**
 * A permission action names one thing a person can be allowed to do, as
 * "<area>.<verb>" (for example "services.deploy"). Grants, API key scopes
 * and the invite screen all speak in actions.
 */
export type Action = `${string}.${string}`;

/** Extracts the id of the resource an op touches from its validated input. */
export type ResourceOf<Input> = (input: Input) => string;

/** Anyone, signed in or not: sign-in itself, health. */
export interface PublicPermission {
  readonly kind: "public";
}

/**
 * Any signed-in principal, for ops that only touch the caller's own data.
 * `account`: data that spans the whole account (assistant chats, the
 * person's keys, security settings, preferences, grants), so API keys and
 * MCP tokens limited to some projects or to a list of actions are refused.
 */
export interface SignedInPermission {
  readonly kind: "signedIn";
  readonly account?: true;
}

/** Panel-wide action, held by owners, admins and keys scoped to it. */
export interface GlobalPermission {
  readonly kind: "global";
  readonly action: Action;
}

/**
 * Action on one project or service. Members need a grant on that resource;
 * a project grant also covers the project's services.
 */
export interface ScopedPermission<Input> {
  readonly kind: ScopeKind;
  readonly action: Action;
  readonly resource: ResourceOf<Input>;
}

export type ScopeKind = "project" | "service";

export type Permission<Input> = PublicPermission | SignedInPermission | GlobalPermission | ScopedPermission<Input>;

/**
 * Any op's permission. `never` as the input type accepts every resource
 * extractor because function parameters are contravariant.
 */
export type AnyPermission = Permission<never>;

/** Builders keep op definitions short and the union above closed. */
export const permission = {
  public: (): PublicPermission => ({ kind: "public" }),
  signedIn: (): SignedInPermission => ({ kind: "signedIn" }),
  /** signedIn for account-wide data: narrowed keys and tokens are refused. */
  account: (): SignedInPermission => ({ kind: "signedIn", account: true }),
  global: (action: Action): GlobalPermission => ({ kind: "global", action }),
  project: <Input>(action: Action, resource: ResourceOf<Input>): ScopedPermission<Input> => ({
    kind: "project",
    action,
    resource,
  }),
  service: <Input>(action: Action, resource: ResourceOf<Input>): ScopedPermission<Input> => ({
    kind: "service",
    action,
    resource,
  }),
};

/** Human-readable form for OpenAPI and docs, for example "project:services.deploy". */
export function describePermission(p: AnyPermission): string {
  switch (p.kind) {
    case "public":
      return "public";
    case "signedIn":
      return p.account ? "signed-in, whole account" : "signed-in";
    case "global":
      return p.action;
    default:
      return `${p.kind}:${p.action}`;
  }
}
