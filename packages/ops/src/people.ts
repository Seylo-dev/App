// Schemas shared by the people modules (auth, setup, users, invites,
// grants, apiKeys, audit). They live outside src/ops/ because every file
// there is an op module.

import { Type } from "@sinclair/typebox";
import { Id, Timestamp } from "./schemas";

export const Role = Type.Union([Type.Literal("owner"), Type.Literal("admin"), Type.Literal("member")], {
  description: "owner and admin may do everything; members only what their grants allow.",
});

/** Roles an owner or admin can hand out; "owner" is only reachable through users.updateRole by an owner. */
export const InvitableRole = Type.Union([Type.Literal("admin"), Type.Literal("member")]);

export const Email = Type.String({ format: "email", maxLength: 254 });

/** New passwords: long enough to matter, short enough that hashing stays cheap. */
export const NewPassword = Type.String({ minLength: 10, maxLength: 1024, description: "At least 10 characters." });

export const PersonName = Type.String({ maxLength: 80 });

export const Viewer = Type.Object({
  id: Id,
  email: Email,
  name: Type.String(),
  role: Role,
});

/**
 * A permission action, "<area>.<verb>" (for example "services.deploy"),
 * "<area>.*" for every action of one area, or "*" for every action. See
 * actionCatalog() for the list a screen shows and actionAllowed() for
 * how lists match.
 */
export const ActionName = Type.String({ pattern: "^(\\*|[a-z][a-zA-Z0-9]*\\.(\\*|[a-z][a-zA-Z0-9]*))$", maxLength: 80 });

export const ActionList = Type.Array(ActionName, { minItems: 1, maxItems: 200, uniqueItems: true });

export const ScopeType = Type.Union([Type.Literal("project"), Type.Literal("service")]);

/** What a member may do on one project (covers its services) or one service. */
export const GrantScope = Type.Object({
  scopeType: ScopeType,
  scopeId: Id,
  actions: ActionList,
});

/** A grant as screens show it, with the resource's current name. */
export const Grant = Type.Object({
  id: Id,
  userId: Id,
  scopeType: ScopeType,
  scopeId: Id,
  /** Project or service name; empty when the resource no longer exists. */
  scopeName: Type.String(),
  /** For service grants, the project the service belongs to. */
  projectId: Type.Union([Id, Type.Null()]),
  actions: Type.Array(ActionName),
  createdBy: Type.Union([Id, Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const SecondFactorMethod = Type.Union([Type.Literal("totp"), Type.Literal("recovery")]);

/**
 * The result of every way to sign in. "secondFactor" means the password
 * (or GitHub, or the invite) was right but the account has 2FA: no session
 * yet, finish with auth.verifySecondFactor and the challenge's ticket.
 */
export const LoginResult = Type.Object({
  status: Type.Union([Type.Literal("signedIn"), Type.Literal("secondFactor")]),
  viewer: Viewer,
  challenge: Type.Optional(
    Type.Object({
      /** Short-lived (5 minutes), single use; send it back with the code. */
      ticket: Type.String(),
      methods: Type.Array(SecondFactorMethod),
      expiresAt: Timestamp,
    }),
  ),
});

/** GitHub device flow (like `gh auth login`): show userCode, open verificationUri, then poll with ticket. */
export const DeviceCode = Type.Object({
  /** Opaque panel ticket for the poll op; the GitHub device code never leaves the panel. */
  ticket: Type.String(),
  /** Shown to the person, for example "WDJB-MJHT". */
  userCode: Type.String(),
  verificationUri: Type.String(),
  expiresAt: Timestamp,
  /** Wait at least this long between polls. */
  intervalSeconds: Type.Integer({ minimum: 1 }),
});

/** Poll states shared by every device-flow poll op. "slowDown" means: add 5 seconds to the interval. */
export const DevicePollStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("slowDown"),
  Type.Literal("expired"),
  Type.Literal("denied"),
  Type.Literal("done"),
]);

export const RepoAccess = Type.Boolean({
  default: false,
  description:
    "Also ask for the repo scope so this GitHub login can clone private repos. Off by default: a GitHub App gives narrower access.",
});

/**
 * WebAuthn JSON (PublicKeyCredentialCreationOptionsJSON / RequestOptionsJSON
 * on the way out, RegistrationResponseJSON / AuthenticationResponseJSON on the
 * way in), passed through to and from @simplewebauthn/browser unchanged.
 */
export const WebAuthnJson = Type.Record(Type.String(), Type.Unknown(), { description: "WebAuthn options or response JSON." });

/** Opaque cursor for keyset paging; pass back nextCursor to get the next page. */
export const Cursor = Type.String({ maxLength: 200 });
