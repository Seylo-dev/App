// Invites, Monday style: an owner or admin invites an email as an admin, or
// as a member with grants on chosen projects and services. The link holds a
// one-time token (valid 7 days by default); accepting creates the account
// with those grants. Inviting an email that already has an account adds the
// grants to it instead, once that person accepts while signed in.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { Email, GrantScope, InvitableRole, LoginResult, NewPassword, PersonName, ScopeType } from "../people";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";

export const InviteStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("expired"),
  Type.Literal("revoked"),
]);

export const InviteGrant = Type.Object({
  scopeType: ScopeType,
  scopeId: Id,
  /** Project or service name now; empty when it was deleted since. */
  scopeName: Type.String(),
  actions: Type.Array(Type.String()),
});

export const Invite = Type.Object({
  id: Id,
  email: Email,
  role: InvitableRole,
  grants: Type.Array(InviteGrant),
  status: InviteStatus,
  invitedBy: Type.Union([Type.Object({ id: Id, email: Type.String(), name: Type.String() }), Type.Null()]),
  expiresAt: Timestamp,
  acceptedAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
});

const InviteToken = Type.String({ minLength: 1, maxLength: 200, description: "The token from the invite link." });

export const create = defineOp({
  id: "invites.create",
  kind: "mutation",
  summary: "Invite someone",
  description:
    'Creates an invite link for an email, as an admin or as a member with grants on projects and services. The link is returned once; send it yourself, or it is emailed when the panel has an SMTP channel. An admin invite from a browser session needs a sign-in or auth.reauth from the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise); API keys need none.',
  input: Type.Object({
    email: Email,
    role: InvitableRole,
    grants: Type.Array(GrantScope, { default: [], maxItems: 200, description: "Members only; admins need none." }),
    expiresInDays: Type.Integer({ minimum: 1, maximum: 30, default: 7 }),
    sendEmail: Type.Boolean({ default: true, description: "Email the link through the default SMTP channel, when one exists." }),
  }),
  output: Type.Object({
    invite: Invite,
    /** Full URL with the token. Shown once; only its hash is stored. */
    link: Type.String(),
    emailed: Type.Boolean(),
  }),
  permission: permission.global("users.invite"),
  sensitive: { output: ["link"] },
  mcp: false,
  audit: true,
});

export const list = defineOp({
  id: "invites.list",
  kind: "query",
  summary: "List invites",
  description: "Lists invites, newest first. Pending ones first unless a status is given.",
  input: Type.Object({ status: Type.Optional(InviteStatus) }),
  output: Type.Object({ invites: Type.Array(Invite) }),
  permission: permission.global("users.view"),
  mcp: false,
  audit: false,
});

export const revoke = defineOp({
  id: "invites.revoke",
  kind: "mutation",
  summary: "Revoke an invite",
  description: "Makes a pending invite link stop working. Accepted invites cannot be revoked; remove the person or their grants instead.",
  input: Type.Object({ inviteId: Id }),
  output: Invite,
  permission: permission.global("users.invite"),
  mcp: false,
  audit: true,
});

export const preview = defineOp({
  id: "invites.preview",
  kind: "query",
  summary: "Look at an invite",
  description:
    "What the accept page shows before anyone signs up: who invited whom, as what, to which projects and services. valid is false for used, revoked, expired or unknown tokens.",
  input: Type.Object({ token: InviteToken }),
  output: Type.Object({
    valid: Type.Boolean(),
    email: Type.Union([Type.String(), Type.Null()]),
    role: Type.Union([InvitableRole, Type.Null()]),
    invitedBy: Type.Union([Type.String(), Type.Null()]),
    grants: Type.Array(InviteGrant),
    /** True when the email already has an account: sign in, then accept. */
    accountExists: Type.Boolean(),
    expiresAt: Type.Union([Timestamp, Type.Null()]),
    githubAvailable: Type.Boolean(),
  }),
  permission: permission.public(),
  sensitive: { input: ["token"] },
  rateLimit: "strict",
  mcp: false,
  audit: false,
});

export const accept = defineOp({
  id: "invites.accept",
  kind: "mutation",
  summary: "Accept an invite",
  description:
    "Uses up the invite token. Without a session it creates the account (password required) and signs in. With a session whose email matches it adds the invite's grants to that account.",
  input: Type.Object({
    token: InviteToken,
    name: Type.Optional(PersonName),
    password: Type.Optional(NewPassword),
  }),
  output: LoginResult,
  permission: permission.public(),
  sensitive: { input: ["token", "password"], output: ["challenge.ticket"] },
  rateLimit: "strict",
  mcp: false,
  audit: true,
});
