// Settings > AI assistant on the demo data: with no key stored, the key
// field links to the Claude Console's API keys page and lists the steps to
// get one (sign in, credits, create, paste); with a key, the steps are gone.

import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

test("without a key: a clickable Console link and the steps to create one", async ({ page }) => {
  await installDemo(page, {
    overrides: {
      "ai.settings": () => ({
        enabled: false,
        keySet: false,
        keyHint: null,
        routing: { mode: "auto", model: "sonnet", allowOpus: false },
        monthlyBudgetUsd: 50,
        allowMembers: false,
      }),
    },
  });
  await page.goto("/settings/ai");
  await expect(page.getByRole("link", { name: "API keys", exact: true }).first()).toHaveAttribute("href", "https://platform.claude.com/settings/keys");
  const steps = page.getByRole("list", { name: "How to get a key" });
  await expect(steps.getByRole("listitem")).toHaveCount(4);
  await expect(steps.getByRole("link", { name: "platform.claude.com" })).toHaveAttribute("href", "https://platform.claude.com");
  await expect(steps.getByRole("link", { name: "Billing" })).toHaveAttribute("href", "https://platform.claude.com/settings/billing");
  await expect(steps).toContainText("shown only once");
});

test("with a key stored: no steps", async ({ page }) => {
  await installDemo(page);
  await page.goto("/settings/ai");
  await expect(page.getByText("A key ending in x9Qa is stored.")).toBeVisible();
  await expect(page.getByRole("list", { name: "How to get a key" })).toHaveCount(0);
});
