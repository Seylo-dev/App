// Notification channels and alerts: formatting per channel kind (against a
// recording HTTP server and fake io), sealed secrets that never come back,
// test sends, rules, mutes, delivery jobs and the alert feed.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { alerts as alertOps, notifications } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { nodes, notificationChannels, notificationDeliveries, projects, services } from "../src/db/schema";
import {
  DeliveryError,
  deliver,
  type MailMessage,
  type Notice,
  resetNotifyIo,
  setNotifyIo,
  webhookSignature,
} from "../src/modules/notifications/senders";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

interface Received {
  path: string;
  headers: Headers;
  body: string;
}

let server: ReturnType<typeof Bun.serve>;
const received: Received[] = [];
let answer = { status: 204, body: "" };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers: request.headers,
        body: await request.text(),
      });
      return new Response(answer.body || null, { status: answer.status });
    },
  });
});
afterAll(() => server.stop(true));

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
  received.length = 0;
  answer = { status: 204, body: "" };
});
afterEach(() => {
  resetNotifyIo();
  panel.close();
});

const base = () => `http://127.0.0.1:${server.port}`;

const notice: Notice = {
  type: "alert",
  event: "crash",
  severity: "error",
  title: "api crashed",
  message: "Exit code 137 <oom> & co",
  link: "https://panel.example.com/p/a/s/b",
  panelName: "Acme",
  panelUrl: "https://panel.example.com",
  at: new Date("2026-11-05T10:00:00Z"),
  alertId: "a".repeat(16),
  projectId: null,
  serviceId: "b".repeat(16),
  nodeId: null,
};

test("webhook: JSON body, timestamp and HMAC signature over timestamp.body", async () => {
  await deliver({ kind: "webhook", url: `${base()}/hook`, signingSecret: "s3cret" }, notice);
  const [request] = received;
  const body = JSON.parse(request!.body);
  expect(body).toMatchObject({ type: "alert", event: "crash", severity: "error", title: "api crashed", panel: { name: "Acme" } });
  const timestamp = request!.headers.get("x-seylo-timestamp")!;
  expect(timestamp).toBe(String(notice.at.getTime() / 1000));
  expect(request!.headers.get("x-seylo-signature")).toBe(webhookSignature("s3cret", timestamp, request!.body));
});

test("discord, slack, ntfy and gotify bodies", async () => {
  await deliver({ kind: "discord", webhookUrl: `${base()}/discord` }, notice);
  await deliver({ kind: "slack", webhookUrl: `${base()}/slack` }, notice);
  await deliver({ kind: "ntfy", serverUrl: base(), topic: "ops", accessToken: "tk" }, notice);
  await deliver({ kind: "gotify", serverUrl: `${base()}/`, appToken: "gt" }, notice);
  const [discord, slack, ntfy, gotify] = received.map((r) => ({ ...r, json: JSON.parse(r.body) }));

  expect(discord!.json.embeds[0]).toMatchObject({ title: "api crashed", color: 0xdc2626, url: notice.link });
  expect(discord!.json.allowed_mentions).toEqual({ parse: [] });
  expect(slack!.json.blocks[0].text.text).toContain("Exit code 137 &lt;oom&gt; &amp; co");
  expect(slack!.json.text).toContain("api crashed");
  expect(ntfy!.path).toBe("/");
  expect(ntfy!.headers.get("authorization")).toBe("Bearer tk");
  expect(ntfy!.json).toMatchObject({ topic: "ops", title: "api crashed", priority: 5, click: notice.link });
  expect(gotify!.path).toBe("/message");
  expect(gotify!.headers.get("x-gotify-key")).toBe("gt");
  expect(gotify!.json.priority).toBe(8);
});

test("telegram and pushover go to their fixed APIs", async () => {
  const calls: { url: string; body: string }[] = [];
  setNotifyIo({
    fetch: async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return new Response("{}", { status: 200 });
    },
  });
  await deliver({ kind: "telegram", botToken: "123:abc", chatId: "-100" }, notice);
  await deliver({ kind: "pushover", userKey: "u", appToken: "t" }, notice);
  expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
  const telegram = JSON.parse(calls[0]!.body);
  expect(telegram).toMatchObject({ chat_id: "-100", parse_mode: "HTML" });
  expect(telegram.text).toContain("<b>Error: api crashed</b>");
  expect(telegram.text).toContain("&lt;oom&gt;");
  expect(calls[1]!.url).toBe("https://api.pushover.net/1/messages.json");
  expect(new URLSearchParams(calls[1]!.body).get("priority")).toBe("1");
});

test("smtp builds a text and HTML mail", async () => {
  const sent: MailMessage[] = [];
  setNotifyIo({ smtp: () => ({ sendMail: async (m) => void sent.push(m) }) });
  await deliver(
    {
      kind: "smtp",
      host: "smtp.test",
      port: 587,
      security: "starttls",
      username: "u",
      password: "p",
      from: "panel@x.io",
      to: ["ops@x.io"],
    },
    notice,
  );
  expect(sent[0]).toMatchObject({ from: "panel@x.io", to: ["ops@x.io"], subject: "[Acme] api crashed" });
  expect(sent[0]!.html).toContain("&lt;oom&gt;");
});

test("a refused delivery says what the receiver answered, without the URL", async () => {
  answer = { status: 404, body: `{"message": "Unknown Webhook", "url": "${base()}/discord/secret"}` };
  const error = await deliver({ kind: "discord", webhookUrl: `${base()}/discord/secret` }, notice).catch((e) => e);
  expect(error).toBeInstanceOf(DeliveryError);
  expect(error.message).toContain("Discord answered 404");
  expect(error.message).not.toContain("secret");
});

test("channels: secrets are sealed, never returned, kept on update; at most one default", async () => {
  const { cookie } = await createUser(panel, "owner");
  const created = await callOp(
    panel,
    notifications.createChannel,
    { name: "Ops Discord", config: { kind: "discord", webhookUrl: `${base()}/discord/tok` }, isDefault: true },
    { cookie },
  );
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ kind: "discord", isDefault: true, secretsSet: ["webhookUrl"], config: { kind: "discord" } });
  expect(JSON.stringify(created.body)).not.toContain("/discord/tok");
  const row = panel.deps.db.select().from(notificationChannels).get();
  expect(row?.configSealed).not.toContain("discord/tok");

  // A webhook without a URL is refused on create.
  const missing = await callOp(panel, notifications.createChannel, { name: "x", config: { kind: "slack" } }, { cookie });
  expect(missing.status).toBe(400);

  // Rename only: the stored URL stays, and the test send uses it.
  const renamed = await callOp(
    panel,
    notifications.updateChannel,
    { channelId: created.body.id, name: "Discord", config: { kind: "discord" } },
    { cookie },
  );
  expect(renamed.body.secretsSet).toEqual(["webhookUrl"]);
  const tested = await callOp(panel, notifications.testChannel, { channelId: created.body.id }, { cookie });
  expect(tested.body).toMatchObject({ ok: true, error: null });
  expect(received.at(-1)?.path).toBe("/discord/tok");

  const second = await callOp(
    panel,
    notifications.createChannel,
    { name: "Hook", config: { kind: "webhook", url: `${base()}/hook?token=abc` }, isDefault: true },
    { cookie },
  );
  // Only scheme and host: catch-hook paths carry the hook's secret.
  expect(second.body.config.url).toBe(`${base()}/...`);
  const list = await callOp(panel, notifications.channels, {}, { cookie });
  expect(list.body.channels.filter((c: { isDefault: boolean }) => c.isDefault)).toHaveLength(1);
  expect(list.body.channels[0].lastDelivery).toMatchObject({ status: "sent" });

  // Members may list channels but not change them.
  const member = await createUser(panel, "member");
  expect((await callOp(panel, notifications.channels, {}, { cookie: member.cookie })).status).toBe(200);
  expect((await callOp(panel, notifications.deleteChannel, { channelId: second.body.id }, { cookie: member.cookie })).status).toBe(403);
});

test("testing unsaved settings reports the receiver's error", async () => {
  const { cookie } = await createUser(panel, "owner");
  answer = { status: 500, body: "boom" };
  const result = await callOp(panel, notifications.testChannel, { config: { kind: "webhook", url: `${base()}/x` } }, { cookie });
  expect(result.body).toMatchObject({ ok: false, error: "The webhook answered 500: boom" });
});

function seedService() {
  const project = panel.deps.db.insert(projects).values({ name: "Shop", nameKey: "shop" }).returning().get();
  const service = panel.deps.db
    .insert(services)
    .values({ projectId: project.id, name: "api", nameKey: "api", kind: "app", spec: {} })
    .returning()
    .get();
  return { project, service };
}

test("alerts: raised once per key, delivered to the rule's channels, muted ones only recorded", async () => {
  const { cookie } = await createUser(panel, "owner");
  const { service } = seedService();
  const channel = await callOp(
    panel,
    notifications.createChannel,
    { name: "Hook", config: { kind: "webhook", url: `${base()}/alerts` }, isDefault: true },
    { cookie },
  );

  // Before anyone saved defaults, problem events go to the default channel.
  const first = panel.deps.alerts.raise({ event: "crash", key: "crash:x:1", title: "api crashed", serviceId: service.id });
  expect(first).not.toBeNull();
  expect(panel.deps.alerts.raise({ event: "crash", key: "crash:x:1", title: "again" })).toBeNull();
  await panel.runner.runDue(panel.deps);
  const delivered = received.filter((r) => r.path === "/alerts");
  expect(delivered).toHaveLength(1);
  expect(JSON.parse(delivered[0]!.body)).toMatchObject({
    title: "api crashed",
    serviceId: service.id,
    link: expect.stringContaining(`/s/${service.id}`),
  });
  const deliveries = panel.deps.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.alertId, first!)).all();
  expect(deliveries).toMatchObject([{ status: "sent", channelId: channel.body.id }]);

  // The service turns crash alerts off for itself.
  const own = await callOp(
    panel,
    notifications.updateServiceAlerts,
    { serviceId: service.id, useDefaults: false, rules: [{ event: "crash", enabled: false, channelIds: [] }] },
    { cookie },
  );
  expect(own.body.useDefaults).toBe(false);
  panel.deps.alerts.raise({ event: "crash", key: "crash:x:2", title: "api crashed", serviceId: service.id });
  await panel.runner.runDue(panel.deps);
  expect(received.filter((r) => r.path === "/alerts")).toHaveLength(1);

  const nodeRule = await callOp(
    panel,
    notifications.updateServiceAlerts,
    { serviceId: service.id, useDefaults: false, rules: [{ event: "node_offline", enabled: true, channelIds: [] }] },
    { cookie },
  );
  expect(nodeRule.status).toBe(400);

  // Mutes record the alert as muted and notify nobody.
  await callOp(panel, notifications.updateServiceAlerts, { serviceId: service.id, useDefaults: true }, { cookie });
  const muted = await callOp(panel, alertOps.mute, { scopeType: "service", scopeId: service.id, reason: "maintenance" }, { cookie });
  expect(muted.status).toBe(200);
  const third = panel.deps.alerts.raise({ event: "crash", key: "crash:x:3", title: "api crashed", serviceId: service.id });
  await panel.runner.runDue(panel.deps);
  expect(received.filter((r) => r.path === "/alerts")).toHaveLength(1);
  const feed = await callOp(panel, alertOps.list, { serviceId: service.id }, { cookie });
  // By id: alerts raised in the same millisecond have no fixed order (ids are random).
  expect(feed.body.alerts).toHaveLength(3);
  expect(feed.body.alerts.map((a: { id: string; muted: boolean }) => [a.id === third, a.muted]).sort()).toEqual([
    [false, false],
    [false, false],
    [true, true],
  ]);

  // Resolving by prefix closes the incident and records the good news.
  panel.deps.alerts.resolve("crash:x:", { event: "health_recovered", key: "ok:x:1", title: "api is healthy again", serviceId: service.id });
  const unresolved = await callOp(panel, alertOps.list, { serviceId: service.id, unresolvedOnly: true }, { cookie });
  expect(unresolved.body.alerts.map((a: { event: string }) => a.event)).toEqual(["health_recovered"]);
});

test("the alert feed only shows what the caller can see, with keyset paging", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const { project, service } = seedService();
  for (let i = 0; i < 5; i++) panel.deps.alerts.raise({ event: "crash", key: `c:${i}`, title: `crash ${i}`, serviceId: service.id });
  panel.deps.alerts.raise({ event: "update_available", key: "u:1", title: "Update" });

  expect((await callOp(panel, alertOps.list, {}, { cookie: member.cookie })).body.alerts).toHaveLength(0);
  grant(panel, member.user.id, "project", project.id, ["projects.view", "services.view"]);
  const seen = await callOp(panel, alertOps.list, { limit: 3 }, { cookie: member.cookie });
  expect(seen.body.alerts).toHaveLength(3);
  expect(seen.body.nextCursor).not.toBeNull();
  const rest = await callOp(panel, alertOps.list, { limit: 3, cursor: seen.body.nextCursor }, { cookie: member.cookie });
  expect(rest.body.alerts).toHaveLength(2);
  expect(rest.body.nextCursor).toBeNull();
  expect((await callOp(panel, alertOps.list, {}, { cookie: owner.cookie })).body.alerts).toHaveLength(6);
});

test("deps.notify.sendEmail uses the SMTP channel, or says there is none", async () => {
  expect(await panel.deps.notify.sendEmail({ to: "a@b.io", subject: "Hi", text: "x" })).toBe("noChannel");
  const { cookie } = await createUser(panel, "owner");
  await callOp(
    panel,
    notifications.createChannel,
    { name: "Mail", config: { kind: "smtp", host: "smtp.test", port: 25, security: "none", username: "", from: "p@x.io", to: ["o@x.io"] } },
    { cookie },
  );
  const sent: MailMessage[] = [];
  setNotifyIo({ smtp: () => ({ sendMail: async (m) => void sent.push(m) }) });
  expect(await panel.deps.notify.sendEmail({ to: "a@b.io", subject: "Invite", text: "link" })).toBe("sent");
  expect(sent[0]).toMatchObject({ from: "p@x.io", to: ["a@b.io"], subject: "Invite" });
});

test("smtp through the real nodemailer transport to a local SMTP server", async () => {
  const lines: string[] = [];
  let inData = false;
  const smtp = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.write("220 test ESMTP\r\n");
      },
      data(socket, chunk) {
        for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
          lines.push(line);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 queued\r\n");
            }
            continue;
          }
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO" || verb === "HELO") socket.write("250-test\r\n250 OK\r\n");
          else if (verb === "DATA") {
            inData = true;
            socket.write("354 go\r\n");
          } else if (verb === "QUIT") socket.write("221 bye\r\n");
          else socket.write("250 OK\r\n");
        }
      },
    },
  });
  try {
    await deliver(
      { kind: "smtp", host: "127.0.0.1", port: smtp.port, security: "none", username: "", from: "panel@x.io", to: ["ops@x.io"] },
      notice,
    );
    expect(lines).toContain("MAIL FROM:<panel@x.io>");
    expect(lines).toContain("RCPT TO:<ops@x.io>");
    expect(lines.some((l) => l.startsWith("Subject: [Acme] api crashed"))).toBe(true);
  } finally {
    smtp.stop(true);
  }
});

test("crashes alert once per streak, and once more when the agent gives up", async () => {
  const { cookie } = await createUser(panel, "owner");
  const { service } = seedService();
  const { create } = await import("@bufbuild/protobuf");
  const { CrashAction, CrashReportSchema } = await import("@seylo/proto");
  const node = panel.deps.db
    .insert(nodes)
    .values({ name: "a", publicKey: Buffer.alloc(32, 2) })
    .returning()
    .get();
  const crash = (streak: number, action: number, at: number) =>
    panel.deps.agents.emitCrash(
      node.id,
      create(CrashReportSchema, {
        serviceId: service.id,
        exitCode: 137,
        oomKilled: true,
        streak,
        action,
        exitedAt: { seconds: BigInt(at), nanos: 0 },
      }),
      { outboxId: String(at), crashId: String(at) },
    );
  // Real reports are seconds apart; alerts created in the same millisecond have no defined order.
  crash(1, CrashAction.RESTARTING, 1000);
  await Bun.sleep(3);
  crash(2, CrashAction.RESTARTING, 1010);
  await Bun.sleep(3);
  crash(3, CrashAction.GAVE_UP, 1020);
  const feed = await callOp(panel, alertOps.list, { serviceId: service.id }, { cookie });
  expect(feed.body.alerts.map((a: { event: string }) => a.event)).toEqual(["crash_limit", "crash"]);
  expect(feed.body.alerts[1].message).toBe("Out of memory, restarting in a few seconds.");
  // A new streak is a new incident.
  crash(1, CrashAction.RESTARTING, 2000);
  const after = await callOp(panel, alertOps.list, { serviceId: service.id, unresolvedOnly: true }, { cookie });
  expect(after.body.alerts.filter((a: { event: string }) => a.event === "crash")).toHaveLength(1);
});
