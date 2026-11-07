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
import { createUser, type TestPanel, testPanel } from "./helpers";
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

  test("X-Forwarded-For counts only from a trusted peer", () => {
    const request = new Request("http://panel/", { headers: { "x-forwarded-for": "198.51.100.7" } });
    expect(clientIp(request, "172.18.0.3", true)).toBe("198.51.100.7");
    expect(clientIp(request, "203.0.113.9", false)).toBe("203.0.113.9");
  });
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
