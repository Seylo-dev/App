// Host shells: only the owner turns them on (fresh browser session); only
// owners and admins open one, from a fresh browser session, never with an
// API key or over MCP; at most two per node; every open and close is in the
// audit log with who, the node and how long; opening one raises a
// security_change alert; turning them off closes open ones; the setting
// reaches the agent, which refuses on its own too.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { allOps, hostShell } from "@seylo/ops";
import { StatusCode } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { alerts, auditLog, hostShellSessions, sessions } from "../src/db/schema";
import { closeLeftovers, restartReason } from "../src/modules/hostShell/sessions";
import { startTerminal } from "../src/modules/terminals";
import { type FakeAgent, FakeStatus } from "./fake-agent";
import { callOp, createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
const agents: FakeAgent[] = [];
const sockets: WebSocket[] = [];

beforeEach(async () => {
  panel = testPanel();
  url = listen(panel);
  owner = await createUser(panel, "owner");
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

async function join() {
  const agent = await joinAgent(panel, url, { facts: { hostname: "edge-1" } });
  agents.push(agent);
  return agent;
}

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

const stale = (userId: string) =>
  panel.deps.db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - 20 * 60_000), reauthAt: null })
    .where(eq(sessions.userId, userId))
    .run();

/** A fake agent shell: echoes input, "exit\n" ends it with code 0. */
function echoShell(agent: FakeAgent) {
  agent.handleStream("HostShell", async (_first, stream) => {
    await stream.send({ message: { case: "info", value: { user: "root", workingDir: "/root", hostname: "edge-1", command: ["-bash"] } } });
    for (;;) {
      const msg = (await stream.recv()) as { message: { case: string; value: any } } | null;
      if (!msg) return;
      if (msg.message.case !== "input") continue;
      const text = new TextDecoder().decode(msg.message.value);
      if (text === "exit\n") {
        await stream.send({ message: { case: "exitCode", value: 0 } });
        return;
      }
      await stream.send({ message: { case: "output", value: new TextEncoder().encode(`# ${text}`) } });
    }
  });
}

function connect(path: string) {
  const ws = new WebSocket(`${url.replace("http", "ws")}${path}`);
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  const text: string[] = [];
  const control: { type: string; reason?: string; exitCode?: number; user?: string; workdir?: string }[] = [];
  let closed: number | null = null;
  ws.onmessage = (e) => {
    if (typeof e.data === "string") control.push(JSON.parse(e.data));
    else text.push(new TextDecoder().decode(e.data as ArrayBuffer));
  };
  ws.onclose = (e) => {
    closed = e.code;
  };
  const opened = new Promise((resolve) => {
    ws.onopen = resolve;
  });
  return { ws, text, control, opened, closed: () => closed };
}

async function until(what: string, cond: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("turning host shells on", () => {
  test("only the owner, from a fresh browser session; admins and keys may only turn them off", async () => {
    const agent = await join();
    const admin = await createUser(panel, "admin");
    const set = (enabled: boolean, opts: { cookie?: string; bearer?: string }) =>
      callOp(panel, hostShell.setEnabled, { nodeId: agent.nodeId, enabled }, opts);

    const byAdmin = await set(true, { cookie: admin.cookie });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.message).toContain("Only the owner");
    const key = createApiKey(panel, owner.user.id);
    expect((await set(true, { bearer: key })).status).toBe(403);
    stale(owner.user.id);
    const staleRes = await set(true, { cookie: owner.cookie });
    expect(staleRes.body.error.details?.reason).toBe("reauth");

    const fresh = await createUser(panel, "owner");
    const syncs = agent.requests("SyncDesired").length;
    expect(await ok(set(true, { cookie: fresh.cookie }))).toEqual({ nodeId: agent.nodeId, enabled: true });
    await panel.deps.agents.desired.settled();
    expect((await agent.waitFor("SyncDesired", syncs + 1)).at(-1).state.settings.hostShell).toBe(true);
    const security = panel.deps.db.select().from(alerts).where(eq(alerts.event, "security_change")).all();
    expect(security).toHaveLength(1);
    expect(security[0]?.title).toMatch(/^owner: allowed root shells on /);

    // Turning off is open to admins and keys: it only takes access away.
    expect((await ok(set(false, { bearer: key }))).enabled).toBe(false);
    expect((await ok(set(false, { cookie: admin.cookie }))).enabled).toBe(false);
    expect(panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.setEnabled")).all().length).toBeGreaterThanOrEqual(3);
  });
});

describe("opening a host shell", () => {
  async function enabledNode() {
    const agent = await join();
    await ok(callOp(panel, hostShell.setEnabled, { nodeId: agent.nodeId, enabled: true }, { cookie: owner.cookie }));
    echoShell(agent);
    return agent;
  }

  test("refused for members, API keys, MCP, stale sessions and nodes where it is off", async () => {
    const agent = await join();
    const member = await createUser(panel, "member");
    const open = (opts: { cookie?: string; bearer?: string }) => callOp(panel, hostShell.open, { nodeId: agent.nodeId }, opts);

    const off = await open({ cookie: owner.cookie });
    expect(off.status).toBe(409);
    expect(off.body.error.details?.reason).toBe("hostShellOff");
    await ok(callOp(panel, hostShell.setEnabled, { nodeId: agent.nodeId, enabled: true }, { cookie: owner.cookie }));

    expect((await open({ cookie: member.cookie })).status).toBe(403);
    const key = createApiKey(panel, owner.user.id);
    const byKey = await open({ bearer: key });
    expect(byKey.status).toBe(403);
    expect(byKey.body.error.message).toContain("browser session");
    expect(allOps.find((op) => op.id === "hostShell.open")?.mcp).toBe(false);
    expect(allOps.find((op) => op.id === "hostShell.setEnabled")?.mcp).toBe(false);

    const admin = await createUser(panel, "admin");
    stale(admin.user.id);
    expect((await open({ cookie: admin.cookie })).body.error.details?.reason).toBe("reauth");
    // A fresh admin may open one.
    const freshAdmin = await createUser(panel, "admin");
    expect((await open({ cookie: freshAdmin.cookie })).status).toBe(200);
  });

  test("relays the shell, audits open and close with the duration, and alerts the owner", async () => {
    const agent = await enabledNode();
    const ticket = await ok(callOp(panel, hostShell.open, { nodeId: agent.nodeId, columns: 90, rows: 30 }, { cookie: owner.cookie }));
    expect(ticket).toMatchObject({ nodeId: agent.nodeId, idleTimeoutSeconds: 900 });
    const c = connect(ticket.url);
    await c.opened;
    c.ws.send(new TextEncoder().encode("hostname\n"));
    await until("echo", () => c.text.join("").includes("# hostname"));
    expect(c.control[0]).toMatchObject({ type: "ready", user: "root", workdir: "/root" });

    const first = agent.requests("HostShell")[0];
    expect(first.message.value).toMatchObject({ size: { columns: 90, rows: 30 } });
    expect(first.message.value.openedBy).toContain(owner.user.email);

    const status = await ok(callOp(panel, hostShell.status, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(status).toMatchObject({ enabled: true, available: true, canOpen: true, canEnable: true, maxSessions: 2 });
    expect(status.sessions).toHaveLength(1);
    // Recorded while open, for the close after a panel restart.
    expect(
      panel.deps.db
        .select()
        .from(hostShellSessions)
        .all()
        .map((r) => r.id),
    ).toEqual([status.sessions[0]?.id ?? ""]);

    const opened = panel.deps.db
      .select()
      .from(alerts)
      .where(eq(alerts.event, "security_change"))
      .all()
      .filter((a) => a.title.includes("opened a root shell"));
    expect(opened).toHaveLength(1);

    c.ws.send(new TextEncoder().encode("exit\n"));
    await until("exit", () => c.control.some((m) => m.type === "exit"));
    await until(
      "the close audit",
      () => panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.close")).all().length === 1,
    );
    const close = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.close")).get();
    expect(close).toMatchObject({ actorId: owner.user.id, outcome: "ok" });
    const closed = close?.input as { nodeId: string; reason: string; durationSeconds: number } | undefined;
    expect(closed).toMatchObject({ nodeId: agent.nodeId, reason: "exited" });
    expect(typeof closed?.durationSeconds).toBe("number");
    expect(panel.deps.db.select().from(hostShellSessions).all()).toHaveLength(0);
    const openAudit = panel.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.opId, "hostShell.open"), eq(auditLog.actorId, owner.user.id)))
      .get();
    expect(openAudit?.input).toMatchObject({ nodeId: agent.nodeId });
    expect(JSON.stringify(openAudit)).not.toContain(ticket.ticket);

    // Tickets are single use.
    const again = connect(ticket.url);
    await until("refusal", () => again.closed() !== null);
    expect(again.closed()).toBe(4401);
  });

  test("at most two per node, and turning host shells off closes them", async () => {
    const agent = await enabledNode();
    const a = await ok(callOp(panel, hostShell.open, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    const b = await ok(callOp(panel, hostShell.open, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    const third = await callOp(panel, hostShell.open, { nodeId: agent.nodeId }, { cookie: owner.cookie });
    expect(third.status).toBe(409);
    expect(third.body.error.details?.reason).toBe("tooMany");

    const ca = connect(a.url);
    const cb = connect(b.url);
    await Promise.all([ca.opened, cb.opened]);
    await until("two sessions", () => agent.requests("HostShell").length === 2);

    await ok(callOp(panel, hostShell.setEnabled, { nodeId: agent.nodeId, enabled: false }, { cookie: owner.cookie }));
    await until("both closed", () => ca.closed() !== null && cb.closed() !== null);
    expect(ca.control.some((m) => m.type === "closed" && m.reason?.includes("turned off"))).toBe(true);
    await until(
      "two close audits",
      () => panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.close")).all().length === 2,
    );
    for (const row of panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.close")).all()) {
      expect((row.input as { reason: string }).reason).toBe("Host shells were turned off for this node.");
    }
    const status = await ok(callOp(panel, hostShell.status, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(status).toMatchObject({ enabled: false, sessions: [] });
  });

  test("a shell the node refuses raises no alert, is never listed and is audited as refused", async () => {
    const agent = await join();
    await ok(callOp(panel, hostShell.setEnabled, { nodeId: agent.nodeId, enabled: true }, { cookie: owner.cookie }));
    agent.handleStream("HostShell", async () => {
      throw new FakeStatus(
        StatusCode.PERMISSION_DENIED,
        "host shells are turned off on this node: this node's config.yml sets no_host_shell",
      );
    });
    const ticket = await ok(callOp(panel, hostShell.open, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    const c = connect(ticket.url);
    await until("refusal", () => c.closed() !== null);
    expect(c.control.at(-1)).toMatchObject({ type: "closed", reason: expect.stringContaining("no_host_shell") });
    await until(
      "the close audit",
      () => panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.close")).all().length === 1,
    );
    const close = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.close")).get();
    expect((close?.input as { reason?: string } | undefined)?.reason).toBe(
      "refused by the node: host shells are turned off on this node: this node's config.yml sets no_host_shell",
    );
    const opened = panel.deps.db
      .select()
      .from(alerts)
      .where(eq(alerts.event, "security_change"))
      .all()
      .filter((a) => a.title.includes("opened a root shell"));
    expect(opened).toHaveLength(0);
    const status = await ok(callOp(panel, hostShell.status, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(status.sessions).toEqual([]);
    expect(panel.deps.db.select().from(hostShellSessions).all()).toHaveLength(0);
  });

  test("a shell is listed and alerted only once the agent answered", async () => {
    const agent = await join();
    await ok(callOp(panel, hostShell.setEnabled, { nodeId: agent.nodeId, enabled: true }, { cookie: owner.cookie }));
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    agent.handleStream("HostShell", async (_first, stream) => {
      await answered;
      await stream.send({ message: { case: "info", value: { user: "deploy", workingDir: "/home/deploy", hostname: "edge-1" } } });
      while (await stream.recv()) {
        // until the panel hangs up
      }
    });
    const ticket = await ok(callOp(panel, hostShell.open, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    const c = connect(ticket.url);
    await c.opened;
    await until("the agent stream", () => agent.requests("HostShell").length === 1);
    const alerted = () =>
      panel.deps.db
        .select()
        .from(alerts)
        .where(eq(alerts.event, "security_change"))
        .all()
        .filter((a) => a.title.includes("opened a root shell")).length;
    const listed = async () =>
      (await ok(callOp(panel, hostShell.status, { nodeId: agent.nodeId }, { cookie: owner.cookie }))).sessions.length;
    expect(await listed()).toBe(0);
    expect(alerted()).toBe(0);
    // Not listed yet, but counted: the cap holds while the agent answers.
    expect(panel.deps.db.select().from(hostShellSessions).all()).toHaveLength(1);

    answer();
    await until("ready", () => c.control.some((m) => m.type === "ready"));
    // The label follows the agent's user, not an assumed root.
    expect(c.control.find((m) => m.type === "ready")).toMatchObject({ user: "deploy", workdir: "/home/deploy" });
    await until("the alert", () => alerted() === 1);
    expect(await listed()).toBe(1);
  });

  test("the next start records the close of shells a panel restart ended", async () => {
    const openedAt = new Date(Date.now() - 10 * 60_000);
    const lastSeenAt = new Date(Date.now() - 7 * 60_000);
    panel.deps.db
      .insert(hostShellSessions)
      .values({
        id: "hs-left",
        nodeId: "node-gone",
        nodeName: "edge-9",
        userId: owner.user.id,
        authSessionId: "s-1",
        openedBy: "owner",
        email: owner.user.email,
        role: "owner",
        ip: "203.0.113.9",
        userAgent: "test",
        openedAt,
        lastSeenAt,
      })
      .run();
    expect(closeLeftovers(panel.deps.db)).toBe(1);
    expect(panel.deps.db.select().from(hostShellSessions).all()).toHaveLength(0);
    const close = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "hostShell.close")).get();
    expect(close).toMatchObject({ actorId: owner.user.id, ip: "203.0.113.9" });
    expect(close?.input).toMatchObject({
      nodeId: "node-gone",
      nodeName: "edge-9",
      sessionId: "hs-left",
      reason: restartReason,
      durationSeconds: 180,
    });
    // Once only.
    expect(closeLeftovers(panel.deps.db)).toBe(0);
  });

  test("a session ends when its sign-in ends", async () => {
    const agent = await enabledNode();
    const ticket = await ok(callOp(panel, hostShell.open, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    // Signed out between the ticket and the socket.
    panel.deps.db.delete(sessions).where(eq(sessions.userId, owner.user.id)).run();
    const c = connect(ticket.url);
    await until("refusal", () => c.closed() !== null);
    expect(c.control.at(-1)).toMatchObject({ type: "closed", reason: "The browser session ended." });
    expect(agent.requests("HostShell")).toHaveLength(0);
  });
});

test("the relay closes a host shell after its idle time", async () => {
  const sent: string[] = [];
  let cancelled = "";
  let closedWith: [number, string] | null = null;
  let ended = "";
  const never = new Promise<never>(() => {});
  const stream = {
    [Symbol.asyncIterator]: () => ({ next: () => never }),
    done: never,
    cancel: (reason: string) => {
      cancelled = reason;
    },
    send: async () => {},
  };
  const deps = { agents: { open: () => stream } } as unknown as Parameters<typeof startTerminal>[0];
  startTerminal(
    deps,
    {
      mode: "host",
      serviceId: "",
      nodeId: "n",
      containerId: "",
      generation: 0,
      tail: 0,
      command: [],
      user: "root",
      databaseClient: false,
      columns: 80,
      rows: 24,
      idleSeconds: 0.05,
    },
    {
      sendBytes: () => {},
      sendControl: (m) => sent.push(m.type),
      close: (code, reason) => {
        closedWith = [code, reason];
      },
    },
    { onEnd: (reason) => (ended = reason) },
  );
  await until("idle close", () => closedWith !== null);
  expect(cancelled).toBe("idle");
  expect(ended).toBe("idle");
  expect(sent).toEqual(["ready", "closed"]);
});
