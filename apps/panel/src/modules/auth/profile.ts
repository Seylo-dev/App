// The signed-in person's name and UI preferences.

import { auth, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { requireSession, toViewer } from "../../auth/sign-in";
import { users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";

/** Preferences are small UI choices; anything bigger is a bug or abuse. */
const maxPreferencesBytes = 16 * 1024;

function currentUserId(ctx: OpContext): string {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  return ctx.principal.user.id;
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
  return { preferences: row?.preferences ?? {} };
});

export const updatePreferences = implement(auth.updatePreferences, (input, ctx) => {
  const userId = currentUserId(ctx);
  return ctx.db.transaction((tx) => {
    const row = tx.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).get();
    const merged: Record<string, unknown> = { ...(row?.preferences ?? {}) };
    for (const [key, value] of Object.entries(input.preferences)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    if (new TextEncoder().encode(JSON.stringify(merged)).length > maxPreferencesBytes) {
      throw new OpError("BAD_REQUEST", "Preferences are limited to 16 KB.");
    }
    tx.update(users).set({ preferences: merged }).where(eq(users.id, userId)).run();
    return { preferences: merged };
  });
});
