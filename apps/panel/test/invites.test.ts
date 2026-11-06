// Invites: create with grants, preview, accept as a new person or as an
// existing one, revoke and expiry.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, invites as inviteOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { createAccess } from "../src/auth/access";
import { grants, invites, users } from "../src/db/schema";
import { setSetting } from "../src/settings";
import { createUser, grant, type TestPanel, testPanel } from "./helpers";
import { call, cookieFrom, noLimits, ok, seedProject, seedService } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

const tokenOf = (link: string) => new URL(link, "http://x").searchParams.get("t") as string;

test("invite a new member to one service; accepting creates the account with that grant only", async () => {
  const owner = await createUser(panel, "owner");
  const project = seedProject(panel);
  const api = seedService(panel, project.id, "api");
  const web = seedService(panel, project.id, "web");

  const created = await ok(
    panel,
    inviteOps.create,
    {
      email: "New@Example.com",
      role: "member",
      grants: [{ scopeType: "service", scopeId: api.id, actions: ["services.view", "logs.view"] }],
    },
    { cookie: owner.cookie },
  );
  expect(created.body.emailed).toBe(false);
  expect(created.body.link).toStartWith("http://panel.test/invite?t=");
  expect(created.body.invite).toMatchObject({ email: "new@example.com", status: "pending", invitedBy: { id: owner.user.id } });
  expect(created.body.invite.grants[0]).toMatchObject({ scopeName: "api", actions: ["services.view", "logs.view"] });
  const token = tokenOf(created.body.link);
  expect(panel.deps.db.select().from(invites).get()?.tokenHash).not.toBe(token);

  const preview = await ok(panel, inviteOps.preview, { token });
  expect(preview.body).toMatchObject({ valid: true, email: "new@example.com", role: "member", invitedBy: "owner", accountExists: false });
  expect((await ok(panel, inviteOps.preview, { token: "bogus" })).body.valid).toBe(false);

  expect((await call(panel, inviteOps.accept, { token })).status).toBe(400);
  const accepted = await ok(panel, inviteOps.accept, { token, name: "Newbie", password: "a long enough password" });
  expect(accepted.body).toMatchObject({ status: "signedIn", viewer: { email: "new@example.com", role: "member", name: "Newbie" } });
  const cookie = cookieFrom(accepted.headers) as string;
  const me = await ok(panel, auth.whoami, {}, { cookie });

  const access = createAccess(panel.deps.db, { type: "session", user: me.body.viewer, sessionId: "s" });
  expect(access.can("logs.view", { type: "service", id: api.id })).toBe(true);
  expect(access.can("services.deploy", { type: "service", id: api.id })).toBe(false);
  expect(access.can("services.view", { type: "service", id: web.id })).toBe(false);

  // Used up.
  expect((await call(panel, inviteOps.accept, { token, password: "a long enough password" })).status).toBe(403);
  expect((await ok(panel, inviteOps.list, {}, { cookie: owner.cookie })).body.invites[0].status).toBe("accepted");
});

test("an existing person accepts while signed in and gets the grants merged in", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const project = seedProject(panel);
  grant(panel, member.user.id, "project", project.id, ["services.view"]);
  const created = await ok(
    panel,
    inviteOps.create,
    { email: member.user.email, role: "member", grants: [{ scopeType: "project", scopeId: project.id, actions: ["services.deploy"] }] },
    { cookie: owner.cookie },
  );
  const token = tokenOf(created.body.link);
  expect((await ok(panel, inviteOps.preview, { token })).body.accountExists).toBe(true);
  // Without a session: sign in first.
  expect((await call(panel, inviteOps.accept, { token, password: "a long enough password" })).status).toBe(409);
  // Someone else's session cannot take it.
  const other = await createUser(panel, "member");
  expect((await call(panel, inviteOps.accept, { token }, { cookie: other.cookie })).status).toBe(403);

  await ok(panel, inviteOps.accept, { token }, { cookie: member.cookie });
  const row = panel.deps.db.select().from(grants).where(eq(grants.userId, member.user.id)).get();
  expect(row?.actions.sort()).toEqual(["services.deploy", "services.view"]);
});

test("admin invites need no grants and make admins", async () => {
  const owner = await createUser(panel, "owner");
  setSetting(panel.deps.db, "panelDomain", "panel.example.com");
  const bad = await call(
    panel,
    inviteOps.create,
    { email: "a@example.com", role: "admin", grants: [{ scopeType: "project", scopeId: seedProject(panel).id, actions: ["*"] }] },
    { cookie: owner.cookie },
  );
  expect(bad.status).toBe(400);
  const created = await ok(panel, inviteOps.create, { email: "a@example.com", role: "admin" }, { cookie: owner.cookie });
  expect(created.body.link).toStartWith("https://panel.example.com/invite?t=");
  const accepted = await ok(panel, inviteOps.accept, { token: tokenOf(created.body.link), password: "a long enough password" });
  expect(accepted.body.viewer.role).toBe("admin");
});

test("revoked, replaced and expired invites stop working", async () => {
  const owner = await createUser(panel, "owner");
  const project = seedProject(panel);
  const make = () =>
    ok(
      panel,
      inviteOps.create,
      { email: "x@example.com", role: "member", grants: [{ scopeType: "project", scopeId: project.id, actions: ["projects.view"] }] },
      { cookie: owner.cookie },
    );
  const first = await make();
  const second = await make();
  expect((await ok(panel, inviteOps.preview, { token: tokenOf(first.body.link) })).body.valid).toBe(false);
  expect((await ok(panel, inviteOps.list, { status: "revoked" }, { cookie: owner.cookie })).body.invites).toHaveLength(1);

  const revoked = await ok(panel, inviteOps.revoke, { inviteId: second.body.invite.id }, { cookie: owner.cookie });
  expect(revoked.body.status).toBe("revoked");
  expect((await call(panel, inviteOps.accept, { token: tokenOf(second.body.link), password: "a long enough password" })).status).toBe(403);

  const third = await make();
  panel.deps.db
    .update(invites)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(invites.id, third.body.invite.id))
    .run();
  expect((await ok(panel, inviteOps.preview, { token: tokenOf(third.body.link) })).body.valid).toBe(false);
  expect((await ok(panel, inviteOps.list, { status: "expired" }, { cookie: owner.cookie })).body.invites).toHaveLength(1);
  expect(panel.deps.db.select().from(users).where(eq(users.email, "x@example.com")).get()).toBeUndefined();
});

test("a key narrowed to some actions cannot invite with more than it holds", async () => {
  const owner = await createUser(panel, "owner");
  const project = seedProject(panel);
  const { createApiKey } = await import("./helpers");
  const bearer = createApiKey(panel, owner.user.id, { actions: ["users.invite", "services.view"] });
  const result = await call(
    panel,
    inviteOps.create,
    { email: "y@example.com", role: "member", grants: [{ scopeType: "project", scopeId: project.id, actions: ["services.deploy"] }] },
    { bearer },
  );
  expect(result.status).toBe(403);
  const fine = await call(
    panel,
    inviteOps.create,
    { email: "y@example.com", role: "member", grants: [{ scopeType: "project", scopeId: project.id, actions: ["services.view"] }] },
    { bearer },
  );
  expect(fine.status).toBe(200);
});

test("grants with unknown or global actions are refused", async () => {
  const owner = await createUser(panel, "owner");
  const project = seedProject(panel);
  for (const actions of [["users.manage"], ["nope.nothing"], ["nope.*"]]) {
    const result = await call(
      panel,
      inviteOps.create,
      { email: "z@example.com", role: "member", grants: [{ scopeType: "project", scopeId: project.id, actions }] },
      { cookie: owner.cookie },
    );
    expect(result.status).toBe(400);
  }
});

test("the link is emailed through the panel's SMTP channel when there is one", async () => {
  const owner = await createUser(panel, "owner");
  const sent: { to: string; subject: string; text: string }[] = [];
  panel.deps.notify = {
    sendEmail: async (email) => {
      sent.push(email);
      return "sent";
    },
  };
  const created = await ok(panel, inviteOps.create, { email: "mail@example.com", role: "admin" }, { cookie: owner.cookie });
  expect(created.body.emailed).toBe(true);
  expect(sent[0]?.to).toBe("mail@example.com");
  expect(sent[0]?.text).toContain(created.body.link);
  // sendEmail false: nothing is sent.
  const quiet = await ok(
    panel,
    inviteOps.create,
    { email: "quiet@example.com", role: "admin", sendEmail: false },
    { cookie: owner.cookie },
  );
  expect(quiet.body.emailed).toBe(false);
  expect(sent).toHaveLength(1);
});
