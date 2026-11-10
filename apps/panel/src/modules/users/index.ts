// People: list, read, rename, roles, disable and remove accounts.
// Contracts: packages/ops/src/ops/users.ts, which lists the role rules
// enforced here.

import { OpError, users as userOps } from "@seylo/ops";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { requireFreshIfSession } from "../../auth/fresh";
import { clearAllFailures } from "../../auth/lockout";
import { apiKeys, type Role, users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { endUserSessions } from "../auth/end-sessions";
import { listGrantsOf } from "../grants/rows";
import { defineModule } from "../module";
import { activeOwnerCount, findUser, toUser, toUsers, type UserRow } from "./rows";

function actorOf(ctx: OpContext) {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  return ctx.principal.user;
}

/** Owners manage everyone; admins manage admins and members; nobody manages themselves here. */
function assertCanManage(ctx: OpContext, target: UserRow, verb: string) {
  const actor = actorOf(ctx);
  if (actor.id === target.id) throw new OpError("FORBIDDEN", `You cannot ${verb} your own account.`);
  if (target.role === "owner" && actor.role !== "owner") throw new OpError("FORBIDDEN", "Only an owner can change an owner.");
}

function assertNotLastOwner(ctx: OpContext, target: UserRow) {
  if (target.role === "owner" && !target.disabledAt && activeOwnerCount(ctx.db) <= 1) {
    throw new OpError("CONFLICT", "This is the last active owner. Make someone else an owner first.");
  }
}

function changed(ctx: OpContext) {
  ctx.live.publish("panel", { type: "invalidate", ops: ["users.list", "users.get", "grants.listByUser"] });
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

const roleRank: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

const list = implement(userOps.list, (input, ctx) => {
  const filters = [];
  if (input.role) filters.push(eq(users.role, input.role));
  if (input.status === "active") filters.push(isNull(users.disabledAt));
  if (input.status === "disabled") filters.push(sql`${users.disabledAt} is not null`);
  if (input.q?.trim()) {
    const pattern = `%${escapeLike(input.q.trim().toLowerCase())}%`;
    filters.push(or(sql`${users.email} like ${pattern} escape '\\'`, sql`lower(${users.name}) like ${pattern} escape '\\'`));
  }
  const rows = ctx.db
    .select()
    .from(users)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(sql`case ${users.role} when 'owner' then 0 when 'admin' then 1 else 2 end`, users.email)
    .all();
  return { users: toUsers(ctx.db, rows) };
});

const get = implement(userOps.get, (input, ctx) => {
  const row = findUser(ctx.db, input.userId);
  return { user: toUser(ctx.db, row), grants: listGrantsOf(ctx.db, row.id) };
});

const update = implement(userOps.update, (input, ctx) => {
  const target = findUser(ctx.db, input.userId);
  const actor = actorOf(ctx);
  if (target.role === "owner" && actor.role !== "owner" && actor.id !== target.id) {
    throw new OpError("FORBIDDEN", "Only an owner can change an owner.");
  }
  const values: Partial<UserRow> = {};
  if (input.name !== undefined) values.name = input.name.trim();
  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    // An owner or admin changing their own sign-in email here asks for the
    // same fresh sign-in as auth.changeEmail, so People is no way around it.
    if (target.id === actor.id && email !== target.email) requireFreshIfSession(ctx);
    const taken = ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (taken && taken.id !== target.id) throw new OpError("CONFLICT", "Another account already uses this email.");
    values.email = email;
  }
  const row = Object.keys(values).length ? ctx.db.update(users).set(values).where(eq(users.id, target.id)).returning().get() : target;
  changed(ctx);
  return toUser(ctx.db, row ?? target);
});

const updateRole = implement(userOps.updateRole, (input, ctx) => {
  const target = findUser(ctx.db, input.userId);
  assertCanManage(ctx, target, "change the role of");
  if (input.role === "owner" && actorOf(ctx).role !== "owner") throw new OpError("FORBIDDEN", "Only an owner can make someone an owner.");
  if (target.role === input.role) return toUser(ctx.db, target);
  if (input.role !== "owner") assertNotLastOwner(ctx, target);
  // A promotion hands out lasting full access: a session left open must not
  // make an account it controls an admin. Demotions need nothing.
  if (roleRank[input.role] > roleRank[target.role]) requireFreshIfSession(ctx);
  const row = ctx.db.update(users).set({ role: input.role }).where(eq(users.id, target.id)).returning().get() as UserRow;
  changed(ctx);
  // A demoted person's open tabs stop following what they may no longer see.
  ctx.live.recheck({ userId: target.id });
  return toUser(ctx.db, row);
});

const disable = implement(userOps.disable, (input, ctx) => {
  const target = findUser(ctx.db, input.userId);
  assertCanManage(ctx, target, "disable");
  if (target.disabledAt) return toUser(ctx.db, target);
  assertNotLastOwner(ctx, target);
  const now = new Date();
  const row = ctx.db.transaction((tx) => {
    tx.update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.userId, target.id), isNull(apiKeys.revokedAt)))
      .run();
    return tx.update(users).set({ disabledAt: now }).where(eq(users.id, target.id)).returning().get() as UserRow;
  });
  endUserSessions(ctx, target.id);
  changed(ctx);
  return toUser(ctx.db, row);
});

const enable = implement(userOps.enable, (input, ctx) => {
  const target = findUser(ctx.db, input.userId);
  assertCanManage(ctx, target, "enable");
  const row = ctx.db
    .update(users)
    .set({ disabledAt: null, failedLogins: 0, lockedUntil: null })
    .where(eq(users.id, target.id))
    .returning()
    .get() as UserRow;
  // Enabling also unlocks sign-in streaks from every address.
  clearAllFailures(ctx.db, { email: target.email, userId: target.id });
  changed(ctx);
  return toUser(ctx.db, row);
});

const remove = implement(userOps.remove, (input, ctx) => {
  const target = findUser(ctx.db, input.userId);
  assertCanManage(ctx, target, "remove");
  if (input.confirmEmail.trim().toLowerCase() !== target.email) {
    throw new OpError("BAD_REQUEST", "Type the person's email to confirm.", { field: "confirmEmail" });
  }
  assertNotLastOwner(ctx, target);
  // Sessions, second factors, passkeys, keys, GitHub link and grants go
  // with the row (ON DELETE CASCADE); audit entries keep their labels.
  ctx.db.delete(users).where(eq(users.id, target.id)).run();
  changed(ctx);
  return {};
});

export default defineModule({
  name: "users",
  ops: [list, get, update, updateRole, disable, enable, remove],
});
