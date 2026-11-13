// The service header's run buttons on the demo data: Restart, Stop and
// Start carry an icon next to their label, Deploy stays text only, and the
// buttons keep their plain names (the icons are hidden from screen readers).

import type { Locator } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { servicesById, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const api = `/p/${ids.acme}/s/${svc.api}`;
const icons = (button: Locator) => button.locator("svg");

test.describe("service header", () => {
  test.use({ storageState: stateFile });

  test("Restart and Stop have icons, Deploy has none", async ({ page }) => {
    await installDemo(page);
    await page.goto(api);
    const header = page.locator("main header").first();
    const restart = header.getByRole("button", { name: "Restart", exact: true });
    const stop = header.getByRole("button", { name: "Stop", exact: true });
    const deploy = header.getByRole("button", { name: "Deploy", exact: true });
    await expect(restart).toBeVisible();
    await expect(icons(restart)).toHaveCount(1);
    await expect(icons(stop)).toHaveCount(1);
    await expect(icons(restart)).toHaveAttribute("aria-hidden", "true");
    await expect(icons(stop)).toHaveAttribute("aria-hidden", "true");
    await expect(deploy).toBeVisible();
    await expect(icons(deploy)).toHaveCount(0);
    await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "shots"}/service-header-icons.png`, clip: (await header.boundingBox()) ?? undefined });
  });

  test("a stopped service's Start has an icon", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "services.get": (input) => ({ ...(servicesById as Record<string, object>)[String(input.serviceId)], status: "stopped", stopped: true }),
      },
    });
    await page.goto(api);
    const header = page.locator("main header").first();
    const start = header.getByRole("button", { name: "Start", exact: true });
    await expect(start).toBeVisible();
    await expect(icons(start)).toHaveCount(1);
    await expect(icons(start)).toHaveAttribute("aria-hidden", "true");
    await expect(header.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);
  });
});
