// The Add domain dialog on the demo data: on a service with no port the
// Container port field says 80 and an empty field adds the domain on 80
// (the PORT a repository-built app gets); on a service with no primary
// domain yet "Make it the primary domain" is ticked and locked, since the
// panel makes that domain primary anyway; with a primary one it is a free
// choice, off. A working domain's chip names where its DNS points, and what
// the panel's origin check found: that requests reach the node (behind
// Cloudflare's proxy too), or a red chip with the record to set in
// Cloudflare when another server answers. Behind the proxy a certificate
// waits for Cloudflare, with what Cloudflare answered the check when that
// says why (Full (strict), the node out of its reach). Screenshots go to
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

test("the container port takes any port typed in, and lists the service's own", async ({ page }) => {
  const calls = watchOps(page);
  // The api declares port 3000; it may listen on another one too.
  await installDemo(page, { overrides: { "domains.add": added } });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  await page.getByRole("button", { name: "Add domain" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add a domain" });
  const port = dialog.getByLabel("Container port");
  await expect(port).toHaveValue("3000");
  // Typed: digits only, any port.
  await port.fill("");
  await port.pressSequentially("81x81");
  await expect(port).toHaveValue("8181");
  // Picked from the list: the service's ports.
  await dialog.getByRole("button", { name: "Show the service's ports" }).click();
  const list = page.getByRole("listbox", { name: "Container port" });
  await expect(list.getByRole("option")).toHaveText(["3000"]);
  await list.getByRole("option", { name: "3000" }).click();
  await expect(port).toHaveValue("3000");
  // Typed again and sent as typed.
  await port.fill("8181");
  await dialog.getByLabel("Domain", { exact: true }).fill("alt.example.com");
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/custom-port.png` });
  await dialog.getByRole("button", { name: "Add domain" }).click();
  await expect
    .poll(() => calls("domains.add"))
    .toEqual([expect.objectContaining({ serviceId: svc.api, host: "alt.example.com", targetPort: 8181 })]);
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
  // Asking Let's Encrypt from before the panel waited for DNS (a domain kept on it by the 0.2.8 update).
  const unchecked = { ...shop, id: "m00000000000000a", host: "blog.example.com", url: "https://blog.example.com", primary: false, origin: undefined, originCheckedAt: undefined };
  await installDemo(page, { overrides: { "domains.list": () => ({ domains: [shop, unchecked], autoDomainSuggestion: null }) } });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  await expect(page.locator('[data-domain="shop.example.com"]').getByText("Generating SSL certificate")).toBeVisible();
  await expect(page.locator('[data-domain="shop.example.com"]').getByText(/cannot see where its record points/)).toHaveCount(0);
  await expect(page.locator('[data-domain="shop.example.com"]').getByRole("button", { name: "Check again" })).toHaveCount(0);
  const blog = page.locator('[data-domain="blog.example.com"]');
  await expect(blog.getByText(/cannot see where its record points/)).toBeVisible();
  // Before, this note had no way to check again.
  await expect(blog.getByRole("button", { name: "Check again" })).toBeVisible();
});

test("behind Cloudflare the certificate waits for Cloudflare; Check again runs the check at once and the certificate starts", async ({ page }) => {
  const calls = watchOps(page);
  const base = (handlers["domains.list"]?.({}) as { domains: Input[] }).domains;
  const pending = { status: "pending", expiresAt: null, issuer: null, error: null };
  const waiting = {
    ...base[0],
    id: "m00000000000000b",
    host: "verifly.example.com",
    url: "https://verifly.example.com",
    origin: undefined,
    originCheckedAt: undefined,
    liveAt: null,
    certificate: { ...pending, waitingForDns: true },
    createdAt: new Date().toISOString(),
  };
  // The checks on opening get no answer through Cloudflare; once the record there is fixed, they reach the node.
  let fixed = false;
  await installDemo(page, {
    delay: (op) => (op === "domains.checkDns" ? 700 : 0),
    overrides: {
      "domains.list": () => ({
        domains: [fixed ? { ...waiting, origin: "node", originCheckedAt: new Date().toISOString(), certificate: pending } : waiting],
        autoDomainSuggestion: null,
      }),
      "domains.checkDns": (input) => {
        return {
          domainId: input.domainId,
          host: waiting.host,
          status: "proxied",
          message: `${waiting.host} is proxied by Cloudflare, so the panel cannot see where it points.`,
          expected: [{ type: "A", name: "verifly", value: "203.0.113.10" }],
          found: [{ type: "A", name: "verifly", value: "104.16.1.1" }],
          zone: "example.com",
          cloudflareManaged: true,
          cloudflareDnsUrl: "https://dash.cloudflare.com/?to=/:account/example.com/dns",
          origin: fixed ? "node" : "unknown",
          checkedAt: new Date().toISOString(),
        };
      },
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  const row = page.locator('[data-domain="verifly.example.com"]');
  // Not Generating: nothing asks Let's Encrypt until the domain reaches the node.
  // The record in Cloudflare is set; what the certificate waits for is the check through Cloudflare.
  await expect(row.getByTestId("certificate-waiting")).toHaveText("Certificate waits for Cloudflare");
  await expect(row.getByText("Generating SSL certificate")).toHaveCount(0);
  await expect(row.getByText(/point that record in Cloudflare at 203\.0\.113\.10\. If it already does and SSL\/TLS is on Full \(strict\), turn off Always Use HTTPS/)).toBeVisible();
  // The note checks on opening; the button waits for that check, then runs one at once.
  const again = row.getByRole("button", { name: "Check again" });
  await expect(again).toBeEnabled();
  const opened = calls("domains.checkDns").length;
  expect(opened).toBeGreaterThanOrEqual(1);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/certificate-waits-for-dns.png` });
  // The owner points the record in Cloudflare at the node.
  fixed = true;
  await again.click();
  await expect(again).toBeDisabled();
  await expect(again.locator("svg.animate-spin")).toBeVisible();
  // The record reaches the node now: the row refreshes and the certificate is on its way.
  await expect(row.getByText("Generating SSL certificate")).toBeVisible();
  await expect(row.getByTestId("certificate-waiting")).toHaveCount(0);
  expect(calls("domains.checkDns")).toHaveLength(opened + 1);
  expect(calls("domains.checkDns").at(-1)).toEqual({ serviceId: svc.api, domainId: "m00000000000000b" });
});

test("behind Cloudflare the row says what Cloudflare answered the check: Full (strict), then the node out of reach", async ({ page }) => {
  const base = (handlers["domains.list"]?.({}) as { domains: Input[] }).domains;
  const pending = { status: "pending", expiresAt: null, issuer: null, error: null };
  // SSL/TLS Full (strict) with Always Use HTTPS: Cloudflare refused the node's temporary certificate (526).
  let reason: string | undefined = "cloudflareCertificate";
  const waiting = () => ({
    ...base[0],
    id: "m00000000000000c",
    host: "strict.example.com",
    url: "https://strict.example.com",
    origin: reason ? "unknown" : "node",
    originCheckedAt: new Date().toISOString(),
    ...(reason ? { originReason: reason } : {}),
    liveAt: null,
    certificate: reason ? { ...pending, waitingForDns: true } : pending,
    createdAt: new Date().toISOString(),
  });
  await installDemo(page, {
    overrides: {
      "domains.list": () => ({ domains: [waiting()], autoDomainSuggestion: null }),
      "domains.checkDns": (input) => ({
        domainId: input.domainId,
        host: "strict.example.com",
        status: "proxied",
        message: "strict.example.com is proxied by Cloudflare, so the panel cannot see where it points.",
        expected: [{ type: "A", name: "strict", value: "203.0.113.10" }],
        found: [{ type: "A", name: "strict", value: "104.16.1.1" }],
        zone: "example.com",
        cloudflareManaged: true,
        cloudflareDnsUrl: "https://dash.cloudflare.com/?to=/:account/example.com/dns",
        origin: reason ? "unknown" : "node",
        ...(reason ? { originReason: reason } : {}),
        checkedAt: new Date().toISOString(),
      }),
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  const row = page.locator('[data-domain="strict.example.com"]');
  await expect(row.getByTestId("certificate-waiting")).toHaveText("Certificate waits for Cloudflare");
  const note = row.getByTestId("pending-cert-note");
  await expect(note).toHaveAttribute("data-reason", "cloudflareCertificate");
  await expect(note).toContainText(
    "Cloudflare's SSL mode Full (strict) refuses the node's temporary certificate until Let's Encrypt issues one: set SSL/TLS to Full for a few minutes, or turn off Always Use HTTPS, then Check again.",
  );
  // Not the general sentence besides.
  await expect(row.getByText(/cannot see where its record points/)).toHaveCount(0);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/certificate-waits-for-cloudflare.png` });

  // SSL/TLS set to Full, but now Cloudflare cannot connect to the node (521).
  reason = "cloudflareUnreachable";
  await note.getByRole("button", { name: "Check again" }).click();
  await expect(note).toHaveAttribute("data-reason", "cloudflareUnreachable");
  await expect(note).toContainText("Cloudflare cannot reach the node on port 443/80. Its record for strict.example.com must point at 203.0.113.10");

  // The firewall lets Cloudflare in: the check reaches the node and the certificate starts.
  reason = undefined;
  await note.getByRole("button", { name: "Check again" }).click();
  await expect(row.getByText("Generating SSL certificate")).toBeVisible();
  await expect(row.getByTestId("certificate-waiting")).toHaveCount(0);
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
