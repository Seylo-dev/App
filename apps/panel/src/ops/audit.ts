// Writes one audit_log row per audited op call. Inputs are redacted with
// the op's sensitive paths before they are stored.

import { type AnyOpContract, redact } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { Target } from "../auth/access";
import { describePrincipal, type Principal, type PrincipalUser } from "../auth/principal";
import type { PanelDb } from "../db/client";
import { type ActorType, auditLog, projects, services } from "../db/schema";

export interface AuditEntry {
  op: AnyOpContract;
  principal: Principal;
  /** Who an anonymous call acted for (a sign-in), set by the handler through ctx.auditAs. */
  actor?: PrincipalUser;
  transport: "http" | "mcp" | "ai";
  /** Validated input, or undefined when validation failed (raw input is not stored). */
  input: unknown;
  target: Target | undefined;
  /** The target's name at the time, read before the op ran. */
  targetLabel?: string | null;
  /** The target's project, read before the op ran. */
  projectId?: string | null;
  errorCode: string | undefined;
  durationMs: number;
  ip: string | null;
  userAgent: string | null;
  approvalId: string | null;
  at: Date;
}

export function writeAudit(db: PanelDb, entry: AuditEntry): void {
  const { principal } = entry;
  const standIn = principal.type === "anonymous" ? entry.actor : undefined;
  db.insert(auditLog)
    .values({
      at: entry.at,
      actorType: standIn ? "user" : actorType(principal, entry.transport),
      actorId: standIn?.id ?? (principal.type === "anonymous" ? null : principal.user.id),
      credentialId: principal.type === "apiKey" ? principal.keyId : principal.type === "session" ? principal.sessionId : null,
      actorLabel: standIn?.email ?? describePrincipal(principal),
      opId: entry.op.id,
      targetType: entry.target?.type ?? null,
      targetId: entry.target?.id ?? null,
      targetLabel: entry.targetLabel ?? null,
      projectId: entry.projectId ?? null,
      transport: entry.transport,
      input: entry.input === undefined ? {} : redact(entry.input, entry.op.sensitive?.input),
      outcome: entry.errorCode ? "error" : "ok",
      errorCode: entry.errorCode ?? null,
      durationMs: Math.round(entry.durationMs),
      ip: entry.ip,
      userAgent: entry.userAgent,
      approvalId: entry.approvalId,
    })
    .run();
}

/**
 * Audit entries for things that are not ops but change who can act on the
 * panel, such as MCP OAuth client registration and consent (HTTP endpoints
 * whose shape the OAuth spec defines), or that end outside an op, such as a
 * host shell closing ("hostShell.close"). `eventId` reads like an op id
 * ("mcp.registerClient") and never collides with one. `input` must hold no
 * secrets: it is stored as given.
 */
export function writeAuditEvent(
  db: PanelDb,
  entry: {
    eventId: string;
    principal: Principal;
    input: Record<string, unknown>;
    errorCode?: string;
    target?: Target;
    targetLabel?: string | null;
    ip: string | null;
    userAgent: string | null;
    at?: Date;
    /** How long the thing took (a host shell's open time). */
    durationMs?: number;
  },
): void {
  const { principal } = entry;
  db.insert(auditLog)
    .values({
      at: entry.at ?? new Date(),
      actorType: actorType(principal, "http"),
      actorId: principal.type === "anonymous" ? null : principal.user.id,
      credentialId: principal.type === "apiKey" ? principal.keyId : principal.type === "session" ? principal.sessionId : null,
      actorLabel: describePrincipal(principal),
      opId: entry.eventId,
      targetType: entry.target?.type ?? null,
      targetId: entry.target?.id ?? null,
      targetLabel: entry.targetLabel ?? null,
      projectId: null,
      transport: "http",
      input: entry.input,
      outcome: entry.errorCode ? "error" : "ok",
      errorCode: entry.errorCode ?? null,
      durationMs: Math.round(entry.durationMs ?? 0),
      ip: entry.ip,
      userAgent: entry.userAgent,
      approvalId: null,
    })
    .run();
}

function actorType(principal: Principal, transport: AuditEntry["transport"]): ActorType {
  if (transport === "ai") return "ai";
  switch (principal.type) {
    case "anonymous":
      return "anonymous";
    case "session":
      return "user";
    case "apiKey":
      return principal.keyKind === "mcp" ? "mcp" : "apiKey";
  }
}

/** The current name of a project or service, for the audit log; null when it does not exist. */
export function targetLabel(db: PanelDb, target: Target): string | null {
  const table = target.type === "project" ? projects : services;
  return db.select({ name: table.name }).from(table).where(eq(table.id, target.id)).get()?.name ?? null;
}

/** The project a target belongs to; null for a service that does not exist. */
export function targetProject(db: PanelDb, target: Target): string | null {
  if (target.type === "project") return target.id;
  return db.select({ projectId: services.projectId }).from(services).where(eq(services.id, target.id)).get()?.projectId ?? null;
}
