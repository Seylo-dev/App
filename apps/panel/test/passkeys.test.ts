// Passkeys end to end with a virtual ES256 authenticator: only with a
// panel domain, registration, discoverable sign-in that skips 2FA,
// signature counters, wrong origins and removal.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { passkeys, totpSecrets } from "../src/db/schema";
import { setSetting } from "../src/settings";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, cookieFrom, noLimits, ok, VirtualAuthenticator } from "./people-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

async function register(cookie: string, device: VirtualAuthenticator, name = "Laptop") {
  const begin = await ok(panel, auth.passkeyRegisterBegin, {}, { cookie });
  return call(
    panel,
    auth.passkeyRegisterFinish,
    { ticket: begin.body.ticket, name, response: device.register(begin.body.options) },
    { cookie },
  );
}

async function signIn(device: VirtualAuthenticator, overrides: { origin?: string } = {}) {
  const begin = await ok(panel, auth.passkeyLoginBegin, {});
  expect(begin.body.options.userVerification).toBe("required");
  return call(panel, auth.passkeyLoginFinish, { ticket: begin.body.ticket, response: device.assert(begin.body.options, overrides) });
}

test("passkeys are not offered without a panel domain", async () => {
  const { cookie } = await createUser(panel, "owner");
  expect((await ok(panel, auth.security, {}, { cookie })).body.passkeysAvailable).toBe(false);
  expect((await call(panel, auth.passkeyRegisterBegin, {}, { cookie })).status).toBe(503);
  expect((await call(panel, auth.passkeyLoginBegin, {})).status).toBe(503);
});

test("register a passkey and sign in with it, skipping the second factor", async () => {
  setSetting(panel.deps.db, "panelDomain", "panel.test");
  const { user, cookie } = await createUser(panel, "owner");
  expect((await ok(panel, auth.security, {}, { cookie })).body.passkeysAvailable).toBe(true);

  const device = new VirtualAuthenticator("panel.test", "https://panel.test");
  const registered = await register(cookie, device);
  expect(registered.status).toBe(200);
  expect(registered.body.name).toBe("Laptop");
  expect((await ok(panel, auth.security, {}, { cookie })).body.passkeys).toHaveLength(1);
  // The same authenticator cannot be added twice.
  expect((await register(cookie, device, "Again")).status).toBe(409);

  // Even with an authenticator app on, a passkey signs in directly.
  panel.deps.db
    .insert(totpSecrets)
    .values({ userId: user.id, secretSealed: panel.deps.secrets.seal("JBSWY3DPEHPK3PXP", "totp.secret"), confirmedAt: new Date() })
    .run();
  const login = await signIn(device);
  expect(login.status).toBe(200);
  expect(login.body).toMatchObject({ status: "signedIn", viewer: { id: user.id } });
  const session = cookieFrom(login.headers) as string;
  expect((await ok(panel, auth.whoami, {}, { cookie: session })).body.viewer.id).toBe(user.id);

  const stored = panel.deps.db.select().from(passkeys).where(eq(passkeys.userId, user.id)).get();
  expect(stored?.signCount).toBe(1);
  expect(stored?.lastUsedAt).not.toBeNull();
  expect((await signIn(device)).status).toBe(200);
});

test("assertions from another origin or an unknown authenticator fail", async () => {
  setSetting(panel.deps.db, "panelDomain", "panel.test");
  const { cookie } = await createUser(panel, "member");
  const device = new VirtualAuthenticator("panel.test", "https://panel.test");
  expect((await register(cookie, device)).status).toBe(200);
  expect((await signIn(device, { origin: "https://evil.test" })).status).toBe(401);
  expect((await signIn(new VirtualAuthenticator("panel.test", "https://panel.test"))).status).toBe(401);
  const wrongRp = new VirtualAuthenticator("other.test", "https://panel.test");
  expect((await register(cookie, wrongRp)).status).toBe(400);
});

test("removing a passkey stops it from signing in; others' passkeys are not yours", async () => {
  setSetting(panel.deps.db, "panelDomain", "panel.test");
  const { cookie } = await createUser(panel, "member");
  const device = new VirtualAuthenticator("panel.test", "https://panel.test");
  const id = (await register(cookie, device)).body.id;
  const stranger = await createUser(panel, "member");
  expect((await call(panel, auth.passkeyRemove, { passkeyId: id }, { cookie: stranger.cookie })).status).toBe(404);
  await ok(panel, auth.passkeyRemove, { passkeyId: id }, { cookie });
  expect((await signIn(device)).status).toBe(401);
});
