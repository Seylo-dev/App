// The Domains tab's red count and a domain behind Cloudflare's proxy whose
// origin the panel has not learned yet (0.2.16), on the demo data. On the
// owner's panel a red 1 sat on the tab for www, live with a valid
// certificate and no origin stored, and nothing on the page said why. A
// domain the panel is still checking does not count and its DNS chip's
// tooltip says it is being checked; one whose checks have not reached the
// node for 30 minutes counts, the badge's tooltip names it, and its row
// says why with Check again.

import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const domainsPage = `/p/${ids.acme}/s/${svc.web}/domains`;
const day = 86_400_000;
const minute = 60_000;

const domain = (id: string, host: string, over: Record<string, unknown> = {}) => ({
  id,
  serviceId: svc.web,
  host,
  pathPrefix: "/",
  stripPrefix: false,
  targetPort: 3000,
  https: "acme",
  redirectToHttps: true,
  auto: false,
  primary: id.endsWith("1"),
  forward: null,
  middlewares: { basicAuth: null, ipAllowList: [], rateLimit: null, redirects: [] },
  dnsStatus: "proxied",
  dnsCheckedAt: new Date(Date.now() - 3 * 60 * minute).toISOString(),
  pointsTo: ["203.0.113.10"],
  certificate: { status: "valid", expiresAt: new Date(Date.now() + 85 * day).toISOString(), issuer: "Let's Encrypt (R11)", error: null },
  liveAt: new Date(Date.now() - 3 * 60 * minute).toISOString(),
  url: `https://${host}`,
  createdAt: new Date(Date.now() - 3 * 60 * minute).toISOString(),
  updatedAt: new Date(Date.now() - 60 * minute).toISOString(),
  ...over,
});

/** The apex reaches the node; www's origin is whatever `www` holds. */
function world(www: Record<string, unknown>) {
  const state = { www };
  const checks: string[] = [];
  const apex = domain("o000000000000001", "example.com", { origin: "node", originCheckedAt: new Date(Date.now() - minute).toISOString() });
  return {
    state,
    checks,
    overrides: {
      "domains.list": () => ({ domains: [apex, domain("o000000000000002", "www.example.com", state.www)], autoDomainSuggestion: null }),
      "domains.checkDns": (input: Record<string, unknown>) => {
        checks.push(String(input.domainId));
        const d = input.domainId === apex.id ? apex : { host: "www.example.com", ...state.www };
        return {
          domainId: input.domainId,
          host: d.host,
          status: "proxied",
          message: `${d.host} is proxied by Cloudflare, so the panel cannot see where it points.`,
          expected: [{ type: "A", name: "www", value: "203.0.113.10" }],
          found: [{ type: "A", name: "www", value: "104.16.1.1" }],
          zone: "example.com",
          cloudflareManaged: true,
          cloudflareDnsUrl: "https://dash.cloudflare.com/?to=/:account/example.com/dns",
          ...("origin" in d && d.origin ? { origin: d.origin } : {}),
          ...("originReason" in d && d.originReason ? { originReason: d.originReason } : {}),
          checkedAt: new Date().toISOString(),
        };
      },
    },
  };
}

const row = (page: Page, host: string) => page.locator(`[data-domain="${host}"]`);
/** The red count on the Domains tab. */
const badge = (page: Page) => page.getByTestId("domains-to-fix");

test.describe("domains behind Cloudflare whose origin is not known", () => {
  test.use({ storageState: stateFile });

  test("not checked yet: no red count, and the chip's tooltip says it is being checked", async ({ page }) => {
    const w = world({});
    await installDemo(page, { overrides: w.overrides });
    await page.goto(domainsPage);
    const www = row(page, "www.example.com");
    await expect(www).toBeVisible();
    const chip = www.getByTestId("dns-chip");
    await expect(chip).toHaveAttribute("data-origin", "checking");
    await expect(chip).toHaveAttribute("title", /^Checking that requests reach 203\.0\.113\.10\.\.\./);
    await expect(badge(page)).toHaveCount(0);
    await expect(www.getByTestId("origin-unknown-note")).toHaveCount(0);
    await expect(www.getByRole("button", { name: "Check again" })).toHaveCount(0);

    // Unknown for a few minutes: still the panel's to check, still no count.
    w.state.www = {
      origin: "unknown",
      originCheckedAt: new Date(Date.now() - minute).toISOString(),
      originUnknownSince: new Date(Date.now() - 5 * minute).toISOString(),
    };
    await page.reload();
    await expect(row(page, "www.example.com").getByTestId("dns-chip")).toHaveAttribute("data-origin", "checking");
    await expect(badge(page)).toHaveCount(0);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/domain-origin-checking.png` });
  });

  test("not reached for 30 minutes: the count names it, and the row says why with Check again", async ({ page }) => {
    const w = world({
      origin: "unknown",
      originCheckedAt: new Date(Date.now() - minute).toISOString(),
      originUnknownSince: new Date(Date.now() - 45 * minute).toISOString(),
      originReason: "cloudflareUnreachable",
    });
    await installDemo(page, { overrides: w.overrides });
    await page.goto(domainsPage);
    await expect(badge(page)).toHaveText(/1/);
    await expect(badge(page)).toHaveAttribute("title", "1 domain needs setup: www.example.com");

    const www = row(page, "www.example.com");
    await expect(www.getByTestId("dns-chip")).toHaveAttribute("data-origin", "unknown");
    const note = www.getByTestId("origin-unknown-note");
    await expect(note).toHaveAttribute("data-reason", "cloudflareUnreachable");
    await expect(note).toContainText("Cloudflare cannot reach the node on port 443/80. Its record for www.example.com must point at 203.0.113.10");
    // The apex reaches the node: nothing under it.
    await expect(row(page, "example.com").getByTestId("origin-unknown-note")).toHaveCount(0);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/domain-origin-unknown.png` });

    // The firewall let Cloudflare in: Check again reaches the node, and the count goes.
    w.state.www = { origin: "node", originCheckedAt: new Date().toISOString() };
    await note.getByRole("button", { name: "Check again" }).click();
    await expect(www.getByTestId("dns-chip")).toHaveAttribute("data-origin", "node");
    await expect(badge(page)).toHaveCount(0);
    await expect(www.getByTestId("origin-unknown-note")).toHaveCount(0);
    expect(w.checks).toContain("o000000000000002");
  });
});
