// Invites with project and service grants, and accepting them.
// Contracts: packages/ops/src/ops/invites.ts.

import { displayName } from "@seylo/brand";
import { invites as inviteOps, OpError } from "@seylo/ops";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireFreshIfSession } from "../../auth/fresh";
import { githubAvailable } from "../../auth/github-device";
import { finishSignIn, toViewer } from "../../auth/sign-in";
import type { PanelDb } from "../../db/client";
import { grants, type InviteGrant, invites, users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { hashPassword } from "../../security/password";
import { hashToken, prefixedToken } from "../../security/tokens";
import { getSetting } from "../../settings";
import { checkGrantActions, requireScope } from "../grants/rows";
import { defineModule } from "../module";
import { type InviteRow, inviteGrants, inviteLink, inviterLabel, inviteStatus, toInvites } from "./rows";

const dayMs = 24 * 60 * 60 * 1000;

/** Sends the link through the panel's SMTP channel; false when there is none or it failed (the link is still shown). */
async function emailInvite(ctx: OpContext, to: string, link: string, inviter: string): Promise<boolean> {
  const panel = getSetting(ctx.db, "panelName") || displayName;
  const result = await ctx.notify.sendEmail({
    to,
    subject: `${inviter} invited you to ${panel}`,
    text: `${inviter} invited you to ${panel}.\n\nOpen this link to accept (it works once):\n${link}\n`,
  });
  return result === "sent";
}

const create = implement(inviteOps.create, async (input, ctx) => {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  const actor = ctx.principal.user;
  const email = input.email.trim().toLowerCase();
  if (input.role === "admin" && input.grants.length > 0) {
    throw new OpError("BAD_REQUEST", "Admins can do everything; invite them without grants.", { field: "grants" });
  }
  const existing = ctx.db.select({ role: users.role }).from(users).where(eq(users.email, email)).get();
  if (existing && existing.role !== "member") throw new OpError("CONFLICT", "This person is already an owner or admin.");
  if (existing && input.role === "member" && input.grants.length === 0) {
    throw new OpError("BAD_REQUEST", "This person already has an account. Choose projects or services to share with them.", {
      field: "grants",
    });
  }

  const checked: InviteGrant[] = input.grants.map((g) => {
    requireScope(ctx.db, g.scopeType, g.scopeId);
    return { scopeType: g.scopeType, scopeId: g.scopeId, actions: checkGrantActions(ctx.access, g.scopeType, g.scopeId, g.actions) };
  });
  // An admin invite is a full account for whoever holds the link: a session
  // left open must not mint one.
  if (input.role === "admin") requireFreshIfSession(ctx);

  const token = prefixedToken("invite");
  const now = new Date();
  const row = ctx.db.transaction((tx) => {
    // A new invite for the same email replaces the pending one.
    tx.update(invites)
      .set({ revokedAt: now })
      .where(and(eq(invites.email, email), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
      .run();
    return tx
      .insert(invites)
      .values({
        email,
        role: input.role,
        grants: checked,
        tokenHash: hashToken(token),
        invitedBy: actor.id,
        expiresAt: new Date(now.getTime() + input.expiresInDays * dayMs),
        createdAt: now,
      })
      .returning()
      .get();
  });
  const link = inviteLink(ctx, token);
  const emailed = input.sendEmail ? await emailInvite(ctx, email, link, actor.name || actor.email) : false;
  ctx.live.publish("panel", { type: "invalidate", ops: ["invites.list"] });
  return { invite: toInvites(ctx.db, [row])[0] as ReturnType<typeof toInvites>[number], link, emailed };
});

const list = implement(inviteOps.list, (input, ctx) => {
  const now = new Date();
  const rows = ctx.db.select().from(invites).orderBy(desc(invites.createdAt)).all();
  const shown = input.status ? rows.filter((r) => inviteStatus(r, now) === input.status) : rows;
  const pendingFirst = input.status
    ? shown
    : [...shown.filter((r) => inviteStatus(r, now) === "pending"), ...shown.filter((r) => inviteStatus(r, now) !== "pending")];
  return { invites: toInvites(ctx.db, pendingFirst, now) };
});

const revoke = implement(inviteOps.revoke, (input, ctx) => {
  const row = ctx.db.select().from(invites).where(eq(invites.id, input.inviteId)).get();
  if (!row) throw new OpError("NOT_FOUND", "That invite does not exist.");
  const status = inviteStatus(row);
  if (status === "accepted") throw new OpError("CONFLICT", "This invite was already accepted. Remove the person or their grants instead.");
  const updated =
    status === "pending"
      ? (ctx.db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, row.id)).returning().get() ?? row)
      : row;
  ctx.live.publish("panel", { type: "invalidate", ops: ["invites.list"] });
  return toInvites(ctx.db, [updated])[0] as ReturnType<typeof toInvites>[number];
});

function findInvite(db: PanelDb, token: string): InviteRow | undefined {
  return db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashToken(token)))
    .get();
}

const preview = implement(inviteOps.preview, (input, ctx) => {
  const row = findInvite(ctx.db, input.token);
  const available = githubAvailable(ctx);
  if (!row || inviteStatus(row) !== "pending") {
    return {
      valid: false,
      email: null,
      role: null,
      invitedBy: null,
      grants: [],
      accountExists: false,
      expiresAt: null,
      githubAvailable: available,
    };
  }
  return {
    valid: true,
    email: row.email,
    role: row.role,
    invitedBy: inviterLabel(ctx.db, row),
    grants: inviteGrants(ctx.db, row),
    accountExists: ctx.db.select({ id: users.id }).from(users).where(eq(users.email, row.email)).get() !== undefined,
    expiresAt: row.expiresAt.toISOString(),
    githubAvailable: available,
  };
});

/** Adds the invite's grants to an account (merging with grants it already has) and marks the invite used. */
function applyInvite(db: PanelDb, row: InviteRow, userId: string, role: "owner" | "admin" | "member") {
  db.transaction((tx) => {
    const fresh = tx.select().from(invites).where(eq(invites.id, row.id)).get();
    if (!fresh || inviteStatus(fresh) !== "pending") throw new OpError("CONFLICT", "This invite was just used or revoked.");
    if (row.role === "admin" && role === "member") tx.update(users).set({ role: "admin" }).where(eq(users.id, userId)).run();
    if (row.role === "member" && role === "member") {
      for (const g of row.grants) {
        try {
          requireScope(tx as unknown as PanelDb, g.scopeType, g.scopeId);
        } catch {
          continue; // deleted since the invite was sent
        }
        const current = tx
          .select()
          .from(grants)
          .where(and(eq(grants.userId, userId), eq(grants.scopeType, g.scopeType), eq(grants.scopeId, g.scopeId)))
          .get();
        const actions = [...new Set([...(current?.actions ?? []), ...g.actions])];
        tx.insert(grants)
          .values({ userId, scopeType: g.scopeType, scopeId: g.scopeId, actions, createdBy: row.invitedBy })
          .onConflictDoUpdate({ target: [grants.userId, grants.scopeType, grants.scopeId], set: { actions, updatedAt: new Date() } })
          .run();
      }
    }
    tx.update(invites).set({ acceptedAt: new Date(), acceptedBy: userId }).where(eq(invites.id, row.id)).run();
  });
}

const accept = implement(inviteOps.accept, async (input, ctx) => {
  const row = findInvite(ctx.db, input.token);
  if (!row || inviteStatus(row) !== "pending") {
    throw new OpError("FORBIDDEN", "This invite link was used, revoked or has expired. Ask for a new one.");
  }

  if (ctx.principal.type === "apiKey") throw new OpError("BAD_REQUEST", "Accept invites in the browser, not with an API key.");
  if (ctx.principal.type === "session") {
    const me = ctx.principal.user;
    if (me.email !== row.email) {
      throw new OpError("FORBIDDEN", `This invite is for ${row.email}. Sign out and sign in with that account.`, { email: row.email });
    }
    applyInvite(ctx.db, row, me.id, me.role);
    ctx.live.publish("panel", { type: "invalidate", ops: ["invites.list", "users.list"] });
    const updated = ctx.db.select().from(users).where(eq(users.id, me.id)).get();
    return { status: "signedIn" as const, viewer: toViewer(updated ?? me) };
  }

  if (ctx.db.select({ id: users.id }).from(users).where(eq(users.email, row.email)).get()) {
    throw new OpError("CONFLICT", `${row.email} already has an account. Sign in first, then open the invite link again.`, {
      reason: "accountExists",
    });
  }
  if (!input.password) throw new OpError("BAD_REQUEST", "Choose a password of at least 10 characters.", { field: "password" });
  const passwordHash = await hashPassword(input.password);
  let user: typeof users.$inferSelect;
  try {
    user = ctx.db
      .insert(users)
      .values({ email: row.email, name: input.name?.trim() ?? "", role: "member", passwordHash })
      .returning()
      .get();
  } catch {
    throw new OpError("CONFLICT", `${row.email} already has an account. Sign in first.`, { reason: "accountExists" });
  }
  try {
    applyInvite(ctx.db, row, user.id, "member");
  } catch (error) {
    ctx.db.delete(users).where(eq(users.id, user.id)).run();
    throw error;
  }
  const fresh = ctx.db.select().from(users).where(eq(users.id, user.id)).get() ?? user;
  ctx.live.publish("panel", { type: "invalidate", ops: ["invites.list", "users.list"] });
  return finishSignIn(ctx, fresh);
});

export default defineModule({
  name: "invites",
  ops: [create, list, revoke, preview, accept],
});
