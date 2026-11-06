// implement() attaches the code that runs an op to its contract from
// @seylo/ops. Handlers get validated input and an OpContext; they throw
// OpError for expected failures and let anything else become INTERNAL.

import { type AnyOpContract, OpError, type OpInput, type OpOutput } from "@seylo/ops";
import type { Access } from "../auth/access";
import type { Principal, PrincipalUser } from "../auth/principal";
import type { Deps } from "../deps";

export interface CookieOptions {
  maxAgeSeconds?: number;
}

/** Response side effects that only make sense over HTTP (sign-in cookies). */
export interface HttpEffects {
  setCookie(name: string, value: string, options?: CookieOptions): void;
  clearCookie(name: string): void;
}

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
}

export function implement<C extends AnyOpContract>(contract: C, run: OpHandler<C>["run"]): OpHandler<C> {
  return { contract, run };
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
