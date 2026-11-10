// Per-project and per-service grants for members.
// Contracts: packages/ops/src/ops/grants.ts. The pipeline enforces grants
// (src/auth/access.ts); this module lists and changes them.

import { grants as grantOps, OpError, type ScopeKind } from "@seylo/ops";
import { and, eq, inArray, or } from "drizzle-orm";
import { avatarField } from "../../auth/avatar";
import { requireFreshIfSession } from "../../auth/fresh";
import { grants, services, users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { checkGrantActions, findGrant, type GrantRow, grantAdds, listGrantsOf, requireScope, toGrants } from "./rows";

function withUsers(ctx: OpContext, rows: GrantRow[]) {
  const people = new Map(
    rows.length
      ? ctx.db
          .select({ id: users.id, email: users.email, name: users.name, avatar: users.avatar })
          .from(users)
          .where(
            inArray(
              users.id,
              rows.map((r) => r.userId),
            ),
          )
          .all()
          .map(({ avatar, ...u }) => [u.id, { ...u, ...avatarField(u.id, avatar) }])
      : [],
  );
  return toGrants(ctx.db, rows).map((grant) => ({ grant, user: people.get(grant.userId) ?? { id: grant.userId, email: "", name: "" } }));
}

const listByProject = implement(grantOps.listByProject, (input, ctx) => {
  requireScope(ctx.db, "project", input.projectId);
  const serviceIds = ctx.db.select({ id: services.id }).from(services).where(eq(services.projectId, input.projectId)).all();
  const scopes = [and(eq(grants.scopeType, "project"), eq(grants.scopeId, input.projectId))];
  if (serviceIds.length) {
    scopes.push(
      and(
        eq(grants.scopeType, "service"),
        inArray(
          grants.scopeId,
          serviceIds.map((s) => s.id),
        ),
      ),
    );
  }
  const rows = ctx.db
    .select()
    .from(grants)
    .where(or(...scopes))
    .orderBy(grants.scopeType, grants.createdAt)
    .all();
  return { grants: withUsers(ctx, rows) };
});

const listByService = implement(grantOps.listByService, (input, ctx) => {
  const projectId = requireScope(ctx.db, "service", input.serviceId);
  const rows = ctx.db
    .select()
    .from(grants)
    .where(
      or(
        and(eq(grants.scopeType, "service"), eq(grants.scopeId, input.serviceId)),
        and(eq(grants.scopeType, "project"), eq(grants.scopeId, projectId)),
      ),
    )
    .orderBy(grants.createdAt)
    .all();
  return { grants: withUsers(ctx, rows).map((g) => ({ ...g, inherited: g.grant.scopeType === "project" })) };
});

const listByUser = implement(grantOps.listByUser, (input, ctx) => {
  if (!ctx.db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).get()) {
    throw new OpError("NOT_FOUND", "That person does not exist.");
  }
  return { grants: listGrantsOf(ctx.db, input.userId) };
});

const mine = implement(grantOps.mine, (_input, ctx) => {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  const { user } = ctx.principal;
  if (user.role !== "member") return { grants: [] };
  return { grants: listGrantsOf(ctx.db, user.id) };
});

function published(ctx: OpContext, scopeType: ScopeKind, scopeId: string, projectId: string, userId?: string) {
  // The person's open tabs stop following what the change took away.
  if (userId) ctx.live.recheck({ userId });
  const ops = ["grants.listByProject", "grants.listByService", "grants.listByUser", "grants.mine", "users.list", "users.get"];
  ctx.live.publish(`project:${projectId}`, { type: "invalidate", ops });
  if (scopeType === "service") ctx.live.publish(`service:${scopeId}`, { type: "invalidate", ops });
  ctx.live.publish("panel", { type: "invalidate", ops: ["users.list", "users.get", "grants.listByUser"] });
}

function setGrant(ctx: OpContext, scopeType: ScopeKind, scopeId: string, userId: string, actions: readonly string[]) {
  const projectId = requireScope(ctx.db, scopeType, scopeId);
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  if (ctx.principal.user.id === userId) throw new OpError("FORBIDDEN", "You cannot change your own access.");
  const target = ctx.db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get();
  if (!target) throw new OpError("NOT_FOUND", "That person does not exist.");
  if (target.role !== "member") throw new OpError("BAD_REQUEST", "Owners and admins can already do everything; grants are for members.");
  const checked = checkGrantActions(ctx.access, scopeType, scopeId, actions);
  // More access for someone else is lasting access: a session left open may not hand it out.
  if (grantAdds(scopeType, findGrant(ctx.db, userId, scopeType, scopeId)?.actions ?? [], checked)) requireFreshIfSession(ctx);
  const row = ctx.db
    .insert(grants)
    .values({ userId, scopeType, scopeId, actions: checked, createdBy: ctx.principal.user.id })
    .onConflictDoUpdate({ target: [grants.userId, grants.scopeType, grants.scopeId], set: { actions: checked, updatedAt: new Date() } })
    .returning()
    .get();
  published(ctx, scopeType, scopeId, projectId, userId);
  return toGrants(ctx.db, [row])[0] as ReturnType<typeof toGrants>[number];
}

function removeGrant(ctx: OpContext, scopeType: ScopeKind, scopeId: string, userId: string) {
  const projectId = requireScope(ctx.db, scopeType, scopeId);
  if (ctx.principal.type !== "anonymous" && ctx.principal.user.id === userId) {
    throw new OpError("FORBIDDEN", "You cannot change your own access.");
  }
  const existing = findGrant(ctx.db, userId, scopeType, scopeId);
  if (!existing) throw new OpError("NOT_FOUND", "That person has no grant here.");
  ctx.db.delete(grants).where(eq(grants.id, existing.id)).run();
  published(ctx, scopeType, scopeId, projectId, userId);
  return {};
}

const setOnProject = implement(grantOps.setOnProject, (input, ctx) =>
  setGrant(ctx, "project", input.projectId, input.userId, input.actions),
);
const setOnService = implement(grantOps.setOnService, (input, ctx) =>
  setGrant(ctx, "service", input.serviceId, input.userId, input.actions),
);
const removeFromProject = implement(grantOps.removeFromProject, (input, ctx) => removeGrant(ctx, "project", input.projectId, input.userId));
const removeFromService = implement(grantOps.removeFromService, (input, ctx) => removeGrant(ctx, "service", input.serviceId, input.userId));

export default defineModule({
  name: "grants",
  ops: [listByProject, listByService, listByUser, mine, setOnProject, setOnService, removeFromProject, removeFromService],
});
