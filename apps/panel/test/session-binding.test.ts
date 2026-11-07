// A browser session is the cookie plus the session key the web app keeps in
// its origin's storage. On a plain-HTTP IP:port panel the browser sends the
// cookie to every port of the address (a member's app on :8080 receives the
// owner's cookie), so the cookie alone must sign nobody in. Over HTTPS the
// cookie is `__Host-` (no sibling host can set or shadow it), and a request
// with the session cookie twice is refused instead of guessed at.

import { afterEach, expect, test } from "bun:test";
import {
  auth,
  livePath,
  liveSessionKeyParam,
  liveUnauthorizedCloseCode,
  secureSessionCookie,
  sessionCookie,
  sessionKeyHeader,
} from "@seylo/ops";
import { eq } from "drizzle-orm";
import { createSession } from "../src/auth/sessions";
import { sessions } from "../src/db/schema";
import { createProxyTrust } from "../src/http/proxy-trust";
import { setSetting } from "../src/settings";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits } from "./people-helpers";

const panels: TestPanel[] = [];
afterEach(async () => {
  for (const panel of panels.splice(0)) {
    if (panel.app.server) await panel.app.stop(true);
    panel.close();
  }
});

function make() {
  const panel = testPanel({ rateLimiter: noLimits, proxy: createProxyTrust({ always: false, proxies: [] }) });
  panels.push(panel);
  return panel;
}

/** Signs in at `host` and returns what the browser keeps: the Set-Cookie line, the cookie pair and the key. */
async function signIn(panel: TestPanel, host: string, email: string, password: string) {
  const login = await call(panel, auth.login, { email, password }, { headers: { host, origin: originOf(host) } });
  expect(login.status).toBe(200);
  const setCookie = login.headers.getSetCookie().join("\n");
  const pair = (login.headers.getSetCookie()[0] ?? "").split(";")[0] as string;
  return { setCookie, pair, key: login.headers.get(sessionKeyHeader) ?? "" };
}

const domain = "panel.example.com";
const originOf = (host: string) => (host === domain ? `https://${host}` : `http://${host}`);

/** auth.whoami with exactly these headers (no helper adds a key). */
async function whoami(panel: TestPanel, host: string, headers: Record<string, string>) {
  const response = await panel.app.handle(new Request(`${originOf(host)}/api/v1/auth.whoami`, { headers: { host, ...headers } }));
  return { status: response.status, body: (await response.json()) as { error?: { details?: Record<string, string> } } };
}

test("on IP:port the cookie alone signs nobody in: another port that received it cannot use it", async () => {
  const panel = make();
  const owner = await createUser(panel, "owner");
  const session = await signIn(panel, "127.0.0.1:3917", owner.user.email, owner.password);
  expect(session.pair.startsWith(`${sessionCookie}=`)).toBe(true);
  expect(session.setCookie).toMatch(/HttpOnly/i);
  expect(session.setCookie).not.toMatch(/Secure/i);
  expect(session.setCookie).not.toMatch(/Domain=/i);
  expect(session.key).toMatch(/^[A-Za-z0-9_-]{20,}$/);

  // What a member's app on :3918 sees is the Cookie header; it replays it with any Host it likes.
  for (const host of ["127.0.0.1:3918", "127.0.0.1:3917"]) {
    expect((await whoami(panel, host, { cookie: session.pair })).status).toBe(401);
  }
  // The web app on the panel's own origin sends the key it keeps in localStorage.
  expect((await whoami(panel, "127.0.0.1:3917", { cookie: session.pair, [sessionKeyHeader]: session.key })).status).toBe(200);
  // A key without its cookie, or with another session's cookie, is nothing either.
  expect((await whoami(panel, "127.0.0.1:3917", { [sessionKeyHeader]: session.key })).status).toBe(401);
  const other = createSession(panel.deps.db, owner.user.id, { ip: null, userAgent: null });
  expect(
    (await whoami(panel, "127.0.0.1:3917", { cookie: `${sessionCookie}=${other.token}`, [sessionKeyHeader]: session.key })).status,
  ).toBe(401);
});

test("a session planted by another site on the address does not sign the owner in as someone else", async () => {
  const panel = make();
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const mine = await signIn(panel, "127.0.0.1:3917", owner.user.email, owner.password);
  const theirs = await signIn(panel, "127.0.0.1:3917", member.user.email, member.password);

  // The planted cookie replaced the owner's (same name and path): the owner's key does not open it.
  expect((await whoami(panel, "127.0.0.1:3917", { cookie: theirs.pair, [sessionKeyHeader]: mine.key })).status).toBe(401);
  // Planted next to it with a longer path, the browser sends both, the planted one first: refused.
  const both = await whoami(panel, "127.0.0.1:3917", { cookie: `${theirs.pair}; ${mine.pair}`, [sessionKeyHeader]: mine.key });
  expect(both.status).toBe(401);
  expect(both.body.error?.details?.reason).toBe("duplicateSession");
});

test("over HTTPS the cookie is __Host- prefixed, and a plain or doubled one is not read", async () => {
  const panel = make();
  setSetting(panel.deps.db, "panelDomain", domain);
  const owner = await createUser(panel, "owner");
  const session = await signIn(panel, domain, owner.user.email, owner.password);
  expect(session.pair.startsWith(`${secureSessionCookie}=`)).toBe(true);
  expect(session.setCookie).toMatch(/Secure/i);
  expect(session.setCookie).toMatch(/Path=\//i);
  expect(session.setCookie).not.toMatch(/Domain=/i);

  const token = session.pair.slice(secureSessionCookie.length + 1);
  const key = { [sessionKeyHeader]: session.key };
  expect((await whoami(panel, domain, { cookie: session.pair, ...key })).status).toBe(200);
  // A sibling subdomain can set a plain seylo_session for the whole domain; over HTTPS it is never read.
  expect((await whoami(panel, domain, { cookie: `${sessionCookie}=${token}`, ...key })).status).toBe(401);
  const planted = createSession(panel.deps.db, owner.user.id, { ip: null, userAgent: null });
  expect((await whoami(panel, domain, { cookie: `${sessionCookie}=${planted.token}; ${session.pair}`, ...key })).status).toBe(200);
  const doubled = await whoami(panel, domain, { cookie: `${secureSessionCookie}=${planted.token}; ${session.pair}`, ...key });
  expect(doubled.status).toBe(401);
  expect(doubled.body.error?.details?.reason).toBe("duplicateSession");
});

test("sign-out clears both halves, a security change rotates both, and sessions from before keys sign nobody in", async () => {
  const panel = make();
  const owner = await createUser(panel, "owner");
  const host = "127.0.0.1:3917";
  const session = await signIn(panel, host, owner.user.email, owner.password);
  const headers = { cookie: session.pair, [sessionKeyHeader]: session.key };

  const changed = await call(
    panel,
    auth.changePassword,
    { currentPassword: owner.password, newPassword: "another long password" },
    { headers: { host, origin: originOf(host), ...headers } },
  );
  expect(changed.status).toBe(200);
  const rotated = {
    cookie: (changed.headers.getSetCookie()[0] ?? "").split(";")[0] as string,
    [sessionKeyHeader]: changed.headers.get(sessionKeyHeader) ?? "",
  };
  expect(rotated[sessionKeyHeader]).not.toBe(session.key);
  expect((await whoami(panel, host, headers)).status).toBe(401);
  expect((await whoami(panel, host, rotated)).status).toBe(200);

  const out = await call(panel, auth.logout, {}, { headers: { host, origin: originOf(host), ...rotated } });
  expect(out.headers.get(sessionKeyHeader)).toBe("");
  expect(out.headers.getSetCookie()[0]).toMatch(new RegExp(`^${sessionCookie}=;`));

  const old = createSession(panel.deps.db, owner.user.id, { ip: null, userAgent: null });
  panel.deps.db.update(sessions).set({ keyHash: null }).where(eq(sessions.id, old.sessionId)).run();
  expect((await whoami(panel, host, { cookie: `${sessionCookie}=${old.token}`, [sessionKeyHeader]: old.key })).status).toBe(401);
});

test("the live socket and the upload endpoint want the key too", async () => {
  const panel = make();
  panel.app.listen({ hostname: "127.0.0.1", port: 0 });
  const owner = await createUser(panel, "owner");
  const port = panel.app.server?.port;
  const session = createSession(panel.deps.db, owner.user.id, { ip: null, userAgent: null });
  const cookie = `${sessionCookie}=${session.token}`;

  const closeCode = (query: string) =>
    new Promise<number | "open">((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${livePath}${query}`, { headers: { cookie } } as never);
      ws.onclose = (event) => resolve(event.code);
      ws.onopen = () => {
        // The panel closes a socket without a session right after the upgrade; one that stays open is signed in.
        setTimeout(() => {
          resolve("open");
          ws.close();
        }, 200);
      };
    });
  expect(await closeCode("")).toBe(liveUnauthorizedCloseCode);
  expect(await closeCode(`?${liveSessionKeyParam}=${session.key}`)).toBe("open");

  const upload = (headers: Record<string, string>) =>
    panel.app.handle(
      new Request("http://127.0.0.1:3917/api/uploads/services/aaaaaaaaaaaaaaaa", {
        method: "POST",
        headers: { host: "127.0.0.1:3917", ...headers },
      }),
    );
  expect((await upload({ cookie })).status).toBe(401);
  // With the key the request gets past sign-in (and finds no such service).
  expect((await upload({ cookie, [sessionKeyHeader]: session.key })).status).toBe(404);
});
