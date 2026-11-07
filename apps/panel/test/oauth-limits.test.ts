// The public OAuth endpoints read their bodies through the capped reader
// (a small limit and the panel's shared body budget), and client
// registration is limited per address group: an IPv6 /64 counts as one.

import { afterEach, expect, test } from "bun:test";
import { createProxyTrust } from "../src/http/proxy-trust";
import { oauthBodyBytes } from "../src/modules/mcp/oauth";
import { setSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";

const panels: TestPanel[] = [];
afterEach(() => {
  for (const panel of panels.splice(0)) panel.close();
});

function make() {
  // The proxy is trusted so the test can name the caller's address with X-Forwarded-For.
  const panel = testPanel({ proxy: createProxyTrust({ always: true, proxies: [] }) });
  panels.push(panel);
  setSetting(panel.deps.db, "mcpEnabled", true);
  return panel;
}

const send = (panel: TestPanel, path: string, body: string, from = "198.51.100.7", type = "application/json") =>
  panel.app.handle(
    new Request(`http://panel.test${path}`, {
      method: "POST",
      headers: { host: "panel.test", "content-type": type, "x-forwarded-for": from },
      body,
    }),
  );

const registration = JSON.stringify({ client_name: "x", redirect_uris: ["http://127.0.0.1:1/cb"] });

test("an OAuth body over the limit is refused before it is parsed", async () => {
  const panel = make();
  const big = JSON.stringify({ client_name: "x", redirect_uris: ["http://127.0.0.1:1/cb"], padding: "a".repeat(oauthBodyBytes) });
  expect((await send(panel, "/oauth/register", big)).status).toBe(413);
  expect(
    (
      await send(
        panel,
        "/oauth/token",
        `grant_type=refresh_token&pad=${"a".repeat(oauthBodyBytes)}`,
        undefined,
        "application/x-www-form-urlencoded",
      )
    ).status,
  ).toBe(413);
  expect(
    (await send(panel, "/oauth/revoke", `token=${"a".repeat(oauthBodyBytes)}`, undefined, "application/x-www-form-urlencoded")).status,
  ).toBe(413);
  expect((await send(panel, "/oauth/register", registration)).status).toBe(201);
});

test("registrations from one IPv6 /64 share one limit", async () => {
  const panel = make();
  const statuses: number[] = [];
  for (let i = 1; i <= 11; i++)
    statuses.push((await send(panel, "/oauth/register", registration, `2001:db8:1:2::${i.toString(16)}`)).status);
  expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
  expect(statuses[10]).toBe(429);
  // Another /64 has its own.
  expect((await send(panel, "/oauth/register", registration, "2001:db8:1:3::1")).status).toBe(201);
});
