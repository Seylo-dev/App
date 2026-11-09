// Behind the node's Traefik the panel believes forwarded headers only from
// the proxy's own address, marks cookies Secure on HTTPS, sends HSTS there,
// never lets itself be framed, and sends page loads on IP:port to the live
// panel domain.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@seylo/ops";
import { clientIp } from "../src/http/client-ip";
import { createProxyTrust } from "../src/http/proxy-trust";
import { setSetting } from "../src/settings";
import type { FakeAgent } from "./fake-agent";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";
import { call, noLimits } from "./people-helpers";

const panels: TestPanel[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const p of panels.splice(0)) p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(options: { alwaysTrust?: boolean; webDist?: string } = {}) {
  const panel = testPanel({
    rateLimiter: noLimits,
    proxy: createProxyTrust({ always: options.alwaysTrust ?? false, proxies: [] }),
    ...(options.webDist ? { webDist: options.webDist } : {}),
  });
  panels.push(panel);
  return panel;
}

describe("proxy trust", () => {
  test("only the resolved proxy addresses are trusted", async () => {
    const trust = createProxyTrust({ always: false, proxies: ["seylo-traefik", "10.9.9.9"], resolve: async () => ["172.18.0.3"] });
    expect(trust.trusts("172.18.0.3")).toBe(false);
    await trust.refresh();
    expect(trust.trusts("172.18.0.3")).toBe(true);
    expect(trust.trusts("::ffff:172.18.0.3")).toBe(true);
    expect(trust.trusts("10.9.9.9")).toBe(true);
    expect(trust.trusts("172.18.0.1")).toBe(false);
    expect(trust.trusts(null)).toBe(false);
    const failing = createProxyTrust({
      always: false,
      proxies: ["seylo-traefik"],
      resolve: async () => Promise.reject(new Error("ENOTFOUND")),
    });
    await failing.refresh();
    expect(failing.trusts("172.18.0.3")).toBe(false);
  });

  test("a new address on the panel's networks is looked up again before it is answered, once", async () => {
    let attached = false;
    let lookups = 0;
    let clock = 1_000_000;
    const trust = createProxyTrust({
      always: false,
      proxies: ["seylo-traefik"],
      resolve: async () => {
        lookups++;
        return attached ? ["172.18.0.3"] : [];
      },
      onOwnNetwork: (ip) => ip.startsWith("172.18."),
      now: () => clock,
    });
    await trust.refresh();
    expect(lookups).toBe(1);
    // A visitor on the published port from outside the panel's networks: no lookup.
    expect(await trust.check("203.0.113.9")).toBe(false);
    expect(await trust.check(null)).toBe(false);
    expect(lookups).toBe(1);
    // The network's gateway (docker-proxy): one lookup, then remembered.
    expect(await trust.check("172.18.0.1")).toBe(false);
    expect(await trust.check("172.18.0.1")).toBe(false);
    expect(lookups).toBe(2);
    // Traefik joins the panel's network (the panel domain was set): its first request counts.
    attached = true;
    expect(trust.trusts("172.18.0.3")).toBe(false);
    expect(await trust.check("::ffff:172.18.0.3")).toBe(true);
    expect(trust.trusts("172.18.0.3")).toBe(true);
    expect(await trust.check("172.18.0.3")).toBe(true);
    expect(lookups).toBe(3);
    // A remembered address is looked up again after the refresh interval.
    clock += 30_001;
    expect(await trust.check("172.18.0.1")).toBe(false);
    expect(lookups).toBe(4);
  });

  test("a check during a lookup waits for the next one, and an older answer never wins", async () => {
    let attached = false;
    let release: (() => void) | undefined;
    const trust = createProxyTrust({
      always: false,
      proxies: ["seylo-traefik"],
      resolve: async () => {
        if (attached) return ["172.18.0.3"];
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [];
      },
      onOwnNetwork: () => true,
    });
    const first = trust.refresh();
    attached = true;
    const checking = trust.check("172.18.0.3");
    release?.();
    expect(await checking).toBe(true);
    await first;
    expect(trust.trusts("172.18.0.3")).toBe(true);

    const stuck = createProxyTrust({
      always: false,
      proxies: ["seylo-traefik"],
      resolve: () => new Promise<string[]>(() => {}),
      onOwnNetwork: () => true,
      checkWaitMs: 20,
    });
    const started = Date.now();
    expect(await stuck.check("172.18.0.9")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("with DNS slower than the wait, an address waits once per interval, and the slow answer still counts", async () => {
    let lookups = 0;
    let answer: ((addresses: string[]) => void) | undefined;
    let clock = 1_000_000;
    const trust = createProxyTrust({
      always: false,
      proxies: ["seylo-traefik"],
      resolve: () => {
        lookups++;
        return new Promise<string[]>((resolve) => {
          answer = resolve;
        });
      },
      onOwnNetwork: () => true,
      checkWaitMs: 20,
      now: () => clock,
    });
    // The gateway (an SSH tunnel) waits for the slow lookup once...
    expect(await trust.check("172.18.0.1")).toBe(false);
    expect(lookups).toBe(1);
    // ...and its next requests neither wait nor queue more lookups.
    const started = Date.now();
    for (let i = 0; i < 5; i++) expect(await trust.check("172.18.0.1")).toBe(false);
    expect(Date.now() - started).toBeLessThan(15);
    expect(lookups).toBe(1);
    // Traefik's address waited on the same slow lookup, which finds it in the end.
    expect(await trust.check("172.18.0.3")).toBe(false);
    answer?.(["172.18.0.3"]);
    await Bun.sleep(0);
    expect(trust.trusts("172.18.0.3")).toBe(true);
    expect(await trust.check("172.18.0.3")).toBe(true);
    // Its wait queued one lookup behind the slow one, which runs now; let it end too.
    expect(lookups).toBe(2);
    answer?.(["172.18.0.3"]);
    await Bun.sleep(0);
    // After the interval the gateway is looked up again.
    clock += 30_001;
    void trust.check("172.18.0.1");
    expect(lookups).toBe(3);
  });

  test("X-Forwarded-For counts only from a trusted peer", () => {
    const request = new Request("http://panel/", { headers: { "x-forwarded-for": "198.51.100.7" } });
    expect(clientIp(request, "172.18.0.3", true)).toBe("198.51.100.7");
    expect(clientIp(request, "203.0.113.9", false)).toBe("203.0.113.9");
  });
});

// The e2e case: the panel domain is set, Traefik joins the panel's network
// right after, and browsers and agents come through it within the 30 s
// before the next timed lookup.
test("a proxy that just joined counts from its first request and agent connect", async () => {
  let attached = false;
  const proxy = createProxyTrust({
    always: false,
    proxies: ["seylo-traefik"],
    resolve: async () => (attached ? ["127.0.0.1"] : []),
    onOwnNetwork: () => true,
  });
  const panel = testPanel({ rateLimiter: noLimits, proxy });
  const agents: FakeAgent[] = [];
  try {
    const url = listen(panel);
    await proxy.refresh();
    attached = true;
    const forwarded = { "x-forwarded-proto": "https", "x-forwarded-host": "panel.example.com", "x-forwarded-for": "192.168.64.1" };
    const health = await fetch(`${url}/api/health`, { headers: forwarded });
    expect(health.headers.get("strict-transport-security")).toBe("max-age=31536000");

    attached = false;
    await proxy.refresh();
    attached = true;
    const agent = await joinAgent(panel, url, { headers: forwarded });
    agents.push(agent);
    expect(agent.nodeId).not.toBe("");
    expect(panel.deps.agents.dialedAddress(agent.nodeId)).toBe("https://panel.example.com");
  } finally {
    for (const agent of agents) await agent.close();
    await panel.app.stop(true);
    panel.close();
  }
});

describe("cookies and headers", () => {
  async function login(panel: TestPanel, headers: Record<string, string>) {
    const { user, password } = await createUser(panel, "owner");
    return call(panel, auth.login, { email: user.email, password }, { headers });
  }

  test("the session cookie is Secure on the panel domain and over forwarded HTTPS, not on IP:port", async () => {
    const panel = make();
    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    const onDomain = await login(panel, { host: "panel.example.com" });
    expect(onDomain.status).toBe(200);
    expect(onDomain.headers.getSetCookie().join(";")).toContain("Secure");
    expect(onDomain.headers.get("strict-transport-security")).toBe("max-age=31536000");

    const onPort = await login(panel, { host: "203.0.113.5:3000" });
    expect(onPort.headers.getSetCookie().join(";")).not.toContain("Secure");
    expect(onPort.headers.get("strict-transport-security")).toBeNull();
    expect(onPort.headers.get("x-frame-options")).toBe("DENY");

    const proxied = make({ alwaysTrust: true });
    const forwarded = await login(proxied, { host: "panel.example.com", "x-forwarded-proto": "https" });
    expect(forwarded.headers.getSetCookie().join(";")).toContain("Secure");
    const untrusted = await login(panel, { host: "203.0.113.5:3000", "x-forwarded-proto": "https" });
    expect(untrusted.headers.getSetCookie().join(";")).not.toContain("Secure");
  });

  test("pages refuse framing, survive bad escapes and move to the live domain", async () => {
    const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
    dirs.push(dist);
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><head></head><body>app</body></html>");
    const panel = make({ webDist: dist });
    const get = (path: string, host = "203.0.113.5:3000") => panel.app.handle(new Request(`http://${host}${path}`, { headers: { host } }));

    const index = await get("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(index.headers.get("x-frame-options")).toBe("DENY");
    expect((await get("/%")).status).toBe(200);
    expect((await get("/p/%E0%A4%A")).status).toBe(200);

    setSetting(panel.deps.db, "panelDomain", "panel.example.com");
    setSetting(panel.deps.db, "panelDomainStatus", { domain: "panel.example.com", state: "active", message: "", checkedAt: Date.now() });
    const moved = await get("/settings?tab=a");
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("https://panel.example.com/settings?tab=a");
    // The domain itself, loopback (an SSH tunnel) and the API are served as before.
    expect((await get("/", "panel.example.com")).status).toBe(200);
    expect((await get("/", "127.0.0.1:3000")).status).toBe(200);
    expect((await get("/api/health")).status).toBe(200);
  });
});
