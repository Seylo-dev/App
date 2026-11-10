// The installable app and push notifications (0.2.7): the admin switch
// turns on only from a browser on the panel domain over HTTPS (not
// IP:port, not the tailnet, not a key); devices are added only from there,
// to known push services; an alert reaches the devices of the people who
// chose its event and may see it, encrypted for each device; gone and
// failing devices are dropped; a new domain, the switch going off and a
// revoked session remove devices; the manifest follows the switch.
//
// The panel domain is panel.test, the host callOp talks to. "Over the
// domain" is a trusted proxy saying https, as the node's Traefik does.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { push, system } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { alertMutes, pushDevices, sessions, settings } from "../src/db/schema";
import { createProxyTrust } from "../src/http/proxy-trust";
import { endpointHash, forgetOtherOrigins } from "../src/modules/push/devices";
import { pngSize, shortName } from "../src/modules/push/http";
import { burstLimit, incidentOf, recordSend, resetPushIo, revokeOnStart, setPushIo, topicOf } from "../src/modules/push/send";
import { turnOnBlocks } from "../src/modules/push/state";
import { getSetting, setSetting } from "../src/settings";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedProject, seedService } from "./people-helpers";

const domain = "panel.test";
const overDomain = { "x-forwarded-proto": "https" };
let panel: TestPanel;
let sent: { url: string; headers: Record<string, string>; body: Buffer }[];
let status: (url: string) => number;

beforeEach(() => {
  panel = testPanel({ proxy: createProxyTrust({ always: true, proxies: [] }) });
  sent = [];
  status = () => 201;
  setPushIo({
    fetch: async (url, init) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: status(url) });
    },
    check: async () => ({ ok: true, address: "203.0.113.5", byName: false }),
  });
});
afterEach(() => {
  resetPushIo();
  panel.close();
});

function activeDomain() {
  setSetting(panel.deps.db, "panelDomain", domain);
  setSetting(panel.deps.db, "panelDomainStatus", {
    domain,
    state: "active",
    message: "",
    checkedAt: Date.now(),
    working: true,
    since: Date.now() - 3_600_000,
  });
}

/** The browser's private keys by endpoint, to open what was sent to it. */
const browsers = new Map<string, { ua: ReturnType<typeof createECDH>; auth: Buffer }>();

/** What a browser does with a push body (RFC 8291 from the receiving side): the message the service worker shows. */
function openAsBrowser(endpoint: string, body: Buffer) {
  const keys = browsers.get(endpoint);
  if (!keys) throw new Error("unknown browser");
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 86);
  const mac = (key: Buffer, ...parts: Buffer[]) => {
    const h = createHmac("sha256", key);
    for (const part of parts) h.update(part);
    return h.digest();
  };
  const expand = (salt: Buffer, ikm: Buffer, info: Buffer, n: number) => mac(mac(salt, ikm), info, Buffer.of(1)).subarray(0, n);
  const ikm = expand(
    keys.auth,
    keys.ua.computeSecret(asPublic),
    Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), keys.ua.getPublicKey(), asPublic]),
    32,
  );
  const decipher = createDecipheriv(
    "aes-128-gcm",
    expand(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16),
    expand(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12),
  );
  const sealed = body.subarray(86);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  return JSON.parse(record.subarray(0, -1).toString("utf8"));
}

/** A browser's push subscription on Google's push service. */
function browser(path: string = crypto.randomUUID()) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  browsers.set(`https://fcm.googleapis.com/fcm/send/${path}`, { ua, auth });
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${path}`,
    p256dh: ua.getPublicKey("base64url"),
    auth: auth.toString("base64url"),
    label: "Chrome on Android",
  };
}

async function turnOn(owner: { cookie: string }) {
  const on = await callOp(panel, push.updateSettings, { enabled: true }, { cookie: owner.cookie, headers: overDomain });
  expect(on.status).toBe(200);
  return on.body;
}

async function addDevice(person: { cookie: string }, sub = browser()) {
  const added = await callOp(panel, push.subscribe, sub, { cookie: person.cookie, headers: overDomain });
  expect(added.status).toBe(200);
  return { device: added.body, sub };
}

async function runJobs() {
  for (let i = 0; i < 3; i++) await panel.runner.runDue(panel.deps);
}

test("the switch turns on only over the domain's HTTPS, never over IP:port or with a key; off removes every device", async () => {
  const early = await createUser(panel, "owner");
  // No domain: refused, with the reason the card shows.
  const noDomain = await callOp(panel, push.settings, {}, { cookie: early.cookie });
  expect(noDomain.body).toMatchObject({ enabled: false, active: false, domainUrl: null });
  expect(noDomain.body.blocks.map((b: { code: string }) => b.code)).toEqual(["noDomain"]);
  expect((await callOp(panel, push.updateSettings, { enabled: true }, { cookie: early.cookie })).body.error.details.reason).toBe(
    "noDomain",
  );

  // A domain still getting its certificate: not yet. (A session made now gets the domain's secure cookie.)
  setSetting(panel.deps.db, "panelDomain", domain);
  const owner = await createUser(panel, "owner");
  setSetting(panel.deps.db, "panelDomainStatus", { domain, state: "issuing_certificate", message: "", checkedAt: Date.now() });
  const issuing = await callOp(panel, push.updateSettings, { enabled: true }, { cookie: owner.cookie, headers: overDomain });
  expect(issuing.status).toBe(409);
  expect(issuing.body.error.details.reason).toBe("domainNotActive");

  // Active, but this request came over IP:port (no trusted https): refused.
  activeDomain();
  const overIp = await callOp(panel, push.updateSettings, { enabled: true }, { cookie: owner.cookie });
  expect(overIp.status).toBe(409);
  expect(overIp.body.error.details.reason).toBe("notOnDomain");
  // An owner's full API key over the domain: not a browser.
  const key = createApiKey(panel, owner.user.id);
  const byKey = await callOp(panel, push.updateSettings, { enabled: true }, { bearer: key, headers: overDomain });
  expect(byKey.status).toBe(409);
  expect(byKey.body.error.details.reason).toBe("notBrowser");
  expect(getSetting(panel.deps.db, "pushVapid")).toBeUndefined();

  // Over the domain from the browser: on, with the panel's push key made.
  const on = await turnOn(owner);
  expect(on).toMatchObject({ enabled: true, active: true, domainUrl: "https://panel.test", onDomainNow: true, blocks: [] });
  expect(getSetting(panel.deps.db, "pushVapid")?.publicKey).toHaveLength(87);
  const features = await callOp(panel, system.features, {}, { cookie: owner.cookie });
  expect(features.body.appPush).toEqual({ enabled: true, reason: "" });

  await addDevice(owner);
  expect((await callOp(panel, push.settings, {}, { cookie: owner.cookie })).body).toMatchObject({ people: 1, devices: 1 });
  // Off works from anywhere and removes every device.
  const off = await callOp(panel, push.updateSettings, { enabled: false }, { cookie: owner.cookie });
  expect(off.status).toBe(200);
  expect(off.body).toMatchObject({ enabled: false, active: false, devices: 0 });
  expect(panel.deps.db.select().from(pushDevices).all()).toEqual([]);
});

test("the tailnet and the assistant are refused too, with their own reasons", () => {
  activeDomain();
  const user = { id: "u1", email: "o@example.com", name: "o", role: "owner" as const };
  const base = { db: panel.deps.db, principal: { type: "session", user, sessionId: "s" } } as never as Parameters<typeof turnOnBlocks>[0];
  const codes = (ctx: object) => turnOnBlocks({ ...base, ...ctx } as never).map((b) => b.code);
  // Tailscale Serve with HTTPS is a secure address, but not the panel's domain.
  expect(codes({ via: "tailnet", origin: "https://panel.tail1234.ts.net", transport: "http" })).toEqual(["viaTailnet"]);
  expect(codes({ origin: "https://panel.test", transport: "ai" })).toEqual(["notBrowser"]);
  expect(codes({ origin: "http://203.0.113.10:3000", transport: "http" })).toEqual(["notOnDomain"]);
  expect(codes({ origin: "https://panel.test", transport: "http" })).toEqual([]);
});

test("a device is added only on the domain, to a known push service, with valid keys; the same browser moves accounts", async () => {
  activeDomain();
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  activeDomain();
  // Off: refused.
  const off = await callOp(panel, push.subscribe, browser(), { cookie: owner.cookie, headers: overDomain });
  expect(off.status).toBe(409);
  expect(off.body.error.details.reason).toBe("notAvailable");
  await turnOn(owner);

  expect((await callOp(panel, push.subscribe, browser(), { cookie: owner.cookie })).body.error.details.reason).toBe("notOnDomain");
  for (const endpoint of [
    "https://evil.example/push/1",
    "https://10.0.0.5/push",
    "https://fcm.googleapis.com:8443/x",
    "https://u:p@fcm.googleapis.com/x",
  ]) {
    const refused = await callOp(panel, push.subscribe, { ...browser(), endpoint }, { cookie: owner.cookie, headers: overDomain });
    expect(refused.status).toBe(400);
  }
  const offCurve = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 7)]).toString("base64url");
  expect(
    (await callOp(panel, push.subscribe, { ...browser(), p256dh: offCurve }, { cookie: owner.cookie, headers: overDomain })).status,
  ).toBe(400);
  // A key cannot add devices.
  expect((await callOp(panel, push.subscribe, browser(), { bearer: createApiKey(panel, owner.user.id), headers: overDomain })).status).toBe(
    403,
  );

  const sub = browser("same-browser");
  const { device } = await addDevice(owner, sub);
  expect(device).toMatchObject({
    label: "Chrome on Android",
    service: "fcm.googleapis.com",
    endpointHash: endpointHash(sub.endpoint),
    failing: false,
  });
  // The endpoint and keys are sealed at rest.
  const row = panel.deps.db.select().from(pushDevices).get();
  expect(row?.subscriptionSealed).toStartWith("v1.");
  expect(row?.subscriptionSealed).not.toContain(sub.auth);
  // Someone else signs in on the same browser: the subscription moves to them.
  await addDevice(member, sub);
  expect((await callOp(panel, push.mine, {}, { cookie: owner.cookie })).body.devices).toEqual([]);
  expect((await callOp(panel, push.mine, {}, { cookie: member.cookie })).body.devices).toHaveLength(1);
});

test("an alert reaches the devices of people who chose it and may see it, encrypted, with urgency and topic", async () => {
  activeDomain();
  const owner = await createUser(panel, "owner");
  const allowed = await createUser(panel, "member");
  const other = await createUser(panel, "member");
  await turnOn(owner);
  const project = seedProject(panel);
  const service = seedService(panel, project.id);
  grant(panel, allowed.user.id, "project", project.id, ["projects.view", "services.view"]);
  const ownerDevice = await addDevice(owner);
  await addDevice(allowed);
  await addDevice(other);

  // Members can choose service events, approvals and their own account's alerts; not nodes.
  const mine = (await callOp(panel, push.mine, {}, { cookie: allowed.cookie, headers: overDomain })).body;
  expect(mine).toMatchObject({ available: true, domainUrl: "https://panel.test", onDomainNow: true });
  expect(mine.publicKey).toHaveLength(87);
  expect(mine.eventChoices).toContain("crash");
  expect(mine.eventChoices).not.toContain("node_offline");
  expect((await callOp(panel, push.setEvents, { events: ["crash", "node_offline"] }, { cookie: allowed.cookie })).status).toBe(400);

  panel.deps.alerts.raise({
    event: "crash",
    key: `crash:${service.id}:1`,
    title: "api crashed",
    message: "exit code 137",
    serviceId: service.id,
  });
  await runJobs();
  // The owner and the member with a grant; not the member without one.
  expect(sent).toHaveLength(2);
  const hit = sent.find((s) => s.url.endsWith(new URL(ownerDevice.sub.endpoint).pathname));
  expect(hit?.headers).toMatchObject({ "content-encoding": "aes128gcm", urgency: "high", ttl: "86400", host: "fcm.googleapis.com" });
  expect(hit?.headers.authorization).toMatch(/^vapid t=.+, k=/);
  expect(hit?.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
  // Sent to the checked address, the name kept for TLS and the Host header.
  expect(hit?.url).toStartWith("https://203.0.113.5/");
  // The owner's browser opens it: the alert's title, message and link, tagged by incident.
  const opened = openAsBrowser(ownerDevice.sub.endpoint, hit?.body as Buffer);
  expect(opened).toMatchObject({ title: "api crashed", body: "exit code 137", url: `/p/${project.id}/s/${service.id}` });
  expect(opened.tag).toBe(hit?.headers.topic);

  // A person who turned the event off gets nothing; node alerts reach only owners and admins.
  sent = [];
  await callOp(panel, push.setEvents, { events: ["deploy_failed"] }, { cookie: owner.cookie });
  panel.deps.alerts.raise({ event: "crash", key: `crash:${service.id}:2`, title: "api crashed again", serviceId: service.id });
  await runJobs();
  expect(sent).toHaveLength(1);
  sent = [];
  await callOp(panel, push.setEvents, { events: ["node_offline"] }, { cookie: owner.cookie });
  panel.deps.alerts.raise({ event: "node_offline", key: "node-offline:n1:1", title: "node is offline" });
  await runJobs();
  expect(sent).toHaveLength(1);
});

test("a gone device is removed, a failing one after 5 failures, a busy service is retried; bursts are capped", async () => {
  activeDomain();
  const owner = await createUser(panel, "owner");
  await turnOn(owner);
  const service = seedService(panel, seedProject(panel).id);
  const gone = await addDevice(owner);
  const flaky = await addDevice(owner);
  status = (url) => (url.endsWith(gone.sub.endpoint.split("/").pop() as string) ? 410 : 503);
  panel.deps.alerts.raise({ event: "crash", key: `crash:${service.id}:1`, title: "crashed", serviceId: service.id });
  await panel.runner.runDue(panel.deps);
  await panel.runner.runDue(panel.deps);
  const rows = () => panel.deps.db.select().from(pushDevices).all();
  expect(rows().map((r) => r.id)).toEqual([flaky.device.id]);
  // 503 is retried later, not counted yet.
  expect(rows()[0]).toMatchObject({ failures: 0 });
  expect(rows()[0]?.lastError).toContain("503");

  // 403 (a key mismatch) counts at once; 5 in a row removes the device.
  status = () => 403;
  for (let i = 0; i < 5; i++) {
    const result = await callOp(panel, push.test, {}, { cookie: owner.cookie });
    expect(result.body.results[0]?.ok).toBe(false);
  }
  expect(rows()).toEqual([]);

  // More than the burst limit in the window: the rest are not pushed.
  status = () => 201;
  await addDevice(owner);
  sent = [];
  for (let i = 0; i < burstLimit + 5; i++) {
    panel.deps.alerts.raise({ event: "crash", key: `crash:s${i}:1`, title: `crash ${i}`, serviceId: service.id });
  }
  // The runner takes 4 jobs a tick: one fan-out and one send per alert.
  for (let i = 0; i < 25; i++) await panel.runner.runDue(panel.deps);
  expect(sent.length).toBe(burstLimit);
  expect(rows()[0]?.lastError).toContain(`More than ${burstLimit} alerts`);
});

test("muted alerts are not pushed; node back online is", async () => {
  activeDomain();
  const owner = await createUser(panel, "owner");
  await turnOn(owner);
  await addDevice(owner);
  panel.deps.db.insert(alertMutes).values({ scopeType: "global", scopeId: null }).run();
  panel.deps.alerts.raise({ event: "node_offline", key: "node-offline:n1:1", title: "node is offline" });
  await runJobs();
  expect(sent).toHaveLength(0);
  panel.deps.db.delete(alertMutes).run();
  panel.deps.alerts.raise({ event: "node_offline", key: "node-offline:n2:1", title: "node 2 is offline" });
  panel.deps.alerts.resolve("node-offline:n2:", { event: "node_online", key: "node-online:n2:2", title: "node 2 is back" });
  await runJobs();
  expect(sent).toHaveLength(2);
});

test("a person's own security change reaches them; someone else's does not", async () => {
  activeDomain();
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  const bystander = await createUser(panel, "member");
  await turnOn(owner);
  await callOp(panel, push.setEvents, { events: ["approval_requested"] }, { cookie: owner.cookie });
  await addDevice(owner);
  await addDevice(member);
  await addDevice(bystander);
  panel.deps.alerts.raise({ event: "security_change", key: `security:${member.user.id}:1:x`, title: "A passkey was added" });
  await runJobs();
  expect(sent).toHaveLength(1);
});

test("a new domain removes the old domain's devices; a revoked session removes its device", async () => {
  activeDomain();
  const owner = await createUser(panel, "owner");
  await turnOn(owner);
  await addDevice(owner);
  await addDevice(owner);
  const [first] = panel.deps.db.select().from(pushDevices).all();
  panel.deps.db
    .delete(sessions)
    .where(eq(sessions.id, first?.sessionId as string))
    .run();
  expect(panel.deps.db.select().from(pushDevices).all()).toHaveLength(0);

  const fresh = await createUser(panel, "owner");
  await addDevice(fresh);
  expect(forgetOtherOrigins(panel.deps)).toBe(0);
  // Its service worker lives on https://panel.test: of no use on the new domain.
  setSetting(panel.deps.db, "panelDomain", "new.example.com");
  expect(forgetOtherOrigins(panel.deps)).toBe(1);
  expect(panel.deps.db.select().from(pushDevices).all()).toEqual([]);
});

test("the manifest is served while push works, with the panel's name and the built-in icons", async () => {
  activeDomain();
  const get = () => panel.app.handle(new Request("http://panel.test/manifest.webmanifest", { headers: { host: "panel.test" } }));
  expect((await get()).status).toBe(404);
  const owner = await createUser(panel, "owner");
  await turnOn(owner);
  setSetting(panel.deps.db, "panelName", "Acme Cloud Panel");
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/manifest+json");
  const manifest = (await response.json()) as { icons: { purpose: string }[] } & Record<string, unknown>;
  expect(manifest).toMatchObject({ id: "/", name: "Acme Cloud Panel", short_name: "Acme", start_url: "/", display: "standalone" });
  expect(manifest.icons.map((i: { purpose: string }) => i.purpose)).toEqual(["any", "any", "maskable"]);
  expect(shortName("Seylo")).toBe("Seylo");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  expect(pngSize(png)).toEqual({ width: 1, height: 1 });
  expect(pngSize(Buffer.from("not a png at all, really not"))).toBeNull();
});

test("incidents: the start time is cut off, one-part keys stay whole, node back online replaces node offline", () => {
  expect(incidentOf("crash:svc1:1731250000000")).toBe("crash:svc1");
  expect(incidentOf("approval:abc")).toBe("approval:abc");
  expect(incidentOf("build-failed:b1")).not.toBe(incidentOf("build-failed:b2"));
  expect(incidentOf("deploy-failed:svc1:3:node1")).toBe("deploy-failed:svc1:3:node1");
  expect(incidentOf("security:u1:1731250000000:5f2c")).toBe("security:u1:1731250000000:5f2c");
  expect(topicOf("node-online:n1:1731250099999")).toBe(topicOf("node-offline:n1:1731250000000"));
  expect(topicOf("approval:a1")).not.toBe(topicOf("approval:a2"));
});

test("a throttled device (WNS 406) is retried and not counted as failing; a device of an ended session is dropped", async () => {
  activeDomain();
  const onDomain = await createUser(panel, "owner");
  await turnOn(onDomain);
  const service = seedService(panel, seedProject(panel).id);
  await addDevice(onDomain);
  status = () => 406;
  panel.deps.alerts.raise({ event: "crash", key: `crash:${service.id}:1`, title: "crashed", serviceId: service.id });
  await panel.runner.runDue(panel.deps);
  await panel.runner.runDue(panel.deps);
  const row = () => panel.deps.db.select().from(pushDevices).get();
  expect(row()).toMatchObject({ failures: 0 });
  expect(row()?.lastError).toContain("406");

  // Two failures counted from the same stale row still count twice.
  const stale = row() as NonNullable<ReturnType<typeof row>>;
  recordSend(panel.deps, stale, { kind: "rejected", error: "403" }, true);
  recordSend(panel.deps, stale, { kind: "rejected", error: "403" }, true);
  expect(row()?.failures).toBe(2);

  // The session expires without a sign-out: the device goes and gets nothing more.
  panel.deps.db
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(sessions.id, stale.sessionId))
    .run();
  sent = [];
  status = () => 201;
  panel.deps.alerts.raise({ event: "crash", key: `crash:${service.id}:2`, title: "crashed again", serviceId: service.id });
  await runJobs();
  expect(sent).toHaveLength(0);
  expect(panel.deps.db.select().from(pushDevices).all()).toEqual([]);
});

test("after a --new-panel-identity rotation the old devices get a revoke push with the old key, then go; new ones work at once", async () => {
  activeDomain();
  const owner = await createUser(panel, "owner");
  await turnOn(owner);
  const old = await addDevice(owner);
  const oldKey = getSetting(panel.deps.db, "pushVapid");
  // What the rotation leaves (security/rotate-master-key.ts setPushKeyAside), a moment after the device was added.
  await Bun.sleep(5);
  setSetting(panel.deps.db, "pushVapidRevoked", { ...(oldKey as NonNullable<typeof oldKey>), at: Date.now() });
  panel.deps.db.delete(settings).where(eq(settings.key, "pushVapid")).run();
  await Bun.sleep(5);

  // Push stays on: the page gets a new key at once, without the old device in the list.
  const mine = (await callOp(panel, push.mine, {}, { cookie: owner.cookie, headers: overDomain })).body;
  expect(mine.publicKey).toHaveLength(87);
  expect(mine.publicKey).not.toBe(oldKey?.publicKey);
  expect(mine.devices).toEqual([]);
  const fresh = await addDevice(owner);

  // Alerts reach only the new device.
  const service = seedService(panel, seedProject(panel).id);
  panel.deps.alerts.raise({ event: "crash", key: `crash:${service.id}:1`, title: "crashed", serviceId: service.id });
  await runJobs();
  expect(sent.map((s) => new URL(s.url).pathname)).toEqual([new URL(fresh.sub.endpoint).pathname]);

  // The panel starts: the old device gets one revoke push, signed with the key it subscribed with.
  sent = [];
  revokeOnStart(panel.deps);
  await runJobs();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.url.endsWith(new URL(old.sub.endpoint).pathname)).toBe(true);
  expect(sent[0]?.headers.authorization).toEndWith(`k=${oldKey?.publicKey}`);
  expect(openAsBrowser(old.sub.endpoint, sent[0]?.body as Buffer)).toMatchObject({ type: "revoke", url: "/settings/push" });
  expect(
    panel.deps.db
      .select()
      .from(pushDevices)
      .all()
      .map((d) => d.id),
  ).toEqual([fresh.device.id]);
  expect(getSetting(panel.deps.db, "pushVapidRevoked")).toBeUndefined();
});
