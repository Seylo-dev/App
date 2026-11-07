// Security events reach the process log (one warning per failed sign-in,
// lock, refusal, and per rejected agent with its address), the audit table
// keeps at most a fixed number of anonymous failures per hour, and old
// entries are pruned by the retention setting while security changes stay.

import { afterEach, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { auth, settings as settingsOps, users as userOps } from "@seylo/ops";
import { ClientHelloSchema, CONNECTION_STREAM, encodeFrame, FrameKind, HandshakeSchema, parseFrame } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { agentConnectPath, agentSubprotocol } from "../src/agent-hub/endpoint";
import { apiKeys, auditLog } from "../src/db/schema";
import { createProxyTrust } from "../src/http/proxy-trust";
import { pruneAudit, writeAuditRetentionDays } from "../src/modules/audit/retention";
import { anonymousErrorRows } from "../src/ops/audit";
import { hashToken, prefixedToken } from "../src/security/tokens";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits } from "./people-helpers";

type Line = Record<string, unknown> & { level: number; msg: string };

const panels: TestPanel[] = [];
afterEach(async () => {
  for (const p of panels.splice(0)) {
    if (p.app.server) await p.app.stop(true);
    p.close();
  }
});

function make() {
  const lines: Line[] = [];
  const logger = pino({ level: "info", base: undefined }, { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Line) });
  const panel = testPanel({ logger, rateLimiter: noLimits, proxy: createProxyTrust({ always: true, proxies: [] }) });
  panels.push(panel);
  const warnings = (opId?: string) => lines.filter((l) => l.level === 40 && (opId === undefined || l.opId === opId));
  return { panel, lines, warnings };
}

const from = (ip: string) => ({ headers: { "x-forwarded-for": ip } });

describe("process log", () => {
  test("a wrong password, a lock and a refused op each log one warning with the address and op", async () => {
    const { panel, warnings } = make();
    const { user } = await createUser(panel, "owner");

    await call(panel, auth.login, { email: user.email, password: "hunter2-secret" }, from("198.51.100.3"));
    expect(warnings("auth.login")).toHaveLength(1);
    expect(warnings("auth.login")[0]).toMatchObject({ ip: "198.51.100.3", actor: user.email, code: "UNAUTHENTICATED" });
    expect(warnings("auth.login")[0]?.msg).toStartWith("sign-in failed");
    expect(JSON.stringify(warnings())).not.toContain("hunter2");

    for (let i = 0; i < 4; i++) await call(panel, auth.login, { email: user.email, password: "wrong" }, from("198.51.100.3"));
    const locked = await call(panel, auth.login, { email: user.email, password: "wrong" }, from("198.51.100.3"));
    expect(locked.status).toBe(429);
    const last = warnings("auth.login").at(-1);
    expect(last).toMatchObject({ ip: "198.51.100.3", code: "RATE_LIMITED", reason: "locked" });
    expect(warnings("auth.login")).toHaveLength(6);

    const member = await createUser(panel, "member");
    const refused = await call(panel, userOps.list, {}, { cookie: member.cookie, ...from("203.0.113.7") });
    expect(refused.status).toBe(403);
    expect(warnings("users.list")).toHaveLength(1);
    expect(warnings("users.list")[0]).toMatchObject({ ip: "203.0.113.7", actor: member.user.email, code: "FORBIDDEN" });
    expect(warnings("users.list")[0]?.msg).toStartWith("op refused");
  });

  test("ordinary successes and validation errors log no warning", async () => {
    const { panel, warnings } = make();
    const { user, password } = await createUser(panel, "owner");
    expect((await call(panel, auth.login, { email: user.email, password }, from("198.51.100.3"))).status).toBe(200);
    expect((await call(panel, auth.login, { email: "not an email", password: "x" }, from("198.51.100.3"))).status).toBe(400);
    expect(warnings()).toHaveLength(0);
  });

  test("a rejected agent hello names the address it came from", async () => {
    const { panel, lines } = make();
    panel.app.listen({ hostname: "127.0.0.1", port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${panel.app.server!.port}${agentConnectPath}`, [agentSubprotocol]);
    ws.binaryType = "arraybuffer";
    const frames: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    ws.onmessage = (event) => {
      frames.push(parseFrame(new Uint8Array(event.data as ArrayBuffer)).payload);
      wake?.();
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    while (frames.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    const serverHello = fromBinary(HandshakeSchema, frames.shift() as Uint8Array);
    if (serverHello.step.case !== "serverHello") throw new Error("expected ServerHello");
    const hello = create(ClientHelloSchema, {
      agentVersion: "1.0.0",
      credential: {
        case: "join",
        value: { token: "no-such-token", publicKey: new Uint8Array(32), signature: new Uint8Array(64), requestedName: "x" },
      },
    });
    ws.send(
      encodeFrame({
        kind: FrameKind.EVENT,
        stream: CONNECTION_STREAM,
        payload: toBinary(HandshakeSchema, create(HandshakeSchema, { step: { case: "clientHello", value: hello } })),
      }),
    );
    for (let i = 0; i < 50 && !lines.some((l) => l.msg === "agent rejected"); i++) await Bun.sleep(10);
    expect(lines.find((l) => l.msg === "agent rejected")).toMatchObject({ level: 40, remoteIp: "127.0.0.1" });
    ws.close();
  });
});

describe("audit table", () => {
  test("anonymous failures are stored up to the hourly cap, then only logged once", async () => {
    const saved = anonymousErrorRows.perHour;
    anonymousErrorRows.perHour = 5;
    try {
      const { panel, lines } = make();
      for (let i = 0; i < 8; i++)
        await call(panel, auth.login, { email: `nobody${i}@example.com`, password: "wrong" }, from(`198.51.100.${i}`));
      const rows = panel.deps.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.opId, "auth.login"), eq(auditLog.outcome, "error")))
        .all();
      expect(rows).toHaveLength(5);
      expect(lines.filter((l) => String(l.msg).startsWith("audit: anonymous failures over the hourly cap"))).toHaveLength(1);
      // Signed-in people's entries are not capped.
      const owner = await createUser(panel, "owner");
      expect((await call(panel, userOps.list, {}, { cookie: owner.cookie })).status).toBe(200);
    } finally {
      anonymousErrorRows.perHour = saved;
    }
  });

  test("old entries go by the retention setting; successful security changes stay", async () => {
    const { panel } = make();
    const db = panel.deps.db;
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 24 * 3600 * 1000);
    const row = (opId: string, at: Date, outcome: "ok" | "error" = "ok") =>
      db
        .insert(auditLog)
        .values({
          at,
          actorType: "user",
          actorLabel: "x",
          opId,
          input: {},
          outcome,
          errorCode: outcome === "error" ? "FORBIDDEN" : null,
          durationMs: 1,
        })
        .returning({ id: auditLog.id })
        .get().id;
    const oldChange = row("projects.create", daysAgo(400));
    const oldSignIn = row("auth.login", daysAgo(400));
    const oldFailedSignIn = row("auth.login", daysAgo(400), "error");
    const oldKey = row("apiKeys.create", daysAgo(400));
    const oldJoinToken = row("nodes.createJoinToken", daysAgo(400));
    const recent = row("projects.create", daysAgo(10));
    const ids = () =>
      new Set(
        db
          .select({ id: auditLog.id })
          .from(auditLog)
          .all()
          .map((r) => r.id),
      );

    expect(pruneAudit(db, now)).toBe(2);
    const left = ids();
    expect(left.has(oldChange)).toBe(false);
    expect(left.has(oldFailedSignIn)).toBe(false);
    for (const id of [oldSignIn, oldKey, oldJoinToken, recent]) expect(left.has(id)).toBe(true);

    // Kept forever: nothing goes.
    const ancient = row("projects.update", daysAgo(5000));
    writeAuditRetentionDays(db, null);
    expect(pruneAudit(db, now)).toBe(0);
    // Thirty days: the ten-day-old entry stays, the ancient one goes.
    writeAuditRetentionDays(db, 30);
    pruneAudit(db, now);
    expect(ids().has(ancient)).toBe(false);
    expect(ids().has(recent)).toBe(true);
  });

  test("admins set the retention in general settings, within 30 days and 10 years", async () => {
    const { panel } = make();
    const owner = await createUser(panel, "owner");
    const before = await call(panel, settingsOps.general, {}, { cookie: owner.cookie });
    expect(before.body.auditRetentionDays).toBe(365);
    expect((await call(panel, settingsOps.updateGeneral, { auditRetentionDays: 10 }, { cookie: owner.cookie })).status).toBe(400);
    const saved = await call(panel, settingsOps.updateGeneral, { auditRetentionDays: null }, { cookie: owner.cookie });
    expect(saved.status).toBe(200);
    expect(saved.body.auditRetentionDays).toBeNull();
    const member = await createUser(panel, "member");
    expect((await call(panel, settingsOps.updateGeneral, { auditRetentionDays: 90 }, { cookie: member.cookie })).status).toBe(403);
    // MCP tokens cannot shorten it (that deletes history), even with write access.
    const token = prefixedToken("mcp");
    panel.deps.db
      .insert(apiKeys)
      .values({
        userId: owner.user.id,
        name: "m",
        kind: "mcp",
        prefix: token.slice(0, 12),
        tokenHash: hashToken(token),
        actions: ["*"],
        readOnly: false,
      })
      .run();
    const viaMcp = await call(panel, settingsOps.updateGeneral, { auditRetentionDays: 30 }, { bearer: token });
    expect(viaMcp.status).toBe(403);
    expect((await call(panel, settingsOps.general, {}, { cookie: owner.cookie })).body.auditRetentionDays).toBeNull();
  });
});
