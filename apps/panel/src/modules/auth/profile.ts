// The signed-in person's name and UI preferences.

import { auth, OpError } from "@seylo/ops";
import { eq, inArray } from "drizzle-orm";
import { requireSession, toViewer } from "../../auth/sign-in";
import { projects, users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";

/** Preferences are small UI choices; anything bigger is a bug or abuse. */
const maxPreferencesBytes = 16 * 1024;
const maxHiddenProjects = auth.HiddenProjectIds.maxItems as number;

function currentUserId(ctx: OpContext): string {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  return ctx.principal.user.id;
}

/**
 * hiddenProjectIds keeps only projects that exist and the caller can see,
 * in the stored order. Deleted projects, projects the caller lost access to
 * and anything that is not an id drop out; an empty list leaves the key out.
 * Preferences were free-form before hiddenProjectIds had a shape, so the
 * stored value may be anything.
 */
function withVisibleHidden(ctx: OpContext, preferences: Record<string, unknown>): Record<string, unknown> {
  const { hiddenProjectIds: stored, ...rest } = preferences;
  if (stored === undefined) return preferences;
  const ids = Array.isArray(stored) ? [...new Set(stored.filter((id): id is string => typeof id === "string"))] : [];
  const existing = new Set(
    ids.length === 0
      ? []
      : ctx.db
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.id, ids))
          .all()
          .map((row) => row.id),
  );
  const kept = ids.filter((id) => existing.has(id) && ctx.access.can("projects.view", { type: "project", id })).slice(0, maxHiddenProjects);
  return kept.length > 0 ? { ...rest, hiddenProjectIds: kept } : rest;
}

/**
 * showHiddenInSidebar is kept only when it is false: true is the default,
 * so it leaves the key out, the same as never choosing. Anything that is
 * not a boolean (free-form preferences from before the key had a shape)
 * drops out too.
 */
function withSidebarChoice(preferences: Record<string, unknown>): Record<string, unknown> {
  const { showHiddenInSidebar: stored, ...rest } = preferences;
  return stored === false ? preferences : rest;
}

/** The preferences as they are stored and answered (see the two helpers above). */
function cleaned(ctx: OpContext, preferences: Record<string, unknown>): Record<string, unknown> {
  return withSidebarChoice(withVisibleHidden(ctx, preferences));
}

export const updateProfile = implement(auth.updateProfile, (input, ctx) => {
  const { userId } = requireSession(ctx);
  const user = ctx.db.update(users).set({ name: input.name.trim() }).where(eq(users.id, userId)).returning().get();
  if (!user) throw new OpError("NOT_FOUND", "This account no longer exists.");
  return { viewer: toViewer(user) };
});

export const preferences = implement(auth.preferences, (_input, ctx) => {
  const row = ctx.db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, currentUserId(ctx)))
    .get();
  return { preferences: cleaned(ctx, row?.preferences ?? {}) };
});

export const updatePreferences = implement(auth.updatePreferences, (input, ctx) => {
  const userId = currentUserId(ctx);
  return ctx.db.transaction((tx) => {
    const row = tx.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).get();
    let merged: Record<string, unknown> = { ...(row?.preferences ?? {}) };
    for (const [key, value] of Object.entries(input.preferences)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    // Stored as it is answered: ids of other people's or deleted projects are not kept, nor a showHiddenInSidebar of true.
    merged = cleaned(ctx, merged);
    if (new TextEncoder().encode(JSON.stringify(merged)).length > maxPreferencesBytes) {
      throw new OpError("BAD_REQUEST", "Preferences are limited to 16 KB.");
    }
    tx.update(users).set({ preferences: merged }).where(eq(users.id, userId)).run();
    return { preferences: merged };
  });
});
