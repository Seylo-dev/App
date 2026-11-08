// The panel's tailnet listener (added in 0.2.1): the unix socket Tailscale
// Serve proxies to. Forwarded headers count there and nowhere else, the host
// is pinned to the server's MagicDNS name (308 for the short name and
// tailnet addresses, 421 for anything else, 503 while the name is unknown),
// there is no domain redirect and no agent endpoint, calls carry via and
// viaLogin into the audit log, and the socket is 0600 and replaces a stale
// one. One test runs the real socket with an op call and a live WebSocket,
// with the headers Serve 1.104 sends: Host "localhost", X-Forwarded-Host,
// X-Forwarded-For, X-Forwarded-Proto (HTTPS mode only), Tailscale-User-Login.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveSessionKeyParam, liveUnauthorizedCloseCode, opRoute, sessionCookieName, settings as settingOps } from "@seylo/ops";
import { desc } from "drizzle-orm";
import { createSession } from "../src/auth/sessions";
import { auditLog, users } from "../src/db/schema";
import { listenOnTailnetSocket, pinTailnetHost, tailscaleUserLogin } from "../src/http/tailnet-host";
import { silentLogger } from "../src/logger";
import { emptySeen } from "../src/modules/tailscale/keys";
import { setSetting } from "../src/settings";
import { callOp, createUser, sessionHeaders, type TestPanel, testPanel } from "./helpers";

const dnsName = "panel.tail1234.ts.net";
let panel: TestPanel | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  panel?.close();
  panel = undefined;
});

function knowName(p: TestPanel, name = dnsName) {
  setSetting(p.deps.db, "tailscaleSeen", { ...emptySeen, detected: true, state: "Running", dnsName: name, https: true });
}

/** A request as Serve sends it to the unix target. */
function overServe(
  path: string,
  init: { method?: string; host?: string | null; proto?: string | null; headers?: Record<string, string>; body?: string } = {},
) {
  const headers: Record<string, string> = { host: "localhost", "x-forwarded-for": "100.101.42.9", ...init.headers };
  if (init.host !== null) headers["x-forwarded-host"] = init.host ?? dnsName;
  if (init.proto !== null) headers["x-forwarded-proto"] = init.proto ?? "https";
  return new Request(`http://localhost${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

const lastAudit = (p: TestPanel) => p.deps.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1).get();

test("host pinning: the full name is served, the short name and tailnet addresses move to it, the rest is 421", () => {
  const identity = { dnsName, addresses: ["100.101.42.7", "fd7a:115c:a1e0::6a01:2a07"] };
  const verdict = (host: string | null, proto: string | null = "https", path = "/projects?x=1") =>
    pinTailnetHost(overServe(path, { host, proto }), identity);
  expect(verdict(dnsName)).toEqual({ kind: "serve", host: dnsName });
  expect(verdict("Panel.Tail1234.ts.net.")).toEqual({ kind: "serve", host: dnsName });
  expect(verdict(`${dnsName}:443`)).toEqual({ kind: "serve", host: dnsName });
  expect(verdict(`${dnsName}:8443`)).toEqual({ kind: "serve", host: `${dnsName}:8443` });
  expect(verdict(`${dnsName}:80`, null)).toEqual({ kind: "serve", host: dnsName });
  expect(verdict("panel")).toEqual({ kind: "redirect", location: `https://${dnsName}/projects?x=1` });
  expect(verdict("100.101.42.7", null)).toEqual({ kind: "redirect", location: `http://${dnsName}/projects?x=1` });
  expect(verdict("[fd7a:115c:a1e0::6a01:2a07]")).toEqual({ kind: "redirect", location: `https://${dnsName}/projects?x=1` });
  for (const host of ["evil.example", "localhost", "panel.tail1234.ts.net.evil.example", "", null]) {
    expect(verdict(host)).toEqual({ kind: "misdirected" });
  }
  expect(pinTailnetHost(overServe("/"), { dnsName: null, addresses: [] })).toEqual({ kind: "unknown" });
  // The agent's probe through the socket.
  expect(pinTailnetHost(overServe("/api/health", { host: null }), { dnsName: null, addresses: [] })).toEqual({ kind: "serve", host: null });
});

test("the tailnet app answers 308, 421 and 503 itself and serves /api/health whatever the host", async () => {
  panel = testPanel();
  const p = panel;
  const unknown = await p.tailnetApp.handle(overServe("/"));
  expect(unknown.status).toBe(503);
  expect(await unknown.text()).toContain("does not know its tailnet name yet");
  expect((await p.tailnetApp.handle(overServe("/api/health", { host: null }))).status).toBe(200);
  knowName(p);
  const moved = await p.tailnetApp.handle(overServe("/settings?tab=1", { host: "panel" }));
  expect(moved.status).toBe(308);
  expect(moved.headers.get("location")).toBe(`https://${dnsName}/settings?tab=1`);
  expect((await p.tailnetApp.handle(overServe("/", { host: "evil.example" }))).status).toBe(421);
  // Without X-Forwarded-Host (a local client on the socket) nothing names the panel.
  expect((await p.tailnetApp.handle(overServe("/", { host: null }))).status).toBe(421);
  // The main port never pins: Host is whatever the client says.
  expect((await p.app.handle(new Request("http://203.0.113.5:3000/api/health"))).status).toBe(200);
});

test("forwarded headers count on the tailnet listener only, and its calls carry via and viaLogin", async () => {
  panel = testPanel();
  const p = panel;
  knowName(p);
  const owner = await createUser(p, "owner");
  const { path } = opRoute(settingOps.updateGeneral);
  const body = JSON.stringify({ name: "Over the tailnet" });
  // HTTP mode (no X-Forwarded-Proto): the plain session cookie, as on a tailnet without certificates.
  const cookie = { ...sessionHeaders(owner.cookie), "content-type": "application/json", origin: `http://${dnsName}` };

  const response = await p.tailnetApp.handle(
    overServe(path, {
      method: "POST",
      body,
      proto: null,
      headers: { ...cookie, "tailscale-user-login": "=?utf-8?q?j=C3=B6rg@example.com?=" },
    }),
  );
  expect(response.status).toBe(200);
  const row = lastAudit(p);
  expect(row?.ip).toBe("100.101.42.9");
  expect(row?.input).toEqual({ name: "Over the tailnet", via: "tailnet", viaLogin: "jörg@example.com" });

  // The same headers on the panel port: no via, and X-Forwarded-For is a claim nobody believes.
  const main = await p.app.handle(
    new Request(`http://panel.test${path}`, {
      method: "POST",
      body,
      headers: {
        ...sessionHeaders(owner.cookie),
        "content-type": "application/json",
        host: "panel.test",
        "x-forwarded-for": "100.101.42.9",
        "x-forwarded-host": dnsName,
        "tailscale-user-login": "owner@example.com",
      },
    }),
  );
  expect(main.status).toBe(200);
  expect(lastAudit(p)?.input).toEqual({ name: "Over the tailnet" });
  expect(lastAudit(p)?.ip).not.toBe("100.101.42.9");
});

test("a cross-site POST over the tailnet is refused: Origin must be the pinned name", async () => {
  panel = testPanel();
  const p = panel;
  knowName(p);
  const owner = await createUser(p, "owner");
  const { path } = opRoute(settingOps.updateGeneral);
  const response = await p.tailnetApp.handle(
    overServe(path, {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
      headers: { ...sessionHeaders(owner.cookie), "content-type": "application/json", origin: "https://evil.example" },
    }),
  );
  expect(response.status).toBe(403);
});

test("no domain redirect and no agent endpoint on the tailnet listener", async () => {
  panel = testPanel();
  const p = panel;
  knowName(p);
  setSetting(p.deps.db, "panelDomain", "panel.example.com");
  setSetting(p.deps.db, "panelDomainStatus", { domain: "panel.example.com", state: "active", message: "", checkedAt: Date.now() });
  const onIp = await p.app.handle(new Request("http://203.0.113.5:3000/projects", { headers: { host: "203.0.113.5:3000" } }));
  expect(onIp.status).toBe(302);
  const onTailnet = await p.tailnetApp.handle(overServe("/projects"));
  expect(onTailnet.status).not.toBe(302);
  expect(onTailnet.headers.get("location")).toBeNull();
  // The agent WebSocket path is unknown there: the web app answers it as a missing API route.
  expect((await p.tailnetApp.handle(overServe("/api/agent/connect"))).status).toBe(404);
});

test("Tailscale-User-Login: plain, Q-encoded in several words, or broken", () => {
  const login = (value: string | null) =>
    tailscaleUserLogin(new Request("http://localhost/", value === null ? {} : { headers: { "tailscale-user-login": value } }));
  expect(login(null)).toBeNull();
  expect(login("  ")).toBeNull();
  expect(login("owner@example.com")).toBe("owner@example.com");
  expect(login("=?utf-8?q?J=C3=B6rg_M=C3=BCller?=")).toBe("Jörg Müller");
  expect(login("=?utf-8?q?ab?= =?utf-8?q?=C3=A9?=")).toBe("abé");
  // Not UTF-8 after decoding: kept as Serve sent it.
  expect(login("=?utf-8?q?=FF?=")).toBe("=?utf-8?q?=FF?=");
});

// ----------------------------------------------------------------- the real socket

/** A short path: unix socket paths are limited to about 100 bytes. */
function socketDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sy-tn-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Leaves a socket file behind the way a killed panel does. */
async function staleSocket(path: string) {
  const child = Bun.spawn([
    process.execPath,
    "-e",
    `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); setInterval(() => {}, 1000);`,
  ]);
  for (let i = 0; i < 100 && !existsSync(path); i++) await Bun.sleep(20);
  child.kill(9);
  await child.exited;
  expect(existsSync(path)).toBe(true);
}

/** Raw HTTP/1.1 over the socket; returns the response head and the socket for WebSocket frames. */
function rawRequest(path: string, head: string): Promise<{ head: string; frames: string[]; send(text: string): void; close(): void }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let headDone: string | null = null;
    const frames: string[] = [];
    const timer = setTimeout(() => reject(new Error(`no answer on ${path}`)), 5000);
    void Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(head);
        },
        data(socket, data) {
          buffer = Buffer.concat([buffer, data]);
          if (headDone === null) {
            const end = buffer.indexOf("\r\n\r\n");
            if (end < 0) return;
            headDone = buffer.subarray(0, end).toString("latin1");
            buffer = buffer.subarray(end + 4);
            clearTimeout(timer);
            resolve({
              head: headDone,
              frames,
              send(text) {
                const payload = Buffer.from(text);
                const mask = Buffer.from([7, 1, 9, 3]);
                const masked = Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] as number)));
                socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
              },
              close() {
                socket.end();
              },
            });
          }
          // Server frames are unmasked; the tests only get short text and close frames.
          while (buffer.length >= 2 && buffer.length >= 2 + ((buffer[1] as number) & 0x7f)) {
            const length = (buffer[1] as number) & 0x7f;
            const opcode = (buffer[0] as number) & 0x0f;
            if (opcode === 1) frames.push(buffer.subarray(2, 2 + length).toString("utf8"));
            if (opcode === 8) frames.push(`close ${buffer.readUInt16BE(2)}`);
            buffer = buffer.subarray(2 + length);
          }
        },
        error(_socket, error) {
          reject(error);
        },
      },
    });
  });
}

test("the socket: a stale one is replaced, it is 0600, ops and the live WebSocket work through it", async () => {
  panel = testPanel();
  const p = panel;
  knowName(p);
  const path = join(socketDir(), "tailnet.sock");
  await staleSocket(path);
  expect(listenOnTailnetSocket(p.tailnetApp, path, silentLogger())).toBe(true);
  cleanups.push(() => p.tailnetApp.stop(true));
  expect(statSync(path).mode & 0o777).toBe(0o600);

  // An op over the socket, as Serve forwards it.
  const health = await fetch(`http://localhost/api/health`, { unix: path } as RequestInit);
  expect(health.status).toBe(200);
  const general = await fetch(`http://localhost${opRoute(settingOps.general).path}`, {
    unix: path,
    headers: { "x-forwarded-host": dnsName, "x-forwarded-proto": "https" },
  } as RequestInit);
  expect(general.status).toBe(401);

  // The live socket with a session made on the tailnet name (HTTPS: the __Host- cookie).
  const user = p.deps.db.insert(users).values({ email: "o@example.com", name: "o", role: "owner" }).returning().get();
  const { token, key } = createSession(p.deps.db, user.id, { ip: null, userAgent: null });
  const upgrade = (extra: string) =>
    rawRequest(
      path,
      `GET /api/live?${liveSessionKeyParam}=${encodeURIComponent(key)} HTTP/1.1\r\nHost: localhost\r\n${extra}Cookie: ${sessionCookieName(true)}=${token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  const live = await upgrade(`X-Forwarded-Host: ${dnsName}\r\nX-Forwarded-Proto: https\r\nOrigin: https://${dnsName}\r\n`);
  expect(live.head.split("\r\n")[0]).toContain("101");
  live.send(JSON.stringify({ type: "subscribe", topic: "panel" }));
  for (let i = 0; i < 100 && live.frames.length === 0; i++) await Bun.sleep(10);
  expect(live.frames.map((frame) => JSON.parse(frame))).toContainEqual({ type: "subscribed", topic: "panel" });
  // Signing the person out closes their sockets on this listener too, not only on the panel port.
  p.deps.live.disconnect({ userId: user.id });
  for (let i = 0; i < 100 && !live.frames.some((frame) => frame.startsWith("close")); i++) await Bun.sleep(10);
  expect(live.frames).toContain(`close ${liveUnauthorizedCloseCode}`);
  live.close();

  // A browser on another site, and a host that is not the panel's.
  expect((await upgrade(`X-Forwarded-Host: ${dnsName}\r\nOrigin: https://evil.example\r\n`)).head.split("\r\n")[0]).toContain("403");
  expect((await upgrade(`X-Forwarded-Host: evil.example\r\nOrigin: https://evil.example\r\n`)).head.split("\r\n")[0]).toContain("421");
});

test("something that is not a socket at the path is left alone and the main port keeps working", async () => {
  panel = testPanel();
  const p = panel;
  const path = join(socketDir(), "tailnet.sock");
  writeFileSync(path, "not a socket");
  expect(listenOnTailnetSocket(p.tailnetApp, path, silentLogger())).toBe(false);
  expect(statSync(path).isFile()).toBe(true);
  expect((await callOp(p, settingOps.general, {})).status).toBe(401);
});
