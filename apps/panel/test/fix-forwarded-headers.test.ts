// Forwarded headers count only from a trusted proxy: the cross-site check
// ignores a client's X-Forwarded-Host, and behind Cloudflare the visitor's
// address comes from CF-Connecting-IP only when Traefik saw a Cloudflare
// address, so sign-in locks and limits stop collapsing onto Cloudflare's.

import { afterEach, describe, expect, test } from "bun:test";
import { auth, projects } from "@seylo/ops";
import { clientIp } from "../src/http/client-ip";
import { isCloudflareAddress } from "../src/http/cloudflare";
import { ipBytes } from "../src/http/ip-ranges";
import { isSameOrigin } from "../src/http/origin";
import { createProxyTrust } from "../src/http/proxy-trust";
import { createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits } from "./people-helpers";

const panels: TestPanel[] = [];
afterEach(() => {
  for (const p of panels.splice(0)) p.close();
});

function make(alwaysTrust: boolean) {
  const panel = testPanel({ rateLimiter: noLimits, proxy: createProxyTrust({ always: alwaysTrust, proxies: [] }) });
  panels.push(panel);
  return panel;
}

describe("isSameOrigin", () => {
  const forged = new Request("http://panel.example.com/api/v1/projects.create", {
    method: "POST",
    headers: { host: "panel.example.com", origin: "https://evil.example", "x-forwarded-host": "evil.example" },
  });

  test("X-Forwarded-Host from an untrusted client does not make a foreign origin same-origin", () => {
    expect(isSameOrigin(forged)).toBe(false);
    expect(isSameOrigin(forged, false)).toBe(false);
  });

  test("a trusted proxy's X-Forwarded-Host still counts", () => {
    expect(isSameOrigin(forged, true)).toBe(true);
    const plain = new Request("http://panel.example.com/", { headers: { host: "panel.example.com", origin: "https://panel.example.com" } });
    expect(isSameOrigin(plain)).toBe(true);
  });

  test("a cookie request that sets both headers is refused as cross-site", async () => {
    const panel = make(false);
    const owner = await createUser(panel, "owner");
    const result = await call(
      panel,
      projects.create,
      { name: "forged" },
      { cookie: owner.cookie, headers: { host: "panel.example.com", origin: "https://evil.example", "x-forwarded-host": "evil.example" } },
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain("Cross-site");
  });
});

describe("client address", () => {
  test("CF-Connecting-IP counts only when the trusted proxy saw a Cloudflare address", () => {
    const viaCloudflare = new Request("http://panel/", {
      headers: { "x-forwarded-for": "172.64.10.20", "cf-connecting-ip": "198.51.100.7" },
    });
    expect(clientIp(viaCloudflare, "172.18.0.3", true)).toBe("198.51.100.7");
    // Straight to the node with a made-up header: Traefik saw the sender itself.
    const direct = new Request("http://panel/", { headers: { "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "198.51.100.7" } });
    expect(clientIp(direct, "172.18.0.3", true)).toBe("203.0.113.9");
    // No trusted proxy: neither header counts.
    expect(clientIp(viaCloudflare, "203.0.113.50", false)).toBe("203.0.113.50");
    // Not an address: ignored.
    const junk = new Request("http://panel/", { headers: { "x-forwarded-for": "172.64.10.20", "cf-connecting-ip": "not-an-ip" } });
    expect(clientIp(junk, "172.18.0.3", true)).toBe("172.64.10.20");
  });

  test("addresses are normalised", () => {
    expect(clientIp(new Request("http://panel/"), "::ffff:203.0.113.5", false)).toBe("203.0.113.5");
    expect(clientIp(new Request("http://panel/"), "2001:DB8::1", false)).toBe("2001:db8::1");
  });

  test("Cloudflare's ranges, IPv4 and IPv6", () => {
    expect(isCloudflareAddress("104.16.1.1")).toBe(true);
    expect(isCloudflareAddress("::ffff:104.16.1.1")).toBe(true);
    expect(isCloudflareAddress("2606:4700:10::6816:1")).toBe(true);
    expect(isCloudflareAddress("2a06:98c7:ffff::1")).toBe(true);
    expect(isCloudflareAddress("8.8.8.8")).toBe(false);
    expect(isCloudflareAddress("2001:db8::1")).toBe(false);
    expect(isCloudflareAddress("garbage")).toBe(false);
  });

  test("IPv6 parsing expands :: and dotted tails", () => {
    expect([...(ipBytes("2001:db8::1") ?? [])]).toEqual([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect([...(ipBytes("64:ff9b::192.0.2.1") ?? [])].slice(12)).toEqual([192, 0, 2, 1]);
    expect(ipBytes("1::2::3")).toBeNull();
  });

  test("two visitors behind one Cloudflare address have their own sign-in locks", async () => {
    const panel = make(true);
    const { user, password } = await createUser(panel, "owner");
    const via = (visitor: string) => ({ headers: { "x-forwarded-for": "172.64.10.20", "cf-connecting-ip": visitor } });
    for (let i = 0; i < 6; i++) await call(panel, auth.login, { email: user.email, password: "wrong-password" }, via("198.51.100.66"));
    expect((await call(panel, auth.login, { email: user.email, password }, via("198.51.100.66"))).status).toBe(429);
    expect((await call(panel, auth.login, { email: user.email, password }, via("203.0.113.5"))).status).toBe(200);
  });
});

// A form post from a page with referrer policy no-referrer carries "Origin: null"
// (Fetch standard); the browser's Sec-Fetch-Site, which pages cannot set, then decides.
test("isSameOrigin: Origin null counts only with Sec-Fetch-Site same-origin", () => {
  const post = (headers: Record<string, string>) =>
    new Request("http://panel.test/oauth/authorize", { method: "POST", headers: { host: "panel.test", ...headers } });
  expect(isSameOrigin(post({ origin: "null", "sec-fetch-site": "same-origin" }))).toBe(true);
  expect(isSameOrigin(post({ origin: "null", "sec-fetch-site": "same-site" }))).toBe(false);
  expect(isSameOrigin(post({ origin: "null", "sec-fetch-site": "cross-site" }))).toBe(false);
  expect(isSameOrigin(post({ origin: "null" }))).toBe(false);
  expect(isSameOrigin(post({ origin: "http://panel.test" }))).toBe(true);
  expect(isSameOrigin(post({ origin: "https://evil.example", "sec-fetch-site": "same-origin" }))).toBe(false);
});
