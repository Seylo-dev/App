// The status dot says whether the app is up, the label what a deploy does
// (0.2.17), on the demo data: web runs its live version while its next
// build waits for a build slot, worker's first deploy waits for one. The
// sidebar, the dashboard's Cards, List and Table, the project page, the
// command palette and the service header show web's dot green next to
// "waiting", and worker's as a pending ring, not the gray dot of a stopped
// service. Answers without runtimeStatus (panels before 0.2.17) keep the
// gray dot. Screenshots go to $SHOTS_DIR/status-dot.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids, services as demoServices } from "./demo/fixtures";
import { type Handler, installDemo } from "./demo/routes";
import { servicesById } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/status-dot`;

test.use({ storageState: stateFile });

/** web's next build and worker's first one wait for a build slot; runtimeStatus as a 0.2.17 panel sends it, or left out. */
function waitingBuilds(withRuntime = true): Record<string, Handler> {
  const change = (service: Input): Input => {
    if (service.id !== ids.web && service.id !== ids.worker) return service;
    const first = service.id === ids.worker;
    const { runtimeStatus: _, ...rest } = service;
    return {
      ...rest,
      status: "building",
      buildWaiting: true,
      ...(first ? { liveDeployment: null } : {}),
      ...(withRuntime ? { runtimeStatus: first ? "idle" : "running" } : {}),
    };
  };
  return {
    "services.list": (input) => ({ services: (demoServices[String(input.projectId ?? "")] ?? []).map((s) => change(s as Input)) }),
    "services.get": (input) => change({ ...(servicesById as Record<string, Input>)[String(input.serviceId)] }),
  };
}

const toService = (id: string) => `a[href$="/s/${id}"]`;
const sidebarRow = (page: Page, id: string) => page.locator(`nav[aria-label="Main"] ${toService(id)}`);
const projects = (page: Page) => page.getByRole("region", { name: "Projects" });
const dotOf = (scope: Locator) => scope.locator("[data-dot]").first();

async function pickView(page: Page, name: "Cards" | "List" | "Table") {
  await projects(page).getByRole("radiogroup", { name: "Projects view" }).getByRole("radio", { name }).click();
}

test("a running service whose build waits keeps a green dot; a first deploy that waits has the pending dot", async ({ page }) => {
  await installDemo(page, { overrides: waitingBuilds() });
  mkdirSync(shots, { recursive: true });
  await page.goto("/");

  // The sidebar: the dot, and the busy badge that says what the deploy does.
  const web = sidebarRow(page, ids.web);
  const worker = sidebarRow(page, ids.worker);
  await expect(web.getByText("waiting", { exact: true })).toBeVisible();
  await expect(dotOf(web)).toHaveAttribute("data-dot", "ok");
  await expect(worker.getByText("waiting", { exact: true })).toBeVisible();
  await expect(dotOf(worker)).toHaveAttribute("data-dot", "pending");
  // A service without a deploy going on: its own dot.
  await expect(dotOf(sidebarRow(page, ids.db))).toHaveAttribute("data-dot", "ok");
  await page.locator('nav[aria-label="Main"]').screenshot({ path: `${shots}/sidebar.png` });

  // The dashboard, in each view: the chip says waiting, its dot what runs.
  const rows = {
    Cards: (id: string) => projects(page).locator(`[data-slot="service-card"]${toService(id).slice(1)}`),
    List: (id: string) => projects(page).locator(toService(id)),
    Table: (id: string) => projects(page).locator("tbody tr").filter({ has: page.locator(toService(id)) }),
  };
  for (const view of ["Cards", "List", "Table"] as const) {
    await pickView(page, view);
    const webRow = rows[view](ids.web);
    const workerRow = rows[view](ids.worker);
    await expect(webRow.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
    await expect(dotOf(webRow)).toHaveAttribute("data-dot", "ok");
    await expect(workerRow.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
    await expect(dotOf(workerRow)).toHaveAttribute("data-dot", "pending");
    await projects(page).screenshot({ path: `${shots}/dashboard-${view.toLowerCase()}.png` });
  }
  await pickView(page, "Cards");

  // The command palette.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog");
  await palette.getByPlaceholder("Type a command or search").fill("acme-shop");
  await expect(dotOf(palette.getByRole("option").filter({ hasText: /^web/ }))).toHaveAttribute("data-dot", "ok");
  await expect(dotOf(palette.getByRole("option").filter({ hasText: /^worker/ }))).toHaveAttribute("data-dot", "pending");
  await page.keyboard.press("Escape");

  // The project page's cards.
  await page.goto(`/p/${ids.acme}`);
  const card = (id: string) => page.locator(`main [data-slot="service-card"]${toService(id).slice(1)}`);
  await expect(card(ids.web).getByText("Waiting for a build slot", { exact: true })).toBeVisible();
  await expect(dotOf(card(ids.web))).toHaveAttribute("data-dot", "ok");
  await expect(dotOf(card(ids.worker))).toHaveAttribute("data-dot", "pending");

  // The service header's chip.
  for (const [id, dot] of [
    [ids.web, "ok"],
    [ids.worker, "pending"],
  ] as const) {
    await page.goto(`/p/${ids.acme}/s/${id}`);
    const chip = page.locator("main header").first().locator('[data-slot="chip"]', { hasText: "Waiting for a build slot" });
    await expect(chip).toBeVisible();
    await expect(dotOf(chip)).toHaveAttribute("data-dot", dot);
    await page
      .locator("main header")
      .first()
      .screenshot({ path: `${shots}/header-${id === ids.web ? "web" : "worker"}.png` });
  }
});

test("an answer without runtimeStatus (a panel before 0.2.17) keeps the gray dot for a build that waits", async ({ page }) => {
  await installDemo(page, { overrides: waitingBuilds(false) });
  await page.goto("/");
  for (const id of [ids.web, ids.worker]) {
    const row = sidebarRow(page, id);
    await expect(row.getByText("waiting", { exact: true })).toBeVisible();
    await expect(dotOf(row)).toHaveAttribute("data-dot", "off");
  }
});
