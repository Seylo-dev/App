// Approvals: when a model (an MCP client or the AI assistant) calls an op
// that is not a query and the caller's token requires it, the op does not
// run. An approval is stored with the exact input; a person approves (the
// op then runs through the normal pipeline as that person, so their own
// permissions apply) or denies it. Models can read approvals but never
// decide them: approve and deny are not MCP tools.

import { type Static, Type } from "@sinclair/typebox";
import { AvatarUrl } from "../avatars";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";

export const ApprovalStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
  Type.Literal("expired"),
  Type.Literal("executed"),
  Type.Literal("failed"),
]);
export type ApprovalStatus = Static<typeof ApprovalStatus>;

/**
 * Where a request came from, for the chips on the Approvals page and the
 * link back: an assistant chat, or an MCP token.
 */
export const ApprovalSource = Type.Union([
  Type.Object({
    kind: Type.Literal("assistant"),
    conversationId: Id,
    /** The chat's title, only for the person whose chat it is (chats are private); empty for everyone else. */
    title: Type.String(),
    /** The chat still exists and is the caller's, so the chip can open it. */
    mine: Type.Boolean(),
  }),
  Type.Object({
    kind: Type.Literal("mcp"),
    /** The token that asked; null when the approval does not name one. */
    keyId: Type.Union([Id, Type.Null()]),
    /** The token's name (an MCP app's registered name), or the name it had when it asked. */
    clientName: Type.String(),
  }),
]);
export type ApprovalSource = Static<typeof ApprovalSource>;

export const Approval = Type.Object({
  id: Id,
  opId: Type.String(),
  /** The op's summary, for the list ("Delete a project"). */
  opSummary: Type.String(),
  opKind: Type.Union([Type.Literal("mutation"), Type.Literal("destructive")]),
  /** The input with sensitive fields replaced by "[redacted]". */
  inputPreview: Type.Unknown(),
  /** Which kind of model asked. */
  via: Type.Union([Type.Literal("mcp"), Type.Literal("ai")]),
  /** The chat or token that asked. */
  source: ApprovalSource,
  requestedBy: Type.Object({
    /** The person the token or assistant acts for. */
    userId: Type.Union([Id, Type.Null()]),
    userName: Type.String(),
    /** The person's avatar, while the account exists. */
    avatarUrl: Type.Optional(AvatarUrl),
    /** MCP token name or "AI assistant". */
    clientName: Type.String(),
  }),
  /** Why the model wants to do it, in its own words. */
  reason: Type.String(),
  /** The project or service it touches, when the op names one. */
  target: Type.Union([
    Type.Object({ type: Type.Union([Type.Literal("project"), Type.Literal("service")]), id: Id, name: Type.String() }),
    Type.Null(),
  ]),
  status: ApprovalStatus,
  decidedBy: Type.Union([Type.Object({ id: Id, name: Type.String() }), Type.Null()]),
  decidedAt: Type.Union([Timestamp, Type.Null()]),
  /** Error message when the approved op failed. */
  error: Type.Union([Type.String(), Type.Null()]),
  expiresAt: Timestamp,
  createdAt: Timestamp,
});
export type Approval = Static<typeof Approval>;

export const list = defineOp({
  id: "approvals.list",
  kind: "query",
  summary: "List approvals",
  description:
    "Lists approvals newest first: pending ones by default, or every status. Owners and admins see all; others see the ones their own tokens and assistant chats asked for.",
  input: Type.Object({
    status: Type.Optional(Type.Union([ApprovalStatus, Type.Literal("all")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    cursor: Type.Optional(Type.String({ maxLength: 64 })),
  }),
  output: Type.Object({
    approvals: Type.Array(Approval),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    /** For the sidebar badge, regardless of the filter. */
    pendingCount: Type.Integer({ minimum: 0 }),
  }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const get = defineOp({
  id: "approvals.get",
  kind: "query",
  summary: "Get an approval",
  description: "Returns one approval. Models use it to see whether the action they asked for was approved, denied or has run.",
  input: Type.Object({ approvalId: Id }),
  output: Approval,
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const approve = defineOp({
  id: "approvals.approve",
  kind: "mutation",
  summary: "Approve and run an action",
  description:
    "Approves a pending approval and runs its op at once as the approving person, with their permissions; FORBIDDEN if they could not run it themselves. Returns the approval with status executed or failed.",
  input: Type.Object({ approvalId: Id }),
  output: Approval,
  permission: permission.signedIn(),
  // Never a model tool: a model must not approve its own request.
  mcp: false,
  audit: true,
});

export const deny = defineOp({
  id: "approvals.deny",
  kind: "mutation",
  summary: "Deny an action",
  description: "Rejects a pending approval; the model is told it was denied, with the note when given.",
  input: Type.Object({ approvalId: Id, note: Type.Optional(Type.String({ maxLength: 500 })) }),
  output: Approval,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});
