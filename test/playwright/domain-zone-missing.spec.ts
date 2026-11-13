// A domain whose registrable domain does not exist, on the demo data. The
// panel used to walk past it to the public suffix, so the row read "Add
// this record where co.il's DNS is managed: A app-preview.exampel
// <node ip>". Now the row says exampel.co.il does not exist (not
// registered, or no name servers yet), with "Did you mean" when the panel
// names a likely spelling, and keeps the record relative to the
// registrable domain; a domain that exists keeps its usual card. Adding
// such a domain keeps it and warns. Screenshots go to
// $SHOTS_DIR/domain-zone-missing.

import { mkdirSync } from "node:fs";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { handlers, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/domain-zone-missing`;

test.use({ storageState: stateFile });

const base = (handlers["domains.list"]?.({}) as { domains: Input[] }).domains;
const admin = base.find((d) => d.host === "admin.example.com") as Input;
// The owner meant example.co.il and typed exampel.co.il.
const typo = {
  ...admin,
  id: "m00000000000001a",
  host: "app-preview.exampel.co.il",
  url: "https://app-preview.exampel.co.il",
  pathPrefix: "/",
  primary: false,
  middlewares: { basicAuth: null, ipAllowList: [], rateLimit: null, redirects: [] },
};

const missingCheck = (input: Input, didYouMean?: string) => ({
  domainId: input.domainId,
  host: typo.host,
  status: "missing",
  message: `exampel.co.il does not exist: it is not registered, or has no name servers yet. Check the spelling.${didYouMean ? ` Did you mean ${didYouMean}?` : ""}`,
  expected: [{ type: "A", name: "app-preview", value: "203.0.113.10" }],
  found: [],
  zone: null,
  registrable: "exampel.co.il",
  zoneMissing: true,
  ...(didYouMean ? { didYouMean } : {}),
  cloudflareManaged: false,
  cloudflareDnsUrl: null,
  checkedAt: new Date().toISOString(),
});

async function open(page: import("@playwright/test").Page, didYouMean?: string) {
  await installDemo(page, {
    overrides: {
      "domains.list": () => ({ domains: [...base, typo], autoDomainSuggestion: null }),
      "domains.checkDns": (input: Input) =>
        input.domainId === typo.id ? missingCheck(input, didYouMean) : handlers["domains.checkDns"]?.(input),
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
}

test("a registrable domain that does not exist, with Did you mean; the card of a domain that exists is unchanged", async ({ page }) => {
  await open(page, "example.co.il");
  const row = page.locator(`[data-domain="${typo.host}"]`);
  const help = row.getByTestId("dns-help");
  await expect(help.getByTestId("zone-missing")).toHaveText(
    "exampel.co.il does not exist: it is not registered, or has no name servers yet. Check the spelling. Did you mean example.co.il?",
  );
  await expect(help.getByTestId("did-you-mean")).toHaveText("Did you mean example.co.il?");
  // Not where co.il's DNS is managed, and not the record name with the domain glued on.
  await expect(help.getByText(/DNS is managed/)).toHaveCount(0);
  await expect(help.getByText("The record to create once it exists:")).toBeVisible();
  await expect(help.getByText("app-preview", { exact: true })).toBeVisible();
  await expect(help.getByText("app-preview.exampel", { exact: true })).toHaveCount(0);
  await expect(help.getByRole("button", { name: "Check now" })).toBeVisible();
  // admin.example.com exists: its card reads as before.
  const adminHelp = page.locator('[data-domain="admin.example.com"]').getByTestId("dns-help");
  await expect(adminHelp.getByText("Add this record where example.com's DNS is managed:")).toBeVisible();
  await expect(adminHelp.getByText("admin", { exact: true })).toBeVisible();
  await expect(adminHelp.getByTestId("zone-missing")).toHaveCount(0);
  mkdirSync(shots, { recursive: true });
  await row.screenshot({ path: `${shots}/zone-missing-did-you-mean.png` });
});

test("without a likely spelling the viewer can see: no Did you mean", async ({ page }) => {
  await open(page);
  const help = page.locator(`[data-domain="${typo.host}"]`).getByTestId("dns-help");
  await expect(help.getByTestId("zone-missing")).toHaveText(
    "exampel.co.il does not exist: it is not registered, or has no name servers yet. Check the spelling.",
  );
  await expect(help.getByTestId("did-you-mean")).toHaveCount(0);
  await expect(help.getByText(/DNS is managed/)).toHaveCount(0);
  mkdirSync(shots, { recursive: true });
  await page.locator(`[data-domain="${typo.host}"]`).screenshot({ path: `${shots}/zone-missing.png` });
});

test("adding a domain whose registrable domain does not exist keeps it and warns", async ({ page }) => {
  await installDemo(page, {
    overrides: {
      "domains.add": (input: Input) => ({
        domain: {
          ...typo,
          host: input.host,
          warning: {
            reason: "registrableMissing",
            registrable: "exampel.co.il",
            didYouMean: "example.co.il",
            message: "exampel.co.il does not exist: it is not registered, or has no name servers yet. Check the spelling. Did you mean example.co.il?",
          },
        },
        dns: missingCheck({ domainId: typo.id }, "example.co.il"),
      }),
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/domains`);
  await page.getByRole("button", { name: "Add domain" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add a domain" });
  await dialog.getByLabel("Domain", { exact: true }).fill(typo.host);
  await dialog.getByRole("button", { name: "Add domain" }).click();
  await expect(dialog).toHaveCount(0);
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast.getByText("Domain added, but exampel.co.il does not exist.")).toBeVisible();
  await expect(toast.getByText("It is not registered, or has no name servers yet. Check the spelling. Did you mean example.co.il?")).toBeVisible();
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/added-warning.png` });
});
