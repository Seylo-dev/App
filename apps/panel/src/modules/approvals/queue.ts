// The approval queue: a model (MCP client or the AI assistant) asked to run
// an op a person must approve first. The exact input is sealed; a redacted
// copy is shown. Approving checks that both the approver and the requester
// may run the op, then replays it through the normal pipeline with
// approvalId set (the only way a destructive op runs for a model).

import { type AnyOpContract, actionAllowed, allOps, OpError, redact } from "@seylo/ops";
import { and, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { createAccess, isNarrowedKey, type Target } from "../../auth/access";
import type { Principal } from "../../auth/principal";
import type { PanelDb } from "../../db/client";
import { aiConversations, apiKeys, approvals, projects, services, users } from "../../db/schema";
import type { Deps } from "../../deps";
import { parseInput } from "../../ops/validate";
import { runOpAs } from "./run-as";

export type ApprovalRow = typeof approvals.$inferSelect;

/** Pending approvals expire after this long. */
export const approvalLifetimeMs = 24 * 60 * 60 * 1000;

const opsById = new Map(allOps.map((op) => [op.id, op]));

export function opById(opId: string): AnyOpContract | undefined {
  return opsById.get(opId);
}

export interface ApprovalRequest {
  op: AnyOpContract;
  /** Validated input. */
  input: unknown;
  principal: Exclude<Principal, { type: "anonymous" }>;
  via: "mcp" | "ai";
  /** MCP token id, or the AI conversation id. */
  requestedVia: string | null;
  reason?: string;
  target?: Target | undefined;
}

/**
 * The source's name as the request is made: the chat's title, or the MCP
 * token's name (an MCP app's registered name). Stored on the approval, so
 * the Approvals page still names it after the chat or token is gone.
 */
function sourceLabelOf(db: PanelDb, request: ApprovalRequest): string {
  if (request.via === "mcp") {
    if (request.principal.type === "apiKey") return request.principal.keyName;
    if (!request.requestedVia) return "";
    return db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, request.requestedVia)).get()?.name ?? "";
  }
  if (!request.requestedVia) return "";
  return (
    db.select({ title: aiConversations.title }).from(aiConversations).where(eq(aiConversations.id, request.requestedVia)).get()?.title ?? ""
  );
}

export interface ApprovalDecision {
  approval: ApprovalRow;
  /** The op's output when it ran; redacted with the op's sensitive output paths. */
  output: unknown;
}

type Listener = (decision: ApprovalDecision) => void;
/** Per panel (keyed by its database), so test panels never hear each other. */
const listeners = new WeakMap<PanelDb, Set<Listener>>();

/** Called after an approval was executed, failed, rejected or expired (the AI assistant updates its tool calls). */
export function onApprovalDecided(deps: Pick<Deps, "db">, listener: Listener): () => void {
  const set = listeners.get(deps.db) ?? new Set<Listener>();
  listeners.set(deps.db, set);
  set.add(listener);
  return () => set.delete(listener);
}

function emit(decision: ApprovalDecision, deps: Pick<Deps, "logger" | "db">) {
  for (const listener of listeners.get(deps.db) ?? []) {
    try {
      listener(decision);
    } catch (error) {
      deps.logger.error({ err: error }, "approval listener failed");
    }
  }
}

export function requestApproval(deps: Pick<Deps, "db" | "secrets" | "live" | "alerts">, request: ApprovalRequest): ApprovalRow {
  const now = new Date();
  const row = deps.db
    .insert(approvals)
    .values({
      opId: request.op.id,
      inputSealed: deps.secrets.seal(JSON.stringify(request.input ?? {}), "approval.input"),
      inputPreview: redact(request.input ?? {}, request.op.sensitive?.input),
      requestedByType: request.via,
      requestedById: request.principal.user.id,
      requestedVia: request.requestedVia,
      sourceLabel: sourceLabelOf(deps.db, request).slice(0, 200),
      reason: (request.reason ?? "").slice(0, 2000),
      targetType: request.target?.type ?? null,
      targetId: request.target?.id ?? null,
      expiresAt: new Date(now.getTime() + approvalLifetimeMs),
      createdAt: now,
    })
    .returning()
    .get();
  deps.live.publish("panel", { type: "invalidate", ops: ["approvals.list", "approvals.get"] });
  const who = request.principal.user.name || request.principal.user.email;
  deps.alerts.raise({
    event: "approval_requested",
    key: `approval:${row.id}`,
    title: `${request.via === "ai" ? "The AI assistant" : "An MCP client"} asks to ${lowerFirst(request.op.summary)}`,
    message: `Requested for ${who}. Approve or deny it in Approvals.`,
    link: "/approvals",
  });
  return row;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Who may see (and decide) an approval: owners and admins all of them;
 * others the ones asked for them. A key limited to projects or actions sees
 * the approvals it asked for itself, and others only inside its scope.
 */
export function canSee(db: PanelDb, principal: Principal, row: ApprovalRow): boolean {
  if (principal.type === "anonymous") return false;
  const byRole = principal.user.role === "owner" || principal.user.role === "admin" || row.requestedById === principal.user.id;
  if (!byRole) return false;
  if (!isNarrowedKey(principal) || row.requestedVia === principal.keyId) return true;
  const sql = keyApprovalScope(db, principal);
  return (
    db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.id, row.id), sql))
      .get() !== undefined
  );
}

/** Approval ops whose action a key's list allows (ops without an action need "*"). */
function opsAllowedBy(actions: readonly string[]): string[] {
  return allOps
    .filter((op) => {
      const p = op.permission;
      return p.kind !== "public" && p.kind !== "signedIn" && actionAllowed(actions, p.action);
    })
    .map((op) => op.id);
}

/**
 * The approvals a key limited to projects or actions may read besides its
 * own requests: ops its action list covers, aimed at its projects (a
 * project-limited key never sees approvals without a project).
 */
export function keyApprovalScope(db: PanelDb, key: Extract<Principal, { type: "apiKey" }>): SQL {
  const parts: SQL[] = [];
  if (!key.actions.includes("*")) parts.push(inList(approvals.opId, opsAllowedBy(key.actions)));
  if (key.projectIds !== null) {
    const ids = [...key.projectIds];
    const inProjects =
      ids.length === 0
        ? sql`0`
        : or(
            and(eq(approvals.targetType, "project"), inArray(approvals.targetId, ids)),
            and(
              eq(approvals.targetType, "service"),
              inArray(approvals.targetId, db.select({ id: services.id }).from(services).where(inArray(services.projectId, ids))),
            ),
          );
    parts.push(inProjects as SQL);
  }
  return or(eq(approvals.requestedVia, key.keyId), and(...parts)) as SQL;
}

function inList(column: typeof approvals.opId, values: string[]): SQL {
  return values.length === 0 ? sql`0` : inArray(column, values);
}

/** The principal the request was made as, rebuilt from the database (null when it no longer may act). */
export function requesterPrincipal(db: PanelDb, row: ApprovalRow, now = new Date()): Principal | null {
  if (!row.requestedById) return null;
  const user = db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, row.requestedById))
    .get();
  if (!user || user.disabledAt) return null;
  const { disabledAt: _, ...person } = user;
  if (row.requestedByType !== "mcp" || !row.requestedVia) return { type: "session", user: person, sessionId: "approval" };
  const key = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, row.requestedVia), isNull(apiKeys.revokedAt)))
    .get();
  if (!key || (key.expiresAt && key.expiresAt <= now)) return null;
  return {
    type: "apiKey",
    user: person,
    keyId: key.id,
    keyName: key.name,
    keyKind: key.kind,
    actions: key.actions,
    projectIds: key.projectIds ?? null,
    readOnly: key.readOnly,
  };
}

export function openInput(deps: Pick<Deps, "secrets">, row: ApprovalRow): unknown {
  const plain = deps.secrets.open(row.inputSealed, "approval.input");
  if (plain === null) throw new OpError("INTERNAL", "The approval's input cannot be read.");
  return JSON.parse(plain);
}

/** Marks overdue pending approvals expired; returns how many. */
export function expireOverdue(deps: Pick<Deps, "db" | "live" | "logger">, now = new Date()): number {
  const expired = deps.db
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
    .returning()
    .all();
  if (expired.length) deps.live.publish("panel", { type: "invalidate", ops: ["approvals.list", "approvals.get"] });
  for (const row of expired) emit({ approval: row, output: null }, deps);
  return expired.length;
}

function pending(deps: Pick<Deps, "db" | "live" | "logger">, approvalId: string, principal: Principal): ApprovalRow {
  expireOverdue(deps);
  const row = deps.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
  if (!row || !canSee(deps.db, principal, row)) throw new OpError("NOT_FOUND", "There is no such approval.");
  if (row.status !== "pending") throw new OpError("CONFLICT", `This approval is already ${row.status}.`, { status: row.status });
  if (principal.type !== "session") throw new OpError("FORBIDDEN", "Approvals are decided by people in the panel, not with keys.");
  return row;
}

export async function approve(
  deps: Deps,
  approvalId: string,
  approver: Principal,
  meta: { ip: string | null; userAgent: string | null },
): Promise<ApprovalRow> {
  const row = pending(deps, approvalId, approver);
  const op = opById(row.opId);
  if (!op) throw new OpError("CONFLICT", "This action no longer exists in this panel version.");
  const input = parseInput(op.input, openInput(deps, row), false);

  // The approver must be allowed to do it themselves, and so must the requester still.
  createAccess(deps.db, approver).require(op.permission, op.kind, input);
  const requester = requesterPrincipal(deps.db, row);
  if (!requester) throw new OpError("CONFLICT", "The person or token that asked for this can no longer act. Deny it instead.");
  try {
    createAccess(deps.db, requester).require(op.permission, op.kind, input);
  } catch (error) {
    if (error instanceof OpError) throw new OpError("FORBIDDEN", `The requester may not do this: ${error.message}`);
    throw error;
  }
  if (approver.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");

  // Claim it before running, so a double click cannot run it twice.
  const claimed = deps.db
    .update(approvals)
    .set({ status: "approved", decidedBy: approver.user.id, decidedAt: new Date() })
    .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
    .returning()
    .get();
  if (!claimed) throw new OpError("CONFLICT", "Someone else decided this approval just now.");

  const outcome = await runOpAs(deps, {
    op,
    input,
    userId: approver.user.id,
    transport: row.requestedByType === "ai" ? "ai" : "mcp",
    approvalId: row.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  const output = outcome.ok ? redact(outcome.output, op.sensitive?.output) : null;
  const done = deps.db
    .update(approvals)
    .set(outcome.ok ? { status: "executed", resultPreview: output ?? null } : { status: "failed", error: outcome.error.message })
    .where(eq(approvals.id, row.id))
    .returning()
    .get() as ApprovalRow;
  deps.alerts.resolve(`approval:${row.id}`);
  deps.live.publish("panel", { type: "invalidate", ops: ["approvals.list", "approvals.get"] });
  emit({ approval: done, output }, deps);
  return done;
}

export function deny(deps: Deps, approvalId: string, decider: Principal, note: string | undefined): ApprovalRow {
  const row = pending(deps, approvalId, decider);
  if (decider.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  const done = deps.db
    .update(approvals)
    .set({ status: "rejected", decidedBy: decider.user.id, decidedAt: new Date(), decisionNote: note ?? null })
    .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
    .returning()
    .get();
  if (!done) throw new OpError("CONFLICT", "Someone else decided this approval just now.");
  deps.alerts.resolve(`approval:${row.id}`);
  deps.live.publish("panel", { type: "invalidate", ops: ["approvals.list", "approvals.get"] });
  emit({ approval: done, output: null }, deps);
  return done;
}

/**
 * The approval as the API returns it, for `viewerId`: a chat's title goes
 * to the person whose chat it is only (chats are private).
 */
export function toApproval(db: PanelDb, row: ApprovalRow, viewerId: string | null) {
  const op = opById(row.opId);
  const requester = row.requestedById
    ? db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.requestedById)).get()
    : undefined;
  const key =
    row.requestedByType === "mcp" && row.requestedVia
      ? db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, row.requestedVia)).get()
      : undefined;
  const decider = row.decidedBy
    ? db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, row.decidedBy)).get()
    : undefined;
  const chat =
    row.requestedByType === "ai" && row.requestedVia
      ? db
          .select({ title: aiConversations.title, userId: aiConversations.userId })
          .from(aiConversations)
          .where(eq(aiConversations.id, row.requestedVia))
          .get()
      : undefined;
  const ownChat = viewerId !== null && row.requestedById === viewerId;
  const clientName = key?.name ?? (row.sourceLabel || "MCP client");
  const source =
    row.requestedByType === "ai"
      ? {
          kind: "assistant" as const,
          conversationId: row.requestedVia ?? row.id,
          title: ownChat ? (chat?.title ?? row.sourceLabel) : "",
          mine: ownChat && chat?.userId === viewerId,
        }
      : { kind: "mcp" as const, keyId: row.requestedVia, clientName };
  let target = null;
  if (row.targetType && row.targetId) {
    const table = row.targetType === "project" ? projects : services;
    const found = db.select({ name: table.name }).from(table).where(eq(table.id, row.targetId)).get();
    target = { type: row.targetType, id: row.targetId, name: found?.name ?? "" };
  }
  return {
    id: row.id,
    opId: row.opId,
    opSummary: op?.summary ?? row.opId,
    opKind: op?.kind === "destructive" ? ("destructive" as const) : ("mutation" as const),
    inputPreview: row.inputPreview,
    via: row.requestedByType === "ai" ? ("ai" as const) : ("mcp" as const),
    source,
    requestedBy: {
      userId: row.requestedById,
      userName: requester ? requester.name || requester.email : "",
      clientName: row.requestedByType === "ai" ? "AI assistant" : clientName,
    },
    reason: row.reason,
    target,
    status: row.status,
    decidedBy: decider ? { id: decider.id, name: decider.name || decider.email } : null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    error: row.error,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
