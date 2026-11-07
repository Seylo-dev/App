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
import { aiConversations, sessions } from "../src/db/schema";
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
