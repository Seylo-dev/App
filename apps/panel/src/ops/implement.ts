// implement() attaches the code that runs an op to its contract from
// @seylo/ops. Handlers get validated input and an OpContext; they throw
// OpError for expected failures and let anything else become INTERNAL.

import { type AnyOpContract, type approvals, OpError, type OpInput, type OpOutput } from "@seylo/ops";
import type { Access } from "../auth/access";
import type { Principal, PrincipalUser } from "../auth/principal";
import type { PanelDb } from "../db/client";
import type { Deps } from "../deps";

/** Response side effects that only make sense over HTTP (the browser session). */
export interface HttpEffects {
  /**
   * Hands the browser a session: the token as the HttpOnly session cookie
   * (`__Host-` on HTTPS) and the key in the session key response header,
   * which the web app keeps in its origin's storage (auth/sessions.ts).
   */
  setSession(session: { token: string; key: string; maxAgeSeconds: number }): void;
  /** Expires the session cookie and tells the web app to forget its key. */
  clearSession(): void;
}

/** The listener a call came in on, when it is not the main one. added in 0.2.1 */
export type OpVia = "tailnet";

/** Longest viaLogin kept: tailnet logins are email-like. */
export const maxViaLoginLength = 256;

export interface OpContext extends Deps {
  principal: Principal;
  access: Access;
  /** Present for HTTP calls; null for MCP and AI tool calls. */
  http: HttpEffects | null;
  ip: string | null;
  userAgent: string | null;
  /** "https://panel.example.com" as the caller reached the panel; null when unknown (MCP, AI, tests). */
  origin?: string | null;
  /**
   * How the call arrived: "http" (web app, API key, CLI), "mcp" (an MCP
   * host) or "ai" (the panel's assistant, acting as its user). Optional so
   * contexts built by hand (jobs, tests) default to "http".
   */
  transport?: "http" | "mcp" | "ai";
  /**
   * "tailnet" when the call came in on the panel's tailnet listener
   * (Tailscale Serve to the unix socket); null or absent otherwise. A
   * private path's proof for settings.updatePanelAccess. added in 0.2.1
   */
  via?: OpVia | null;
  /**
   * The tailnet login Serve named for the caller (its Tailscale-User-Login
   * header), at most 256 characters; null when Serve sent none (a tagged
   * device, HTTP mode). Recorded in audit rows only: it never signs anyone
   * in and grants nothing. added in 0.2.1
   */
  viaLogin?: string | null;
  /**
   * For public sign-in ops: record this person as the actor of the audit
   * entry (the caller was anonymous until now, or tried their password).
   */
  auditAs?(user: PrincipalUser): void;
  /** Extra fields for this call's audit entry (merged into the audited input; never secrets). */
  auditDetails?(details: Record<string, unknown>): void;
}

export interface OpHandler<C extends AnyOpContract = AnyOpContract> {
  contract: C;
  run(input: OpInput<C>, ctx: OpContext): Promise<OpOutput<C>> | OpOutput<C>;
  /**
   * A permission check beyond op.permission that needs the resource (a
   * database service's logins, say); throws OpError (FORBIDDEN). The
   * pipeline runs it for every caller right after op.permission, before a
   * model's call waits for approval, and the approvals module runs it for
   * the requester when a call is queued and again when it is approved
   * (OpRunner.authorize): an approver who may do more never lends that to
   * the requester. Set with implement()'s options.
   */
  guard?(input: OpInput<C>, check: { db: PanelDb; access: Access }): void;
  /**
   * For a contract with modelApproval "conditional" (and only there,
   * collectHandlers checks both ways): whether this call waits for a
   * person's approval when a model makes it, from the input and the
   * resource as it is now (databases.setExposure: true when it lets
   * clients in without TLS). The pipeline asks it only for a model's call
   * without an approval, after the permission check and the guard; a
   * person's own call never runs it. Set with implement()'s options.
   */
  modelApproval?(input: OpInput<C>, check: { db: PanelDb; access: Access }): boolean;
  /**
   * The refusals the handler would make anyway that need no change made
   * (the resource's state, the node's agent, input it cannot take), run
   * before a model's call is held for a person: by the pipeline before it
   * answers APPROVAL_REQUIRED, and by the AI assistant before it queues a
   * change (OpRunner.precheck). Throws the handler's OpError, so the model
   * hears it at once instead of an approval that fails once approved.
   * Read only: the handler still makes every check itself. Set with
   * implement()'s options. added in 0.2.17
   */
  precheck?(input: OpInput<C>, check: { db: PanelDb; agents: Deps["agents"] }): void;
  /**
   * What approving a pending call of this op weakens, for the Approvals
   * page and the assistant's card (Approval.warning), from its input and
   * the resource as it is now; null for an ordinary change. Set with
   * implement()'s options. added in 0.2.17
   */
  approvalWarning?(input: OpInput<C>, check: { db: PanelDb }): approvals.ApprovalWarning | null;
}

export function implement<C extends AnyOpContract>(
  contract: C,
  run: OpHandler<C>["run"],
  options: Pick<OpHandler<C>, "guard" | "modelApproval" | "precheck" | "approvalWarning"> = {},
): OpHandler<C> {
  return {
    contract,
    run,
    ...(options.guard ? { guard: options.guard } : {}),
    ...(options.modelApproval ? { modelApproval: options.modelApproval } : {}),
    ...(options.precheck ? { precheck: options.precheck } : {}),
    ...(options.approvalWarning ? { approvalWarning: options.approvalWarning } : {}),
  };
}

/**
 * A handler for a contract whose code is not written yet: every call fails
 * with NOT_IMPLEMENTED (501), so the op is routed, documented and permission
 * checked while the feature is still missing. Swap it for implement() later.
 */
export function notImplemented<C extends AnyOpContract>(contract: C): OpHandler<C> {
  return implement(contract, () => {
    throw new OpError("NOT_IMPLEMENTED", `${contract.id} is not implemented yet.`);
  });
}
