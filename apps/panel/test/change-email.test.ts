// auth.changeEmail: people change the email they sign in with themselves.
// It needs a fresh sign-in (a session left open must not move the account
// or learn which emails exist), stays unique, is audited, tells the old
// address when the panel can send email, and leaves the owner/admin path
// (users.update) as it was.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { audit, auth, users as userOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { freshSignInMs } from "../src/auth/fresh";
import { sessions, users } from "../src/db/schema";
import { createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, ok } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

/** Makes the person's sessions look signed in an hour ago, so they are no longer fresh. */
function age(userId: string) {
  const at = new Date(Date.now() - freshSignInMs - 60 * 60 * 1000);
  panel.deps.db.update(sessions).set({ createdAt: at, reauthAt: null }).where(eq(sessions.userId, userId)).run();
}

const emailOf = (userId: string) => panel.deps.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email;

test("a fresh session changes its own email; signing in then takes the new one", async () => {
  const { user, password, cookie } = await createUser(panel, "member", "me@example.com");
  const changed = await ok(panel, auth.changeEmail, { email: "Me.New@Example.com" }, { cookie });
  expect(changed.body).toMatchObject({ viewer: { id: user.id, email: "me.new@example.com" }, oldAddressNotified: false });
  expect(emailOf(user.id)).toBe("me.new@example.com");
  expect((await ok(panel, auth.whoami, {}, { cookie })).body.viewer.email).toBe("me.new@example.com");

  expect((await call(panel, auth.login, { email: "me@example.com", password })).status).toBe(401);
  expect((await call(panel, auth.login, { email: "me.new@example.com", password })).status).toBe(200);

  // Audited, as the person.
  const entries = (await ok(panel, audit.list, { opId: "auth.changeEmail" }, { cookie })).body.entries;
  expect(entries[0]).toMatchObject({ outcome: "ok", actor: { id: user.id }, input: { email: "Me.New@Example.com" } });

  // The same address again changes nothing.
  expect((await ok(panel, auth.changeEmail, { email: "me.new@example.com" }, { cookie })).body.viewer.email).toBe("me.new@example.com");
});

test("a stale session is asked to confirm it's you first, before anything is checked", async () => {
  const other = await createUser(panel, "member", "taken@example.com");
  const { user, password, cookie } = await createUser(panel, "member", "me@example.com");
  age(user.id);
  // Even a taken address answers with re-auth: a left-open session learns nothing.
  for (const email of ["taken@example.com", "free@example.com"]) {
    const refused = await call(panel, auth.changeEmail, { email }, { cookie });
    expect({ status: refused.status, reason: refused.body.error?.details?.reason }).toEqual({ status: 403, reason: "reauth" });
  }
  expect(emailOf(user.id)).toBe("me@example.com");

  await ok(panel, auth.reauth, { password }, { cookie });
  const conflict = await call(panel, auth.changeEmail, { email: "Taken@Example.com" }, { cookie });
  expect({ status: conflict.status, field: conflict.body.error?.details?.field }).toEqual({ status: 409, field: "email" });
  expect(conflict.body.error.message).toBe("Another account already uses this email.");
  expect(emailOf(other.user.id)).toBe("taken@example.com");
  expect((await ok(panel, auth.changeEmail, { email: "free@example.com" }, { cookie })).body.viewer.email).toBe("free@example.com");
});

test("API keys cannot change the email", async () => {
  const { user } = await createUser(panel, "owner", "owner@example.com");
  const bearer = createApiKey(panel, user.id);
  expect((await call(panel, auth.changeEmail, { email: "key@example.com" }, { bearer })).status).toBe(403);
  expect(emailOf(user.id)).toBe("owner@example.com");
});

test("with an SMTP channel the old address is told, and the change stands if sending fails", async () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  let answer: "sent" | "failed" = "sent";
  panel.deps.notify = {
    sendEmail: async (email) => {
      sent.push(email);
      return answer;
    },
  };
  const { cookie } = await createUser(panel, "admin", "old@example.com");
  const changed = await ok(panel, auth.changeEmail, { email: "new@example.com" }, { cookie });
  expect(changed.body.oldAddressNotified).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("old@example.com");
  expect(sent[0]?.text).toContain("new@example.com");

  answer = "failed";
  const again = await ok(panel, auth.changeEmail, { email: "newer@example.com" }, { cookie });
  expect(again.body).toMatchObject({ viewer: { email: "newer@example.com" }, oldAddressNotified: false });
  expect(sent[1]?.to).toBe("new@example.com");
});

test("owners and admins still change other people's email under People, but their own only when fresh", async () => {
  const owner = await createUser(panel, "owner", "owner@example.com");
  const { user } = await createUser(panel, "member", "member@example.com");
  age(owner.user.id);
  const updated = await ok(panel, userOps.update, { userId: user.id, email: "Moved@Example.com" }, { cookie: owner.cookie });
  expect(updated.body.email).toBe("moved@example.com");

  // Their own account through People needs the same fresh sign-in as auth.changeEmail; a rename does not.
  const own = await call(panel, userOps.update, { userId: owner.user.id, email: "me@example.com" }, { cookie: owner.cookie });
  expect({ status: own.status, reason: own.body.error?.details?.reason }).toEqual({ status: 403, reason: "reauth" });
  expect((await ok(panel, userOps.update, { userId: owner.user.id, name: "Owner" }, { cookie: owner.cookie })).body.name).toBe("Owner");
  await ok(panel, auth.reauth, { password: owner.password }, { cookie: owner.cookie });
  expect((await ok(panel, userOps.update, { userId: owner.user.id, email: "me@example.com" }, { cookie: owner.cookie })).body.email).toBe(
    "me@example.com",
  );
});
