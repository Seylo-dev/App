// The signed-in person changes their own email (Settings > Personal
// details). It is what they sign in with, so it asks for a fresh sign-in
// first, like adding a way in, and stays unique. The old address hears
// about it when the panel can send email; a security alert goes out
// either way. Owners and admins change other people's email with
// users.update.

import { displayName } from "@seylo/brand";
import { auth, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { requireFreshSignIn } from "../../auth/fresh";
import { toViewer } from "../../auth/sign-in";
import { users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { getSetting } from "../../settings";
import { raiseSecurityChange } from "../alerts/security";

const taken = () => new OpError("CONFLICT", "Another account already uses this email.", { field: "email" });

/** Tells the old address; false when the panel has no SMTP channel or sending failed (the change stands). */
async function tellOldAddress(ctx: OpContext, from: string, to: string): Promise<boolean> {
  const panel = getSetting(ctx.db, "panelName") || displayName;
  const where = ctx.ip ? ` The change came from ${ctx.ip}.` : "";
  try {
    const result = await ctx.notify.sendEmail({
      to: from,
      subject: `Your ${panel} sign-in email was changed`,
      text: `The email you sign in to ${panel} with was changed from ${from} to ${to}.${where}\n\nIf you did not do this, tell the panel's owner right away.\n`,
    });
    return result === "sent";
  } catch {
    return false;
  }
}

export const changeEmail = implement(auth.changeEmail, async (input, ctx) => {
  // Before anything else: a session left open must not even learn which emails have accounts.
  const { userId } = requireFreshSignIn(ctx);
  const current = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!current) throw new OpError("NOT_FOUND", "This account no longer exists.");
  const email = input.email.trim().toLowerCase();
  if (email === current.email) return { viewer: toViewer(current), oldAddressNotified: false };

  const other = ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (other) throw taken();
  let updated: typeof users.$inferSelect | undefined;
  try {
    updated = ctx.db.update(users).set({ email }).where(eq(users.id, userId)).returning().get();
  } catch {
    // Another account took it between the check and the write (the unique index).
    throw taken();
  }
  if (!updated) throw new OpError("NOT_FOUND", "This account no longer exists.");

  ctx.live.publish("panel", { type: "invalidate", ops: ["users.list", "users.get"] });
  raiseSecurityChange(ctx, current, `changed the sign-in email from ${current.email} to ${email}`);
  const oldAddressNotified = await tellOldAddress(ctx, current.email, email);
  return { viewer: toViewer(updated), oldAddressNotified };
});
