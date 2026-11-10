// People with an account on this panel (Settings > People). Owners and
// admins manage them; members are scoped by grants (see grants.ts).
//
// Role rules, enforced by the handlers:
// - Only an owner can make someone an owner or change an owner's role.
// - Admins manage members and other admins, never owners.
// - The last active owner cannot be demoted, disabled or removed.
// - Nobody changes their own role, disables or removes themselves.

import { Type } from "@sinclair/typebox";
import { AvatarUrl } from "../avatars";
import { defineOp } from "../define";
import { Email, Grant, PersonName, Role } from "../people";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

export const UserStatus = Type.Union([Type.Literal("active"), Type.Literal("disabled")]);

export const User = Type.Object({
  id: Id,
  email: Email,
  name: Type.String(),
  /** The person's avatar image (added with avatars). */
  avatarUrl: Type.Optional(AvatarUrl),
  role: Role,
  status: UserStatus,
  /** Authenticator app turned on. */
  twoFactor: Type.Boolean(),
  passkeyCount: Type.Integer({ minimum: 0 }),
  /** Linked GitHub login, if any. */
  githubLogin: Type.Union([Type.String(), Type.Null()]),
  /** Projects and services this person has grants on (0 for owners and admins, who need none). */
  grantCount: Type.Integer({ minimum: 0 }),
  lastLoginAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
});

export const list = defineOp({
  id: "users.list",
  kind: "query",
  summary: "List people",
  description: "Lists every account on the panel with role, status, 2FA and last sign-in, owners first, then by email.",
  input: Type.Object({
    role: Type.Optional(Role),
    status: Type.Optional(UserStatus),
    q: Type.Optional(Type.String({ maxLength: 100, description: "Matches email or name." })),
  }),
  output: Type.Object({ users: Type.Array(User) }),
  permission: permission.global("users.view"),
  mcp: true,
  audit: false,
});

export const get = defineOp({
  id: "users.get",
  kind: "query",
  summary: "Get a person",
  description: "Returns one account with every grant it holds on projects and services.",
  input: Type.Object({ userId: Id }),
  output: Type.Object({ user: User, grants: Type.Array(Grant) }),
  permission: permission.global("users.view"),
  mcp: true,
  audit: false,
});

export const update = defineOp({
  id: "users.update",
  kind: "mutation",
  summary: "Change a person's name or email",
  description:
    "Changes an account's display name or email (people change their own email with auth.changeEmail). CONFLICT when the email is taken.",
  input: Type.Object({
    userId: Id,
    name: Type.Optional(PersonName),
    email: Type.Optional(Email),
  }),
  output: User,
  permission: permission.global("users.manage"),
  mcp: false,
  audit: true,
});

export const updateRole = defineOp({
  id: "users.updateRole",
  kind: "mutation",
  summary: "Change a person's role",
  description:
    'Makes someone an owner, admin or member. Owners and admins can do everything; members keep their grants and can only do what those allow. Only owners touch owner roles. A promotion (to admin, or to owner) from a browser session needs a sign-in or auth.reauth from the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise); API keys need none.',
  input: Type.Object({ userId: Id, role: Role }),
  output: User,
  permission: permission.global("users.manage"),
  mcp: false,
  audit: true,
});

export const disable = defineOp({
  id: "users.disable",
  kind: "mutation",
  summary: "Disable a person",
  description:
    "Blocks sign-in for an account and ends its sessions and API keys right away. Grants and history stay; users.enable undoes it.",
  input: Type.Object({ userId: Id }),
  output: User,
  permission: permission.global("users.manage"),
  mcp: false,
  audit: true,
});

export const enable = defineOp({
  id: "users.enable",
  kind: "mutation",
  summary: "Enable a person",
  description: "Lets a disabled account sign in again. Its API keys stay revoked.",
  input: Type.Object({ userId: Id }),
  output: User,
  permission: permission.global("users.manage"),
  mcp: false,
  audit: true,
});

export const remove = defineOp({
  id: "users.remove",
  kind: "destructive",
  summary: "Remove a person",
  description:
    "Deletes an account with its sessions, second factors, API keys and grants. The audit log keeps its entries. The caller repeats the email to confirm.",
  input: Type.Object({
    userId: Id,
    confirmEmail: Type.String({ maxLength: 254, description: "Must equal the account's email." }),
  }),
  output: Empty,
  permission: permission.global("users.manage"),
  mcp: false,
  audit: true,
});
