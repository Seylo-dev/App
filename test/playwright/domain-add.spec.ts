// The Add domain dialog on the demo data: on a service with no port the
// Container port field says 80 and an empty field adds the domain on 80
// (the PORT a repository-built app gets); on a service with no primary
// domain yet "Make it the primary domain" is ticked and locked, since the
// panel makes that domain primary anyway; with a primary one it is a free
// choice, off. A working domain's chip names where its DNS points, and what
// the panel's origin check found: that requests reach the node (behind
// Cloudflare's proxy too), or a red chip with the record to set in
// Cloudflare when another server answers. Screenshots go to
// $SHOTS_DIR/domain-add.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { handlers, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/domain-add`;

test.use({ storageState: stateFile });

function watchOps(page: Page) {
  const calls: { op: string; input: Input }[] = [];
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (!match) return;
    const input = request.method() === "GET" ? Object.fromEntries(new URL(request.url()).searchParams) : (request.postDataJSON() ?? {});
    calls.push({ op: match[1] as string, input });
  });
  return (op: string) => calls.filter((c) => c.op === op).map((c) => c.input);
}

const added = (input: Input) => ({
  domain: { id: "m00000000000000f", host: input.host, primary: true, targetPort: input.targetPort },
  dns: { status: "ok" },
});

test("the first domain of a portless app: port 80 by default, and primary ticked and locked", async ({ page }) => {
  const calls = watchOps(page);
  // The worker has no port; nothing on it yet.
  await installDemo(page, { overrides: { "domains.list": () => ({ domains: [], autoDomainSuggestion: null }), "domains.add": added } });
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/domains`);
  await page.getByRole("button", { name: "Add domain" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add a domain" });
  await expect(dialog.getByLabel("Container port")).toHaveAttribute("placeholder", "80");
  await expect(dialog.getByLabel("Container port")).toHaveValue("");
  const primary = dialog.getByRole("checkbox", { name: "Make it the primary domain" });
  await expect(primary).toBeChecked();
  await expect(primary).toBeDisabled();
  await dialog.getByLabel("Domain", { exact: true }).fill("jobs.example.com");
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/first-domain.png` });
  await dialog.getByRole("button", { name: "Add domain" }).click();
  await expect
    .poll(() => calls("domains.add"))
    .toEqual([expect.objectContaining({ serviceId: svc.worker, host: "jobs.example.com", targetPort: 80, primary: true })]);
});

test("with a primary domain already, the box is a free choice and starts off", async ({ page }) => {
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  await page.getByRole("button", { name: "Add domain" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add a domain" });
  const primary = dialog.getByRole("checkbox", { name: "Make it the primary domain" });
  await expect(primary).not.toBeChecked();
  await expect(primary).toBeEnabled();
  await primary.click();
  await expect(primary).toBeChecked();
});

test("a working domain names the address its DNS points at; behind Cloudflare's proxy, the origin", async ({ page }) => {
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  // shop.example.com is proxied by Cloudflare: the chip names the origin to set there.
  const shop = page.locator('[data-domain="shop.example.com"]');
  await expect(shop.getByTestId("dns-chip")).toHaveText("Cloudflare proxy → 203.0.113.10");
  await expect(shop.getByTestId("dns-chip")).toHaveAttribute("title", /behind Cloudflare's proxy\. Its record in Cloudflare should point at 203\.0\.113\.10/);
  // www.example.com points straight at the node.
  const www = page.locator('[data-domain="www.example.com"]');
  await expect(www.getByTestId("dns-chip")).toHaveText("DNS → 203.0.113.10");
  // The automatic domain needs no record of its own; the one waiting for DNS shows the record to create instead.
  await expect(page.locator('[data-domain="web.de1.example.com"]').getByTestId("dns-chip")).toHaveCount(0);
  const admin = page.locator('[data-domain="admin.example.com"]');
  await expect(admin.getByTestId("dns-chip")).toHaveCount(0);
  await expect(admin.getByText("Waiting for DNS")).toBeVisible();
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/dns-chips.png` });
});

test("the origin check: a proxied domain that reaches the node, and one whose record in Cloudflare points elsewhere", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  // shop.example.com: the panel's check reached the node through Cloudflare.
  const shop = page.locator('[data-domain="shop.example.com"]').getByTestId("dns-chip");
  await expect(shop).toHaveText("Cloudflare proxy → 203.0.113.10");
  await expect(shop).toHaveAttribute("data-origin", "node");
  await expect(shop).toHaveAttribute("title", /Requests to it reach this node\./);
  // api.example.com: something else answered. A red chip, and the record to set in Cloudflare below the row.
  const api = page.locator('[data-domain="api.example.com"]');
  await expect(api.getByTestId("dns-chip")).toHaveText("Cloudflare proxy, not this node");
  await expect(api.getByTestId("dns-chip")).toHaveAttribute("title", /reach another server, not this node\. Its record in Cloudflare must point at 203\.0\.113\.10/);
  const help = api.getByTestId("origin-help");
  await expect(help).toContainText("The record for api.example.com in Cloudflare must point at 203.0.113.10, this service's node.");
  await expect(help.getByText("api", { exact: true })).toBeVisible();
  await expect(help.getByRole("link", { name: "Open Cloudflare DNS" })).toHaveAttribute("href", /dash\.cloudflare\.com/);
  // Not the sentence for a proxied record the panel cannot see through.
  await expect(api.getByText(/cannot see where its record points/)).toHaveCount(0);
  // Opening the row checked again; Check now does it at once.
  const checks = () => calls("domains.checkDns").filter((c) => c.domainId === "m000000000000005").length;
  await expect.poll(checks).toBeGreaterThanOrEqual(1);
  const before = checks();
  await help.getByRole("button", { name: "Check now" }).click();
  await expect.poll(checks).toBeGreaterThan(before);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/origin-elsewhere.png` });
});

test("a certificate on its way behind Cloudflare: the proxied-record sentence only until the check reached the node", async ({ page }) => {
  const base = (handlers["domains.list"]?.({}) as { domains: Input[] }).domains;
  const shop = { ...base[0], certificate: { status: "pending", expiresAt: null, issuer: null, error: null }, liveAt: null, createdAt: new Date().toISOString() };
  const unchecked = { ...shop, id: "m00000000000000a", host: "blog.example.com", url: "https://blog.example.com", primary: false, origin: undefined, originCheckedAt: undefined };
  await installDemo(page, { overrides: { "domains.list": () => ({ domains: [shop, unchecked], autoDomainSuggestion: null }) } });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  await expect(page.locator('[data-domain="shop.example.com"]').getByText("Generating SSL certificate")).toBeVisible();
  await expect(page.locator('[data-domain="shop.example.com"]').getByText(/cannot see where its record points/)).toHaveCount(0);
  await expect(page.locator('[data-domain="blog.example.com"]').getByText(/cannot see where its record points/)).toBeVisible();
});

test("the Overview's domains card flags a domain that does not reach the node", async ({ page }) => {
  const base = (handlers["domains.list"]?.({}) as { domains: Input[] }).domains;
  const api = base.find((d) => d.host === "api.example.com");
  await installDemo(page, { overrides: { "domains.list": () => ({ domains: [api, base[0]], autoDomainSuggestion: null }) } });
  await page.goto(`/p/${ids.acme}/s/${svc.api}`);
  const card = page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name: "Domains", exact: true }) });
  await expect(card.locator("li").filter({ hasText: "api.example.com" }).getByText("Not reaching this node")).toBeVisible();
  await expect(card.locator("li").filter({ hasText: "shop.example.com" }).getByText("Not reaching this node")).toHaveCount(0);
});

test("the Overview's Domains card adds a domain with its + button", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page, { overrides: { "domains.add": added } });
  await page.goto(`/p/${ids.acme}/s/${svc.api}`);
  const card = page.getByRole("heading", { name: "Domains", level: 2 }).locator("xpath=ancestor::*[@data-slot='card'][1]");
  await card.getByRole("button", { name: "Add domain" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a domain" });
  await dialog.getByLabel("Domain", { exact: true }).fill("api2.example.com");
  await dialog.getByRole("button", { name: "Add domain" }).click();
  await expect.poll(() => calls("domains.add").length).toBe(1);
  expect(calls("domains.add")[0]).toMatchObject({ serviceId: svc.api, host: "api2.example.com" });
});
