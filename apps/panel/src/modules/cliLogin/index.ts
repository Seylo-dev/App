// Laptop CLI sign-in by browser approval. start hands the CLI a user code and
// a secret device code; a person signed in to the panel approves the code on
// /cli/approve and picks the scope; the CLI's next poll creates an API key of
// that person and returns it once. Nothing is created before the approval,
// and the key itself is never stored in clear (the row keeps the scope only).
// Contracts: packages/ops/src/ops/cliLogin.ts.

import { cliLogin as cliOps, OpError } from "@seylo/ops";
import { and, eq, lt } from "drizzle-orm";
import { requireFreshSignIn } from "../../auth/fresh";
import { requireSession } from "../../auth/sign-in";
import type { PanelDb } from "../../db/client";
import { cliLoginRequests, users } from "../../db/schema";
import { implement } from "../../ops/implement";
import { createRateLimiter, type RateLimiter } from "../../ops/rate-limit";
import { hashToken, prefixedToken } from "../../security/tokens";
import { raiseSecurityChange } from "../alerts/security";
import { checkActions, checkProjects, insertApiKey } from "../apiKeys";
import { defineModule } from "../module";

const startLimiters = new WeakMap<object, RateLimiter>();

type RequestRow = typeof cliLoginRequests.$inferSelect;

export const requestTtlMs = 10 * 60 * 1000;
export const pollIntervalSeconds = 2;
const dayMs = 24 * 60 * 60 * 1000;
/** Like the approval page, which starts at 7 days. */
const defaultKeyDays = 7;
/** Polling faster than this gets the same answer without a database write. */
const minPollGapMs = 1000;

// No 0/O, 1/I/L: people type it from one screen into another.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newUserCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  // Rejection sampling keeps every letter equally likely.
  const out: string[] = [];
  while (out.length < 8) {
    for (const byte of random(16)) {
      if (byte >= 248) continue; // 248 = 8 * 31
      out.push(codeAlphabet[byte % codeAlphabet.length] as string);
      if (out.length === 8) break;
    }
  }
  return out.join("");
}

const display = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const stored = (code: string) => code.replace("-", "").toUpperCase();

function stateOf(row: RequestRow, now: Date): "pending" | "approved" | "denied" | "expired" | "used" {
  if (row.state === "used" || row.state === "denied") return row.state;
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return row.state;
}

function findByCode(db: PanelDb, userCode: string): RequestRow {
  const row = db
    .select()
    .from(cliLoginRequests)
    .where(eq(cliLoginRequests.userCode, stored(userCode)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "No sign-in request has that code. Run the login command again.");
  return row;
}

const start = implement(cliOps.start, (input, ctx) => {
  // Public: the per-address strict limit applies; a computer name cannot be used in a loop either.
  const clientName = input.clientName.trim().slice(0, 100);
  let limiter = startLimiters.get(ctx.db);
  if (!limiter) {
    limiter = createRateLimiter();
    startLimiters.set(ctx.db, limiter);
  }
  const wait = limiter.take(`cli-name:${clientName.toLowerCase()}`, "strict");
  if (wait > 0)
    throw new OpError("RATE_LIMITED", `Too many sign-ins for this computer. Try again in ${wait} seconds.`, { retryAfter: String(wait) });
  const now = new Date();
  // Dead requests are swept here: one cheap delete, no schedule needed.
  ctx.db
    .delete(cliLoginRequests)
    .where(lt(cliLoginRequests.expiresAt, new Date(now.getTime() - requestTtlMs)))
    .run();
  const deviceCode = prefixedToken("key").replace("_key_", "_cli_");
  const expiresAt = new Date(now.getTime() + requestTtlMs);
  let userCode = newUserCode();
  for (let i = 0; i < 5 && ctx.db.select().from(cliLoginRequests).where(eq(cliLoginRequests.userCode, userCode)).get(); i++) {
    userCode = newUserCode();
  }
  ctx.db
    .insert(cliLoginRequests)
    .values({
      userCode,
      deviceCodeHash: hashToken(deviceCode),
      clientName,
      requestedFrom: ctx.ip,
      expiresAt,
      createdAt: now,
    })
    .run();
  const path = `/cli/approve?code=${display(userCode)}`;
  return {
    userCode: display(userCode),
    deviceCode,
    verificationUrl: ctx.origin ? `${ctx.origin}${path}` : path,
    intervalSeconds: pollIntervalSeconds,
    expiresAt: expiresAt.toISOString(),
  };
});

const get = implement(cliOps.get, (input, ctx) => {
  requireSession(ctx);
  const row = findByCode(ctx.db, input.userCode);
  return {
    request: {
      userCode: display(row.userCode),
      clientName: row.clientName,
      requestedFrom: row.requestedFrom,
      status: stateOf(row, new Date()),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    },
    viewerAddress: ctx.ip,
  };
});

const approve = implement(cliOps.approve, (input, ctx) => {
  // Only a browser session approves, so a leaked key can never mint another one, and only
  // right after a sign-in or a re-auth, since the approval mints a key acting as this person.
  const { userId, user } = requireFreshSignIn(ctx);
  const row = findByCode(ctx.db, input.userCode);
  const state = stateOf(row, new Date());
  if (state === "expired")
    throw new OpError("CONFLICT", "This sign-in request expired. Run the login command again.", { reason: "expired" });
  if (state !== "pending") throw new OpError("CONFLICT", "This sign-in request was already answered.", { reason: state });
  const actions = checkActions(input.actions ?? ["*"]);
  const projectIds = checkProjects(ctx.db, input.projectIds);
  const expiresInDays = input.expiresInDays ?? defaultKeyDays;
  const updated = ctx.db
    .update(cliLoginRequests)
    .set({ state: "approved", approvedBy: userId, scope: { actions, projectIds, readOnly: input.readOnly ?? false, expiresInDays } })
    .where(and(eq(cliLoginRequests.id, row.id), eq(cliLoginRequests.state, "pending")))
    .returning({ id: cliLoginRequests.id })
    .get();
  if (!updated) throw new OpError("CONFLICT", "This sign-in request was already answered.");
  // The audit entry names the computer and where it asked from, next to the chosen scope.
  ctx.auditDetails?.({ clientName: row.clientName, requestedFrom: row.requestedFrom });
  // It mints a key acting as this person, so the owner hears about every approval.
  const scope = `${input.readOnly ? "read only" : "full access"}, ${projectIds ? `${projectIds.length} project(s)` : "every project"}`;
  raiseSecurityChange(
    ctx,
    user,
    `approved a CLI sign-in for ${row.clientName}`,
    `Requested from ${row.requestedFrom ?? "an unknown address"}; the key is ${scope} and valid ${expiresInDays} days.`,
  );
  // The key itself is created by the CLI's next poll, with this lifetime.
  return { expiresInDays };
});

const deny = implement(cliOps.deny, (input, ctx) => {
  requireSession(ctx);
  const row = findByCode(ctx.db, input.userCode);
  if (stateOf(row, new Date()) !== "pending") throw new OpError("CONFLICT", "This sign-in request was already answered.");
  ctx.db
    .update(cliLoginRequests)
    .set({ state: "denied" })
    .where(and(eq(cliLoginRequests.id, row.id), eq(cliLoginRequests.state, "pending")))
    .run();
  return {};
});

const poll = implement(cliOps.poll, (input, ctx) => {
  const now = new Date();
  const row = ctx.db
    .select()
    .from(cliLoginRequests)
    .where(eq(cliLoginRequests.deviceCodeHash, hashToken(input.deviceCode)))
    .get();
  if (!row) throw new OpError("NOT_FOUND", "Unknown sign-in request. Run the login command again.");
  const state = stateOf(row, now);
  if (state !== "approved") {
    if (state === "pending" && (!row.lastPolledAt || now.getTime() - row.lastPolledAt.getTime() >= minPollGapMs)) {
      ctx.db.update(cliLoginRequests).set({ lastPolledAt: now }).where(eq(cliLoginRequests.id, row.id)).run();
    }
    return { status: state, intervalSeconds: pollIntervalSeconds };
  }
  const scope = row.scope;
  const approver = row.approvedBy ? ctx.db.select().from(users).where(eq(users.id, row.approvedBy)).get() : undefined;
  if (!scope || !approver || approver.disabledAt) {
    ctx.db.update(cliLoginRequests).set({ state: "denied" }).where(eq(cliLoginRequests.id, row.id)).run();
    return { status: "denied" as const, intervalSeconds: pollIntervalSeconds };
  }
  // Claim the request first so two polls racing never both get a key.
  const claimed = ctx.db
    .update(cliLoginRequests)
    .set({ state: "used", lastPolledAt: now })
    .where(and(eq(cliLoginRequests.id, row.id), eq(cliLoginRequests.state, "approved")))
    .returning({ id: cliLoginRequests.id })
    .get();
  if (!claimed) return { status: "used" as const, intervalSeconds: pollIntervalSeconds };
  const name = `CLI on ${row.clientName}`.slice(0, 60);
  const { row: key, token } = insertApiKey(
    ctx.db,
    {
      userId: approver.id,
      kind: "api",
      name,
      actions: scope.actions,
      projectIds: scope.projectIds,
      readOnly: scope.readOnly,
      expiresAt: new Date(now.getTime() + scope.expiresInDays * dayMs),
    },
    now,
  );
  ctx.db.update(cliLoginRequests).set({ keyId: key.id }).where(eq(cliLoginRequests.id, row.id)).run();
  ctx.auditAs?.({ id: approver.id, email: approver.email, name: approver.name, role: approver.role });
  return {
    status: "approved" as const,
    key: { id: key.id, token, name: key.name, expiresAt: (key.expiresAt as Date).toISOString(), email: approver.email },
    intervalSeconds: pollIntervalSeconds,
  };
});

export default defineModule({
  name: "cliLogin",
  ops: [start, get, approve, deny, poll],
});
