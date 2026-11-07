// Runs one op call through the fixed pipeline every transport shares
// (HTTP today; MCP and the AI assistant call the same function):
//
//   authenticate -> validate input -> check permission -> approval
//     -> rate limit -> run -> check output -> audit
//
// Calls a model made (MCP and AI transports, or any MCP token) only reach
// ops marked mcp: true, and destructive ones need a person's approval.
//
// Input is validated before the permission check because project and
// service permissions read the resource id from the input. Anonymous
// callers are refused before validation, so they learn nothing about
// schemas.

import { type AnyOpContract, OpError } from "@seylo/ops";
import { type Access, createAccess, type Target, targetOf } from "../auth/access";
import { authenticate, type Credentials } from "../auth/authenticate";
import { describePrincipal, type Principal, type PrincipalUser } from "../auth/principal";
import type { Deps } from "../deps";
import { addressKey } from "../http/ip-ranges";
import { anonymousErrorRows, firstOverCapThisHour, takeAnonymousErrorRow, targetLabel, targetProject, writeAudit } from "./audit";
import type { HttpEffects, OpContext, OpHandler } from "./implement";
import type { RateLimiter } from "./rate-limit";
import { checkOutput, parseInput } from "./validate";

export interface OpCall {
  op: AnyOpContract;
  rawInput: unknown;
  credentials: Credentials;
  transport: "http" | "mcp" | "ai";
  /** Query-string input arrives as strings and is coerced to the schema's types. */
  coerce: boolean;
  ip: string | null;
  userAgent: string | null;
  http: HttpEffects | null;
  /** "https://panel.example.com" as the caller reached the panel, for links in outputs; null when unknown. */
  origin?: string | null;
  /**
   * Set only by the approvals module when it replays a call a person
   * approved; never taken from request input. Destructive ops from models
   * (MCP and AI transports, or any MCP token) refuse to run without it.
   */
  approvalId?: string | null;
  /**
   * Run as this principal instead of authenticating credentials. Only
   * internal callers set it (the AI assistant and approvals act for a
   * person without holding their credentials); never from request input.
   */
  principal?: Principal;
}

export type OpOutcome = { ok: true; output: unknown } | { ok: false; error: OpError };

export type ExecuteOp = (call: OpCall) => Promise<OpOutcome>;

export function createOpExecutor(deps: Deps, handlers: ReadonlyMap<string, OpHandler>, limiter: RateLimiter): ExecuteOp {
  return async (call) => {
    const { op } = call;
    const started = performance.now();
    const principal = call.principal ?? authenticate(deps.db, call.credentials);
    const access = createAccess(deps.db, principal);
    let input: unknown;
    let target: Target | undefined;
    let label: string | null = null;
    let projectId: string | null = null;
    const actor: { user?: PrincipalUser; details?: Record<string, unknown> } = {};
    const audited = () => (actor.details && input && typeof input === "object" ? { ...(input as object), ...actor.details } : input);

    try {
      const handler = handlers.get(op.id);
      if (!handler) throw new OpError("NOT_IMPLEMENTED", `${op.id} is not implemented yet.`);
      if (op.permission.kind !== "public" && principal.type === "anonymous") {
        throw new OpError("UNAUTHENTICATED", "Sign in or use a valid API key.");
      }

      if (!op.mcp && fromModel(call, principal)) {
        throw new OpError("FORBIDDEN", "This action is not available to AI tools or MCP tokens.");
      }

      input = parseInput(op.input, call.rawInput, call.coerce);
      // Known before the check, so refused attempts are logged against
      // their target too; the name is read only once the caller may see it.
      target = targetOf(op.permission, input);
      if (target && op.audit) projectId = targetProject(deps.db, target);
      access.require(op.permission, op.kind, input);
      // Read the name now: after a delete it would be gone.
      if (target && op.audit) label = targetLabel(deps.db, target);
      if (op.kind === "destructive" && fromModel(call, principal) && !call.approvalId) {
        throw new OpError("APPROVAL_REQUIRED", "A person has to approve this action first.");
      }

      const waitSeconds = limiter.take(rateLimitKey(principal, call.ip), op.rateLimit ?? "standard");
      if (waitSeconds > 0) {
        throw new OpError("RATE_LIMITED", `Too many requests. Try again in ${waitSeconds} seconds.`, { retryAfter: String(waitSeconds) });
      }

      const ctx = buildContext(deps, call, principal, access, actor);
      // parseInput validated `input` against this op's schema; the handler
      // map erases each handler's input type, hence the cast.
      const checked = checkOutput(op.output, await handler.run(input as never, ctx));
      if (!checked.ok) {
        deps.logger.error({ opId: op.id, reason: checked.reason }, "op returned output that does not match its schema");
        throw new OpError("INTERNAL", "Something went wrong. The panel log has the details.");
      }

      audit(deps, call, principal, actor.user, audited(), { target, label, projectId }, undefined, started);
      return { ok: true, output: checked.value };
    } catch (thrown) {
      const error = toOpError(thrown, deps, op);
      logRefusal(deps, call, principal, actor.user, error);
      audit(deps, call, principal, actor.user, audited(), { target, label, projectId }, error.code, started);
      return { ok: false, error };
    }
  };
}

/** Calls a model made: MCP and AI transports, and MCP tokens on any transport. */
function fromModel(call: OpCall, principal: Principal): boolean {
  return call.transport !== "http" || (principal.type === "apiKey" && principal.keyKind === "mcp");
}

function buildContext(
  deps: Deps,
  call: OpCall,
  principal: Principal,
  access: Access,
  actor: { user?: PrincipalUser; details?: Record<string, unknown> },
): OpContext {
  return {
    ...deps,
    principal,
    access,
    http: call.http,
    ip: call.ip,
    userAgent: call.userAgent,
    origin: call.origin ?? null,
    transport: call.transport,
    auditDetails: (details) => {
      actor.details = { ...actor.details, ...details };
    },
    auditAs: (user) => {
      // Only anonymous callers get a stand-in; a signed-in caller stays the actor.
      if (principal.type === "anonymous") actor.user = user;
    },
  };
}

/** Signed-in callers are limited per person or key; anonymous ones per address (an IPv6 /64 counts as one). */
function rateLimitKey(principal: Principal, ip: string | null): string {
  switch (principal.type) {
    case "anonymous":
      return `ip:${addressKey(ip)}`;
    case "session":
      return `user:${principal.user.id}`;
    case "apiKey":
      return `key:${principal.keyId}`;
  }
}

/**
 * Audits audited ops. Anonymous calls are only recorded for public ops
 * (sign-in attempts), so a flood of unauthenticated requests cannot fill
 * the log.
 */
function audit(
  deps: Deps,
  call: OpCall,
  principal: Principal,
  actor: PrincipalUser | undefined,
  input: unknown,
  where: { target: Target | undefined; label: string | null; projectId: string | null },
  errorCode: string | undefined,
  started: number,
) {
  if (!call.op.audit) return;
  if (principal.type === "anonymous" && call.op.permission.kind !== "public") return;
  // Failed anonymous attempts (sign-ins from rotating addresses) are capped per hour.
  if (principal.type === "anonymous" && errorCode && !takeAnonymousErrorRow(deps.db)) {
    if (firstOverCapThisHour(deps.db)) {
      deps.logger.warn(
        { opId: call.op.id, perHour: anonymousErrorRows.perHour },
        "audit: anonymous failures over the hourly cap are not stored",
      );
    }
    return;
  }
  try {
    writeAudit(deps.db, {
      op: call.op,
      principal,
      actor,
      transport: call.transport,
      input,
      target: where.target,
      targetLabel: where.label,
      projectId: where.projectId,
      errorCode,
      durationMs: performance.now() - started,
      ip: call.ip,
      userAgent: call.userAgent,
      approvalId: call.approvalId ?? null,
      at: new Date(),
    });
  } catch (error) {
    // A failed audit write must be visible but must not turn a completed
    // change into an error the caller would retry.
    deps.logger.error({ err: error, opId: call.op.id }, "writing the audit log failed");
  }
}

/**
 * One warning in the process log per refusal that matters for security:
 * a failed sign-in (UNAUTHENTICATED from a public op: a wrong password or
 * code), a refused permission or re-auth (FORBIDDEN), a lock or limit
 * (RATE_LIMITED). The audit table has the details; these lines are for
 * `docker logs`, fail2ban and alerting. Never secrets: the op id, the
 * address, the person (when known) and the panel's own safe message.
 */
function logRefusal(deps: Deps, call: OpCall, principal: Principal, standIn: PrincipalUser | undefined, error: OpError): void {
  const signIn = error.code === "UNAUTHENTICATED" && call.op.permission.kind === "public";
  if (!signIn && error.code !== "FORBIDDEN" && error.code !== "RATE_LIMITED") return;
  const actor = principal.type === "anonymous" ? (standIn?.email ?? null) : describePrincipal(principal);
  const fields = {
    opId: call.op.id,
    ip: call.ip,
    actor,
    transport: call.transport,
    code: error.code,
    ...(error.details?.reason ? { reason: error.details.reason } : {}),
  };
  const what = signIn ? "sign-in failed" : error.code === "FORBIDDEN" ? "op refused" : "op rate limited";
  deps.logger.warn(fields, `${what}: ${error.message}`);
}

function toOpError(thrown: unknown, deps: Deps, op: AnyOpContract): OpError {
  if (thrown instanceof OpError) return thrown;
  deps.logger.error({ err: thrown, opId: op.id }, "op failed");
  return new OpError("INTERNAL", "Something went wrong. The panel log has the details.");
}
