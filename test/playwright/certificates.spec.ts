// Certificates on the Domains tab, on the demo data: "Generating SSL
// certificate" with a spinner while Let's Encrypt issues one, the red chip
// with the CA's reason and "Regenerate certificate" when it failed (in the
// row, its menu and the certificate dialog), Let's Encrypt's rate limit
// explained, and the row switching to Generating after a click. The ops
// answer from per-test overrides, which also record what was sent.

import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const domainsPage = `/p/${ids.acme}/s/${svc.web}/domains`;
const day = 86_400_000;

type Cert = { status: string; expiresAt: string | null; issuer: string | null; error: string | null };

const domain = (id: string, host: string, certificate: Cert) => ({
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
  dnsStatus: "ok",
  dnsCheckedAt: new Date(Date.now() - 60_000).toISOString(),
  certificate,
  liveAt: null,
  url: `https://${host}`,
  createdAt: new Date(Date.now() - 2 * day).toISOString(),
  updatedAt: new Date(Date.now() - day).toISOString(),
});

const pending: Cert = { status: "pending", expiresAt: null, issuer: null, error: null };
const failed = (error: string): Cert => ({ status: "failed", expiresAt: null, issuer: null, error });
const notFound =
  "api.example.com: The certificate authority refused the certificate (403): Invalid response from http://api.example.com/.well-known/acme-challenge/x: 404";
const rateLimited =
  'blog.example.com: The certificate authority refused the certificate (429): too many failed authorizations (5) for "blog.example.com" in the last 1h0m0s';

/** The demo service's domains; a retry turns one to pending, as the panel does. */
function world() {
  const list = [
    domain("c000000000000001", "shop.example.com", pending),
    domain("c000000000000002", "api.example.com", failed(notFound)),
    domain("c000000000000003", "blog.example.com", failed(rateLimited)),
    domain("c000000000000004", "docs.example.com", failed("docs.example.com: The certificate authority refused the certificate (400): DNS problem")),
  ];
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    overrides: {
      "domains.list": () => ({ domains: list, autoDomainSuggestion: null }),
      "domains.retryCertificate": (input: Record<string, unknown>) => {
        sent.push(input);
        const d = list.find((x) => x.id === input.domainId);
        if (!d) throw new Error("unknown domain");
        d.certificate = pending;
        return d;
      },
    },
  };
}

const row = (page: Page, host: string) => page.locator(`[data-domain="${host}"]`);

test.describe("certificates", () => {
  test.use({ storageState: stateFile });

  test("Generating, the CA's reason, Regenerate in the row, its menu and the dialog", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const w = world();
    await installDemo(page, { overrides: w.overrides });
    await page.goto(domainsPage);

    // Pending: a spinner and "Generating SSL certificate", no Regenerate button.
    const shop = row(page, "shop.example.com");
    await expect(shop.getByText("Generating SSL certificate")).toBeVisible();
    await expect(shop.getByTestId("certificate-generating").locator("svg.animate-spin")).toBeVisible();
    await expect(shop.getByRole("button", { name: "Regenerate certificate" })).toHaveCount(0);

    // Failed: the red chip, the CA's reason and the button.
    const api = row(page, "api.example.com");
    await expect(api.getByText("Certificate failed")).toBeVisible();
    await expect(api.getByText(/Invalid response from http:\/\/api\.example\.com/)).toBeVisible();
    const regenerate = api.getByRole("button", { name: "Regenerate certificate" });
    await expect(regenerate).toBeVisible();
    await expect(regenerate).toHaveCSS("cursor", "pointer");
    // Let's Encrypt's limit is explained only where the CA named it.
    await expect(row(page, "blog.example.com").getByText(/5 failed validations per host name per hour/)).toBeVisible();
    await expect(api.getByText(/5 failed validations/)).toHaveCount(0);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/certificates-failed.png` });

    // A click switches the row to Generating.
    await regenerate.click();
    await expect(api.getByText("Generating SSL certificate")).toBeVisible();
    await expect(api.getByRole("button", { name: "Regenerate certificate" })).toHaveCount(0);
    await expect(page.getByText("Asking Let's Encrypt again for api.example.com.")).toBeVisible();

    // The row's menu has the same action.
    const blog = row(page, "blog.example.com");
    await blog.getByRole("button", { name: "Actions for blog.example.com" }).click();
    await page.getByRole("menuitem", { name: "Regenerate certificate" }).click();
    await expect(blog.getByText("Generating SSL certificate")).toBeVisible();
    await expect(blog.getByText(/5 failed validations/)).toHaveCount(0);

    // And the certificate dialog.
    const docs = row(page, "docs.example.com");
    await docs.getByRole("button", { name: "Actions for docs.example.com" }).click();
    await page.getByRole("menuitem", { name: "Upload certificate" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("DNS problem")).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/certificates-dialog.png`, animations: "disabled" });
    await dialog.getByRole("button", { name: "Regenerate certificate" }).click();
    await expect(dialog.getByText("Generating SSL certificate")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(docs.getByText("Generating SSL certificate")).toBeVisible();

    expect(w.sent).toEqual([
      { serviceId: svc.web, domainId: "c000000000000002" },
      { serviceId: svc.web, domainId: "c000000000000003" },
      { serviceId: svc.web, domainId: "c000000000000004" },
    ]);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/certificates-generating.png` });
    expect(errors).toEqual([]);
  });

  test("a refused retry says why and the row stays failed", async ({ page }) => {
    const w = world();
    await installDemo(page, { overrides: w.overrides });
    // Registered after the demo routes, so it answers first.
    await page.route(/\/api\/v1\/domains\.retryCertificate/, (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "CONFLICT",
            message:
              "api.example.com points somewhere else. Change its A record to 203.0.113.10. Let's Encrypt checks the domain through that record, so a new certificate cannot be issued until it points at the node.",
            details: { reason: "dnsNotPointing", dnsStatus: "wrongTarget" },
          },
        }),
      }),
    );
    await page.goto(domainsPage);
    const api = row(page, "api.example.com");
    await api.getByRole("button", { name: "Regenerate certificate" }).click();
    await expect(page.getByText(/cannot be issued until it points at the node/)).toBeVisible();
    await expect(api.getByText("Certificate failed")).toBeVisible();
    await expect(api.getByRole("button", { name: "Regenerate certificate" })).toBeEnabled();
  });
});
