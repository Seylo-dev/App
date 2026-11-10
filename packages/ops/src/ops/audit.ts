// The audit log (Activity page): one entry per change made through an op,
// and per refused attempt, with sensitive input redacted. Owners, admins
// and holders of audit.view see everything; everyone else sees only their
// own entries.

import { Type } from "@sinclair/typebox";
import { AvatarUrl } from "../avatars";
import { defineOp } from "../define";
import { Cursor } from "../people";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";

export const ActorType = Type.Union([
  Type.Literal("user"),
  Type.Literal("apiKey"),
  Type.Literal("mcp"),
  Type.Literal("ai"),
  Type.Literal("agent"),
  Type.Literal("system"),
  Type.Literal("anonymous"),
]);

export const AuditOutcome = Type.Union([Type.Literal("ok"), Type.Literal("error")]);

export const AuditEntry = Type.Object({
  /** Increasing integer as a string; newer entries have larger ids. */
  id: Type.String({ pattern: "^[0-9]+$" }),
  at: Timestamp,
  actor: Type.Object({
    type: ActorType,
    /** User id; null for anonymous and system. */
    id: Type.Union([Id, Type.Null()]),
    /** As it was then, for example "you@example.com via key ci". */
    label: Type.String(),
    /** The person's avatar now, while the account exists. */
    avatarUrl: Type.Optional(AvatarUrl),
    /** Key, token or session id used. */
    credentialId: Type.Union([Type.String(), Type.Null()]),
  }),
  /** For example "services.deploy"; the web app turns it into a sentence. */
  opId: Type.String(),
  target: Type.Union([
    Type.Object({
      type: Type.String(),
      id: Type.String(),
      /** Name at the time of the entry, when known. */
      label: Type.Union([Type.String(), Type.Null()]),
    }),
    Type.Null(),
  ]),
  /** The project the target belongs to (the project itself, or the service's project) at the time; null when there was no target. */
  projectId: Type.Union([Id, Type.Null()]),
  /** The op's input with sensitive fields replaced by "[redacted]". */
  input: Type.Record(Type.String(), Type.Unknown()),
  outcome: AuditOutcome,
  errorCode: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Integer({ minimum: 0 }),
  ip: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  approvalId: Type.Union([Type.String(), Type.Null()]),
});

/** Filters shared by list and export; all optional and combined with AND. */
const filters = {
  actorId: Type.Optional(Id),
  actorType: Type.Optional(ActorType),
  opId: Type.Optional(Type.String({ maxLength: 80, description: 'Exact op id ("services.deploy") or a module with a dot ("services.").' })),
  targetType: Type.Optional(Type.String({ maxLength: 40 })),
  targetId: Type.Optional(Type.String({ maxLength: 40 })),
  projectId: Type.Optional(Id),
  outcome: Type.Optional(AuditOutcome),
  from: Type.Optional(Timestamp),
  to: Type.Optional(Timestamp),
  q: Type.Optional(Type.String({ maxLength: 100, description: "Matches the actor label, op id or target label." })),
};

export const list = defineOp({
  id: "audit.list",
  kind: "query",
  summary: "List audit log entries",
  description:
    "Lists audit entries newest first, filtered by actor, op, target, project (its services included), outcome and time. Pass nextCursor back as cursor for the next page. Without audit.view only your own entries are returned.",
  input: Type.Object({
    ...filters,
    cursor: Type.Optional(Cursor),
    limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
  }),
  output: Type.Object({
    entries: Type.Array(AuditEntry),
    nextCursor: Type.Union([Cursor, Type.Null()]),
  }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const get = defineOp({
  id: "audit.get",
  kind: "query",
  summary: "Get an audit log entry",
  description: "Returns one audit entry by id. Without audit.view only your own entries.",
  input: Type.Object({ entryId: Type.String({ pattern: "^[0-9]+$", maxLength: 20 }) }),
  output: AuditEntry,
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const exportLog = defineOp({
  id: "audit.export",
  kind: "query",
  summary: "Export the audit log",
  description:
    "Returns matching entries (newest first, at most 10,000) as a CSV or JSON Lines file for download. truncated is true when more matched.",
  input: Type.Object({
    ...filters,
    format: Type.Union([Type.Literal("csv"), Type.Literal("jsonl")], { default: "csv" }),
  }),
  output: Type.Object({
    filename: Type.String(),
    contentType: Type.String(),
    content: Type.String(),
    rows: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
  }),
  permission: permission.global("audit.view"),
  mcp: false,
  // Reading the whole log out is itself worth a line in it.
  audit: true,
});
