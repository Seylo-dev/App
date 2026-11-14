// Alerts name the project of the service they are about (0.2.18): on the
// demo data the dashboard's Alerts card shows "acme-shop / worker crashed",
// and an alert about a service opens that service (by its ids). A node
// alert names its node only and links nowhere. Screenshots go to
// $SHOTS_DIR/alert-names.

import { mkdirSync } from "node:fs";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { dashboardHeading, expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/alert-names`;

test.use({ storageState: stateFile });

test("the dashboard's Alerts card names each service's project and opens the service", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await installDemo(page);
  await page.goto("/");
  await expect(dashboardHeading(page)).toBeVisible();
  const card = page.getByRole("region", { name: "Alerts" });

  const crash = card.getByRole("link", { name: "acme-shop / worker crashed" });
  await expect(crash).toBeVisible();
  await expect(crash).toHaveAttribute("href", `/p/${ids.acme}/s/${ids.worker}`);
  await expect(card.getByRole("link", { name: "acme-shop / web: shop.example.com is live" })).toBeVisible();
  // Node alerts stay as they are: the node's name, no project, no link.
  await expect(card.getByText("us-ash-1 is back online")).toBeVisible();
  await expect(card.getByRole("link", { name: /us-ash-1/ })).toHaveCount(0);
  await card.screenshot({ path: `${shots}/dashboard-alerts.png` });

  await crash.click();
  await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}/s/${ids.worker}$`));
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("worker");
});
