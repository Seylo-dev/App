// Per-person sidebar state: collapsed projects and the person's own order.
// Only the caller's rows change, so nothing goes to shared live topics;
// the caller's own tab refetches projects.list after the mutation.

import { OpError, projects as projectOps } from "@seylo/ops";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { projectPrefs, projects } from "../../db/schema";
import { implement } from "../../ops/implement";

export const setCollapsed = implement(projectOps.setCollapsed, (input, ctx) => {
  const user = userOf(ctx.principal);
  if (!user) throw new OpError("UNAUTHENTICATED", "Sign in or use a valid API key.");
  if (!ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()) {
    throw new OpError("NOT_FOUND", "No project with this id.");
  }
  ctx.db
    .insert(projectPrefs)
    .values({ userId: user.id, projectId: input.projectId, collapsed: input.collapsed })
    .onConflictDoUpdate({
      target: [projectPrefs.userId, projectPrefs.projectId],
      set: { collapsed: input.collapsed, updatedAt: new Date() },
    })
    .run();
  return { projectId: input.projectId, collapsed: input.collapsed };
});

export const reorder = implement(projectOps.reorder, (input, ctx) => {
  const user = userOf(ctx.principal);
  if (!user) throw new OpError("UNAUTHENTICATED", "Sign in or use a valid API key.");

  const existing = new Set(
    input.projectIds.length === 0
      ? []
      : ctx.db
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.id, input.projectIds))
          .all()
          .map((r) => r.id),
  );
  const ordered = input.projectIds.filter((id) => existing.has(id) && ctx.access.can("projects.view", { type: "project", id }));

  ctx.db.transaction((tx) => {
    // Projects left out of the list lose their position and fall back to name order.
    tx.update(projectPrefs)
      .set({ position: null })
      .where(
        ordered.length > 0
          ? and(eq(projectPrefs.userId, user.id), notInArray(projectPrefs.projectId, ordered))
          : eq(projectPrefs.userId, user.id),
      )
      .run();
    ordered.forEach((projectId, position) => {
      tx.insert(projectPrefs)
        .values({ userId: user.id, projectId, position })
        .onConflictDoUpdate({ target: [projectPrefs.userId, projectPrefs.projectId], set: { position, updatedAt: new Date() } })
        .run();
    });
  });
  return { projectIds: ordered };
});
