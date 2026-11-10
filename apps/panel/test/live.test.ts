import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  auth,
  grants as grantOps,
  type LiveServerMessage,
  livePath,
  liveSessionKeyParam,
  liveUnauthorizedCloseCode,
  projects,
} from "@seylo/ops";
import { eq } from "drizzle-orm";
import { authenticate } from "../src/auth/authenticate";
import { aiConversations, sessions } from "../src/db/schema";
import { liveFloodCloseCode, liveMessageRule, maxTopicsPerSocket } from "../src/live/endpoint";
import { createLiveHub } from "../src/live/hub";
import { callOp, createUser, grant, sessionKeyOf, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
  panel.app.listen({ hostname: "127.0.0.1", port: 0 });
});
afterEach(async () => {
  await panel.app.stop(true);
  panel.close();
});

function openLive(cookie?: string) {
  // The web app adds the session key it keeps in localStorage as a query parameter.
  const key = cookie ? sessionKeyOf(cookie) : undefined;
  const query = key ? `?${liveSessionKeyParam}=${key}` : "";
  const ws = new WebSocket(`ws://127.0.0.1:${panel.app.server!.port}${livePath}${query}`, { headers: cookie ? { cookie } : {} } as never);
  const messages: LiveServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (event) => {
    messages.push(JSON.parse(event.data as string));
    for (const wake of waiters.splice(0)) wake();
  };
  const closed = new Promise<number>((resolve) => (ws.onclose = (event) => resolve(event.code)));
  const opened = new Promise((resolve) => (ws.onopen = resolve));
  const next = async () => {
    while (messages.length === 0) await new Promise<void>((wake) => waiters.push(wake));
    return messages.shift() as LiveServerMessage;
  };
  return { ws, next, opened, closed };
}

test("a signed-in tab subscribes and receives invalidations", async () => {
  const { cookie } = await createUser(panel, "owner");
  const live = openLive(cookie);
  await live.opened;
  live.ws.send(JSON.stringify({ type: "subscribe", topic: "panel" }));
  expect(await live.next()).toEqual({ type: "subscribed", topic: "panel" });

  await callOp(panel, projects.create, { name: "from-live-test" }, { cookie });
  expect(await live.next()).toEqual({ type: "event", topic: "panel", event: { type: "invalidate", ops: ["projects.list"] } });
  live.ws.close();
});

test("members cannot follow projects they have no grant on", async () => {
  const { cookie: ownerCookie } = await createUser(panel, "owner");
  const a = (await callOp(panel, projects.create, { name: "a" }, { cookie: ownerCookie })).body.id as string;
  const b = (await callOp(panel, projects.create, { name: "b" }, { cookie: ownerCookie })).body.id as string;
  const { user, cookie } = await createUser(panel, "member");
  grant(panel, user.id, "project", a, ["projects.view"]);

  const live = openLive(cookie);
  await live.opened;
  live.ws.send(JSON.stringify({ type: "subscribe", topic: `project:${a}` }));
  expect(await live.next()).toEqual({ type: "subscribed", topic: `project:${a}` });
  live.ws.send(JSON.stringify({ type: "subscribe", topic: `project:${b}` }));
  expect(await live.next()).toMatchObject({ type: "error", code: "FORBIDDEN", topic: `project:${b}` });
  live.ws.send("not json");
  expect(await live.next()).toMatchObject({ type: "error", code: "BAD_REQUEST" });
  live.ws.close();
});

test("an anonymous socket is closed", async () => {
  const live = openLive();
  expect(await live.closed).toBe(liveUnauthorizedCloseCode);
});

test("a socket closes when its session is revoked, on the next subscribe or via deps.live.disconnect", async () => {
  const { user, cookie } = await createUser(panel, "owner");
  const first = openLive(cookie);
  await first.opened;
  // Revoke every session of the person: the next subscribe finds the socket signed out.
  panel.deps.db.delete(sessions).where(eq(sessions.userId, user.id)).run();
  first.ws.send(JSON.stringify({ type: "subscribe", topic: "panel" }));
  expect(await first.closed).toBe(liveUnauthorizedCloseCode);

  const again = await createUser(panel, "admin");
  const second = openLive(again.cookie);
  await second.opened;
  second.ws.send(JSON.stringify({ type: "subscribe", topic: "panel" }));
  expect(await second.next()).toEqual({ type: "subscribed", topic: "panel" });
  panel.deps.live.disconnect({ userId: again.user.id });
  expect(await second.closed).toBe(liveUnauthorizedCloseCode);
});

test("signing out closes that session's live socket at once", async () => {
  const { cookie } = await createUser(panel, "owner");
  const live = openLive(cookie);
  await live.opened;
  live.ws.send(JSON.stringify({ type: "subscribe", topic: "panel" }));
  expect(await live.next()).toEqual({ type: "subscribed", topic: "panel" });
  expect((await callOp(panel, auth.logout, {}, { cookie })).status).toBe(200);
  expect(await live.closed).toBe(liveUnauthorizedCloseCode);
});

test("assistant topics are for the conversation's owner only", async () => {
  const owner = await createUser(panel, "owner");
  const other = await createUser(panel, "admin");
  const conversation = panel.deps.db.insert(aiConversations).values({ userId: owner.user.id }).returning().get();
  const mine = openLive(owner.cookie);
  await mine.opened;
  mine.ws.send(JSON.stringify({ type: "subscribe", topic: `ai:${conversation.id}` }));
  expect(await mine.next()).toEqual({ type: "subscribed", topic: `ai:${conversation.id}` });
  const theirs = openLive(other.cookie);
  await theirs.opened;
  theirs.ws.send(JSON.stringify({ type: "subscribe", topic: `ai:${conversation.id}` }));
  expect(await theirs.next()).toMatchObject({ type: "error", code: "FORBIDDEN" });
  mine.ws.close();
  theirs.ws.close();
});

test("removing a grant stops the topics it allowed at once", async () => {
  const { cookie: ownerCookie } = await createUser(panel, "owner");
  const a = (await callOp(panel, projects.create, { name: "a" }, { cookie: ownerCookie })).body.id as string;
  const { user, cookie } = await createUser(panel, "member");
  grant(panel, user.id, "project", a, ["projects.view"]);
  const live = openLive(cookie);
  await live.opened;
  live.ws.send(JSON.stringify({ type: "subscribe", topic: `project:${a}` }));
  expect(await live.next()).toEqual({ type: "subscribed", topic: `project:${a}` });
  await callOp(panel, grantOps.removeFromProject, { projectId: a, userId: user.id }, { cookie: ownerCookie });
  // An invalidation on the project may come first; the FORBIDDEN error follows.
  let message = await live.next();
  while (message.type === "event") message = await live.next();
  expect(message).toMatchObject({ type: "error", topic: `project:${a}`, code: "FORBIDDEN" });
  live.ws.close();
});

test("a socket that floods messages is closed before they cost any database work", async () => {
  const { cookie } = await createUser(panel, "owner");
  const live = openLive(cookie);
  await live.opened;
  // More than one person's whole burst in one go: the panel stops reading and closes the socket.
  for (let i = 0; i <= liveMessageRule.burst + 10; i++) live.ws.send(JSON.stringify({ type: "unsubscribe", topic: "panel" }));
  expect(await live.closed).toBe(liveFloodCloseCode);
  // Not the signed-out code: the web app reconnects with backoff instead of showing sign-in.
  expect(liveFloodCloseCode).not.toBe(liveUnauthorizedCloseCode);
});

test("one socket follows a bounded number of topics", async () => {
  const { cookie } = await createUser(panel, "owner");
  const live = openLive(cookie);
  await live.opened;
  const topics = Array.from({ length: maxTopicsPerSocket + 1 }, (_, i) => `node:${String(i).padStart(16, "0")}`);
  for (const topic of topics) live.ws.send(JSON.stringify({ type: "subscribe", topic }));
  const answers: LiveServerMessage[] = [];
  for (let i = 0; i < topics.length; i++) answers.push(await live.next());
  expect(answers.filter((m) => m.type === "subscribed")).toHaveLength(maxTopicsPerSocket);
  expect(answers.at(-1)).toMatchObject({ type: "error", code: "BAD_REQUEST", topic: topics.at(-1) });
  // A topic it already follows still answers.
  live.ws.send(JSON.stringify({ type: "subscribe", topic: topics[0] }));
  expect(await live.next()).toEqual({ type: "subscribed", topic: topics[0] as `node:${string}` });
  live.ws.close();
});

test("an open tab's socket checks do not slide its session; only requests do", async () => {
  const { user, cookie } = await createUser(panel, "owner");
  const day = 24 * 3600 * 1000;
  const back = (ms: number) => new Date(Date.now() - ms);
  // Signed in 29 days ago and idle since: one day of the 30-day idle window left.
  panel.deps.db
    .update(sessions)
    .set({ createdAt: back(29 * day), lastSeenAt: back(29 * day), expiresAt: new Date(Date.now() + day) })
    .where(eq(sessions.userId, user.id))
    .run();
  const row = () => panel.deps.db.select().from(sessions).where(eq(sessions.userId, user.id)).get();
  const before = row();

  const live = openLive(cookie);
  await live.opened;
  live.ws.send(JSON.stringify({ type: "subscribe", topic: "panel" }));
  expect(await live.next()).toEqual({ type: "subscribed", topic: "panel" });
  // The 15 s revalidation, as it runs for every open socket.
  panel.deps.live.recheck({ userId: user.id });
  // Before: expiresAt moved 30 days out and lastSeenAt to now, with nobody using the tab.
  expect(row()?.expiresAt).toEqual(before?.expiresAt as Date);
  expect(row()?.lastSeenAt).toEqual(before?.lastSeenAt as Date);

  // A day and a bit of such checks later, the idle session is gone.
  const credentials = { sessionToken: cookie.split("=")[1]?.split(";")[0], sessionKey: sessionKeyOf(cookie) };
  let principal = authenticate(panel.deps.db, credentials, new Date(), { touch: false });
  expect(principal.type).toBe("session");
  for (let t = Date.now(); t < Date.now() + 1.1 * day; t += 3600 * 1000)
    principal = authenticate(panel.deps.db, credentials, new Date(t), { touch: false });
  expect(principal.type).toBe("anonymous");

  // A request is a use and slides it (checked on a fresh session).
  const other = await createUser(panel, "owner");
  panel.deps.db
    .update(sessions)
    .set({ lastSeenAt: back(2 * day), expiresAt: new Date(Date.now() + day) })
    .where(eq(sessions.userId, other.user.id))
    .run();
  expect((await callOp(panel, auth.listSessions, {}, { cookie: other.cookie })).status).toBe(200);
  const slid = panel.deps.db.select().from(sessions).where(eq(sessions.userId, other.user.id)).get();
  expect(slid?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * day);
  live.ws.close();
});

test("the hub tells when a topic gets its first follower and loses its last, however they leave", () => {
  const hub = createLiveHub();
  const seen: string[] = [];
  const remove = hub.onTopicActive((topic, active) => seen.push(`${topic} ${active ? "on" : "off"}`));
  const a = { id: "a", send: () => {} };
  const b = { id: "b", send: () => {} };
  const topic = "node-live:nodedefsn1000001" as const;
  hub.subscribe(a, topic);
  hub.subscribe(a, topic);
  hub.subscribe(b, topic);
  expect(hub.subscribers(topic)).toBe(2);
  hub.unsubscribe(a, topic);
  hub.unsubscribe(a, topic);
  hub.drop(b);
  hub.subscribe(a, topic);
  hub.unsubscribe(a, "panel");
  hub.drop(a);
  remove();
  hub.subscribe(a, topic);
  expect(seen).toEqual([`${topic} on`, `${topic} off`, `${topic} on`, `${topic} off`]);
  expect(hub.subscribers("panel")).toBe(0);
});
