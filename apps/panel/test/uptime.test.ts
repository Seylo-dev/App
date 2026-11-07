// Uptime checks against a local HTTP server: status, keyword and latency
// rules, the down/up state machine with its alerts, schedules, history and
// visibility.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { alerts as alertOps, settings as settingsOps, uptime } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { uptimeSamples } from "../src/db/metrics/schema";
import { domains, nodes, projects, services, uptimeChecks } from "../src/db/schema";
import { pinRequest } from "../src/http/pinned-fetch";
import { incidents } from "../src/modules/uptime/history";
import { probe } from "../src/modules/uptime/probe";
import { blockedReason, checkTarget, setTargetResolver } from "../src/modules/uptime/targets";
import { setSetting } from "../src/settings";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";

let server: ReturnType<typeof Bun.serve>;
let reply = { status: 200, body: "all good", delayMs: 0 };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      return new Response(reply.body, { status: reply.status });
    },
  });
});
afterAll(() => server.stop(true));

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
  reply = { status: 200, body: "all good", delayMs: 0 };
  // The test server is on loopback, which checks refuse unless an admin allows internal targets.
  setSetting(panel.deps.db, "uptimeAllowInternalTargets", true);
});
afterEach(() => {
  setTargetResolver(null);
  panel.close();
});

const url = () => `http://127.0.0.1:${server.port}/health`;

function seedService() {
  const project = panel.deps.db.insert(projects).values({ name: "Shop", nameKey: "shop" }).returning().get();
  const service = panel.deps.db
    .insert(services)
    .values({ projectId: project.id, name: "web", nameKey: "web", kind: "app", spec: {} })
    .returning()
    .get();
  return { project, service };
}

test("probe: status, keyword, latency and connection errors", async () => {
  const base = { url: url(), method: "GET" as const, expectedStatus: 200, timeoutMs: 2000, keyword: null, maxLatencyMs: null };
  expect(await probe(base)).toMatchObject({ ok: true, statusCode: 200, error: null });
  expect(await probe({ ...base, keyword: "good" })).toMatchObject({ ok: true });
  // The keyword is never echoed back (it would read the page out character by character).
  expect(await probe({ ...base, keyword: "bad" })).toMatchObject({ ok: false, error: "the keyword is not in the response" });
  reply = { status: 302, body: "", delayMs: 0 };
  expect(await probe({ ...base, expectedStatus: 0 })).toMatchObject({ ok: true, statusCode: 302 });
  expect(await probe(base)).toMatchObject({ ok: false, error: "status 302, expected 200" });
  reply = { status: 200, body: "slow", delayMs: 80 };
  expect((await probe({ ...base, maxLatencyMs: 20 })).error).toContain("limit 20 ms");
  expect(await probe({ ...base, timeoutMs: 20 })).toMatchObject({ ok: false, error: "timeout after 20 ms" });
  const refused = await probe({ ...base, url: "http://127.0.0.1:1/" });
  expect(refused.ok).toBe(false);
  expect(refused.error).toStartWith("could not connect");
});

test("a check goes down after the threshold, alerts once, and comes back up", async () => {
  const { cookie } = await createUser(panel, "owner");
  const { service } = seedService();
  const created = await callOp(
    panel,
    uptime.create,
    { serviceId: service.id, name: "Home page", url: url(), failureThreshold: 2, keyword: "good" },
    { cookie },
  );
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ status: "pending", intervalSeconds: 60, keyword: "good" });
  expect(panel.deps.schedules.get(`uptime:${created.body.id}`)).not.toBeNull();

  // The first probe runs right away.
  await panel.runner.runDue(panel.deps);
  const checkId = created.body.id;
  const read = async () => (await callOp(panel, uptime.list, { serviceId: service.id }, { cookie })).body.checks[0];
  expect(await read()).toMatchObject({ status: "up", lastStatusCode: 200, uptime24h: 100 });

  const { runCheck: run } = await import("../src/modules/uptime/checks");
  // Samples are keyed by millisecond; keep probes apart.
  const runCheck = async (...args: Parameters<typeof run>) => {
    await Bun.sleep(2);
    return run(...args);
  };
  reply = { status: 503, body: "down", delayMs: 0 };
  await runCheck(panel.deps, checkId);
  expect(await read()).toMatchObject({ status: "up", lastError: "status 503, expected 200" });
  await runCheck(panel.deps, checkId);
  await runCheck(panel.deps, checkId);
  expect(await read()).toMatchObject({ status: "down" });
  const feed = await callOp(panel, alertOps.list, { serviceId: service.id }, { cookie });
  expect(feed.body.alerts.map((a: { event: string }) => a.event)).toEqual(["uptime_down"]);

  reply = { status: 200, body: "all good", delayMs: 0 };
  await runCheck(panel.deps, checkId);
  expect(await read()).toMatchObject({ status: "up" });
  const after = await callOp(panel, alertOps.list, { serviceId: service.id }, { cookie });
  expect(after.body.alerts.map((a: { event: string; resolvedAt: string | null }) => [a.event, a.resolvedAt !== null])).toEqual([
    ["uptime_up", false],
    ["uptime_down", true],
  ]);

  const hist = await callOp(panel, uptime.history, { serviceId: service.id, checkId, range: "1h" }, { cookie });
  expect(hist.body.points).toHaveLength(5);
  expect(hist.body.uptimePercent).toBe(40);
  expect(hist.body.incidents).toHaveLength(1);
  expect(hist.body.incidents[0].to).not.toBeNull();
  const week = await callOp(panel, uptime.history, { serviceId: service.id, checkId, range: "7d" }, { cookie });
  expect(week.body.bucketSeconds).toBe(3600);

  expect((await callOp(panel, uptime.status, {}, { cookie })).body).toEqual({ up: 1, down: 0, pending: 0, paused: 0 });

  // Pausing drops the schedule; deleting removes the samples too.
  const paused = await callOp(panel, uptime.update, { serviceId: service.id, checkId, enabled: false }, { cookie });
  expect(paused.body.status).toBe("paused");
  expect(panel.deps.schedules.get(`uptime:${checkId}`)).toBeNull();
  expect((await callOp(panel, uptime.remove, { serviceId: service.id, checkId }, { cookie })).status).toBe(200);
  expect(panel.deps.metrics.select().from(uptimeSamples).where(eq(uptimeSamples.checkId, checkId)).all()).toHaveLength(0);
});

test("HEAD checks cannot use a keyword; members only see their services' checks", async () => {
  const { cookie } = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const { project, service } = seedService();
  const head = await callOp(
    panel,
    uptime.create,
    { serviceId: service.id, name: "x", url: url(), method: "HEAD", keyword: "a" },
    { cookie },
  );
  expect(head.status).toBe(400);
  await callOp(panel, uptime.create, { serviceId: service.id, name: "x", url: url() }, { cookie });
  expect((await callOp(panel, uptime.list, {}, { cookie: member.cookie })).body.checks).toHaveLength(0);
  expect((await callOp(panel, uptime.create, { serviceId: service.id, name: "y", url: url() }, { cookie: member.cookie })).status).toBe(
    403,
  );
  grant(panel, member.user.id, "project", project.id, ["services.view"]);
  expect((await callOp(panel, uptime.list, {}, { cookie: member.cookie })).body.checks).toHaveLength(1);
});

test("incidents pair failures with the next success", () => {
  const s = (at: number, ok: boolean, statusCode: number | null = null) => ({ at, ok, statusCode, latencyMs: 1 });
  expect(incidents([s(1, true), s(2, false, 500), s(3, false), s(4, true), s(5, false)])).toEqual([
    { from: new Date(2).toISOString(), to: new Date(4).toISOString(), error: "status 500" },
    { from: new Date(5).toISOString(), to: null, error: "no answer" },
  ]);
});

test("address classes: loopback, link-local, metadata, private and public", () => {
  const cases: [string, string | null][] = [
    ["127.0.0.1", "loopback"],
    ["127.9.9.9", "loopback"],
    ["::1", "loopback"],
    ["169.254.169.254", "metadata"],
    ["100.100.100.200", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["169.254.10.1", "linkLocal"],
    ["fe80::1%en0", "linkLocal"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["fd12:3456::1", "private"],
    ["0.0.0.0", "reserved"],
    ["::", "reserved"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:7f00:1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "metadata"],
    ["172.32.0.1", null],
    ["8.8.8.8", null],
    ["2606:4700:4700::1111", null],
  ];
  for (const [address, reason] of cases) expect([address, blockedReason(address)]).toEqual([address, reason]);
});

test("internal targets are refused unless they are this panel's or an admin allows them", async () => {
  setSetting(panel.deps.db, "uptimeAllowInternalTargets", false);
  const { cookie } = await createUser(panel, "owner");
  const { service } = seedService();
  const dns: Record<string, string[]> = {
    "public.example.com": ["93.184.215.14"],
    "sneaky.example.com": ["93.184.215.14", "10.0.0.7"],
    "shop.example.com": ["192.168.64.5"],
  };
  setTargetResolver(async (host) => dns[host] ?? []);

  for (const target of [
    "http://127.0.0.1:8080/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/",
    "http://[::1]/",
    "http://2130706433/",
    "http://sneaky.example.com/",
  ]) {
    const res = await callOp(panel, uptime.create, { serviceId: service.id, name: "x", url: target }, { cookie });
    expect([target, res.body.error?.details?.reason]).toEqual([target, "internalTarget"]);
  }
  expect(
    (await callOp(panel, uptime.create, { serviceId: service.id, name: "ok", url: "https://public.example.com/" }, { cookie })).status,
  ).toBe(200);

  // A domain row proves nothing about where its name resolves; a node's own address is fine on a private network.
  panel.deps.db.insert(domains).values({ serviceId: service.id, host: "shop.example.com", targetPort: 3000 }).run();
  expect((await checkTarget(panel.deps, "https://shop.example.com/")).ok).toBe(false);
  // The vetted address is what the probe connects to, so DNS cannot change its mind in between.
  expect(await checkTarget(panel.deps, "https://public.example.com/")).toEqual({ ok: true, address: "93.184.215.14", byName: false });
  // What an agent reports as its public address proves nothing (a compromised one reports any address);
  // the address an admin set for the node does.
  const vm = panel.deps.db
    .insert(nodes)
    .values({ name: "vm", publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), publicIpv4: "192.168.64.9" })
    .returning()
    .get();
  expect((await checkTarget(panel.deps, "http://192.168.64.9:3000/")).ok).toBe(false);
  panel.deps.db.update(nodes).set({ publicAddress: "192.168.64.9" }).where(eq(nodes.id, vm.id)).run();
  expect((await checkTarget(panel.deps, "http://192.168.64.9:3000/")).ok).toBe(true);
  expect((await checkTarget(panel.deps, "http://192.168.64.10:3000/")).ok).toBe(false);

  // A saved check whose host later resolves inside is not requested.
  const saved = await callOp(
    panel,
    uptime.create,
    { serviceId: service.id, name: "later", url: "https://public.example.com/x" },
    { cookie },
  );
  dns["public.example.com"] = ["10.9.9.9"];
  await panel.runner.runDue(panel.deps);
  const row = panel.deps.db.select().from(uptimeChecks).where(eq(uptimeChecks.id, saved.body.id)).get();
  expect(row?.lastError).toStartWith("Not checked: The target is a private network address (10.9.9.9).");

  // The admin switch allows everything.
  const allowed = await callOp(panel, settingsOps.updateGeneral, { uptimeAllowInternalTargets: true }, { cookie });
  expect(allowed.body.uptimeAllowInternalTargets).toBe(true);
  expect((await callOp(panel, uptime.create, { serviceId: service.id, name: "lo", url: "http://127.0.0.1:1/" }, { cookie })).status).toBe(
    200,
  );
});

test("pinned requests keep the host in Host and SNI but connect to the vetted address", () => {
  expect(pinRequest("https://shop.example.com:8443/x?y=1", "203.0.113.4")).toEqual({
    url: "https://203.0.113.4:8443/x?y=1",
    headers: { host: "shop.example.com:8443" },
    tls: { serverName: "shop.example.com" },
  });
  expect(pinRequest("http://shop.example.com/", "2001:db8::5")).toEqual({
    url: "http://[2001:db8::5]/",
    headers: { host: "shop.example.com" },
  });
  expect(pinRequest("http://203.0.113.9/", "203.0.113.9")).toEqual({ url: "http://203.0.113.9/", headers: {} });
  expect(pinRequest("http://shop.example.com/", null)).toEqual({ url: "http://shop.example.com/", headers: {} });
});
