// Alerts name the project of the service they are about (0.2.18): on the
// demo data the dashboard's Alerts card shows "acme-shop / worker crashed",
// and an alert about a service opens that service (by its ids), in the
// project it is in now when it moved since the alert. A node alert names
// its node only and links nowhere. Screenshots go to $SHOTS_DIR/alert-names.

import { mkdirSync } from "node:fs";
import { alerts, ids } from "./demo/fixtures";
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

test("an alert about a service moved to another project since opens the service where it is now", async ({ page }) => {
  // "blog" crashed while it was in acme-shop, then moved to personal: the title keeps the project it happened in.
  const moved = {
    ...alerts.alerts[0],
    id: "alert00000000009",
    title: "acme-shop / blog crashed",
    projectId: ids.acme,
    serviceId: ids.blog,
    projectName: "acme-shop",
    serviceName: "blog",
    serviceProjectId: ids.personal,
    link: `/p/${ids.personal}/s/${ids.blog}`,
  };
  await installDemo(page, { overrides: { "alerts.list": () => ({ alerts: [moved], nextCursor: null }) } });
  await page.goto("/");
  await expect(dashboardHeading(page)).toBeVisible();
  const link = page.getByRole("region", { name: "Alerts" }).getByRole("link", { name: "acme-shop / blog crashed" });
  await expect(link).toHaveAttribute("href", `/p/${ids.personal}/s/${ids.blog}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/p/${ids.personal}/s/${ids.blog}$`));
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("personal");
});
