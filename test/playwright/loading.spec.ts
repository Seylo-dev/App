// Loading placeholders take the room of what they stand for: with the demo
// API held back, the parts of a screen that are already drawn keep their
// place and size when the data arrives. Also: a checkbox that is already
// checked when a screen opens does not animate.

import { expect, type Locator, type Page, test } from "@playwright/test";
import { hostShellStatus, ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { stateFile } from "./helpers";

test.use({ storageState: stateFile, reducedMotion: "no-preference" });

/** Holds every answer back except the two the app needs before it draws anything. */
async function slowDemo(page: Page, delay = 1200, only?: (opId: string) => boolean): Promise<void> {
  const boot = new Set(["auth.whoami", "settings.boot"]);
  await installDemo(page, { delay: (opId) => (boot.has(opId) || (only && !only(opId)) ? 0 : delay) });
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no bounding box");
  return found;
}

async function boxes(locator: Locator): Promise<Box[]> {
  return locator.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
}

const loaded = (page: Page) => expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0, { timeout: 15_000 });

function expectClose(actual: number, expected: number, what: string, tolerance = 1): void {
  expect(Math.abs(actual - expected), `${what}: ${expected} -> ${actual}`).toBeLessThanOrEqual(tolerance);
}

test.describe("loading placeholders", () => {
  test("nodes: the update strip keeps its height and the node table stays put", async ({ page }) => {
    await slowDemo(page);
    await page.goto("/nodes");
    const strip = page.getByRole("region", { name: "Updates" });
    const table = page.getByRole("region", { name: "Node list" });
    await expect(strip.getByRole("status")).toBeVisible();
    const before = { strip: await box(strip), header: await box(table.locator("th").first()) };

    await loaded(page);
    await expect(strip.getByRole("status")).toHaveCount(0);
    expectClose((await box(strip)).height, before.strip.height, "update strip height");
    expectClose((await box(table.locator("th").first())).y, before.header.y, "node table header y");
  });

  test("tables: the header cells keep their places when the rows arrive", async ({ page }) => {
    await slowDemo(page);
    for (const [path, name] of [
      ["/activity", "Activity"],
      ["/settings/people", "People"],
      ["/settings/api-keys", "API keys"],
    ] as const) {
      await page.goto(path);
      const table = page.getByRole("table", { name });
      await expect(table.locator('[data-slot="skeleton"]').first()).toBeVisible();
      const before = await boxes(table.locator("th"));
      await expect(table.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 15_000 });
      const after = await boxes(table.locator("th"));
      expect(after.length).toBe(before.length);
      after.forEach((cell, i) => {
        // The widths are what typical rows give, so a few pixels either way.
        expectClose(cell.x, before[i]?.x ?? Number.NaN, `${path} th ${i} x`, 5);
        expectClose(cell.width, before[i]?.width ?? Number.NaN, `${path} th ${i} width`, 5);
      });
    }
  });

  test("approvals: a placeholder card is as tall as a pending approval", async ({ page }) => {
    await slowDemo(page);
    await page.goto("/approvals");
    const cards = page.locator('main [data-slot="card"]');
    await expect(page.locator("main").getByRole("status")).toBeVisible();
    const before = await boxes(cards);
    await loaded(page);
    await expect(cards.first()).toHaveAccessibleName("Delete a project");
    const after = await boxes(cards);
    expectClose(after[0]?.height ?? 0, before[0]?.height ?? 0, "first card height");
    expectClose(after[1]?.y ?? 0, before[1]?.y ?? 0, "second card y");
  });

  test("dashboard: placeholder service rows are as tall as running services", async ({ page }) => {
    // Projects come in first, their services later: the second project (two running services) keeps its height.
    await slowDemo(page, 2000, (opId) => opId === "services.list");
    await page.goto("/");
    const projects = page.getByRole("region", { name: "Projects" });
    const card = projects.locator("article").nth(1);
    await expect(card.getByRole("status")).toBeVisible();
    const before = await box(card);
    await loaded(page);
    // Layout is exact here: the old rows were a quarter pixel short each.
    expectClose((await box(card)).height, before.height, "project card height", 0.2);
  });

  test("node sheet: the cleanup form and the host shell take their placeholders' room", async ({ page }) => {
    // Only the view's own answers wait; the node and its runs are there.
    await installDemo(page, {
      delay: (opId) => (opId === "cleanup.getSchedule" || opId === "hostShell.status" ? 1500 : 0),
      overrides: { "hostShell.status": (input) => ({ ...hostShellStatus(String(input.nodeId)), enabled: false, sessions: [] }) },
    });
    await page.goto(`/nodes?node=${ids.de}&view=cleanup`);
    const sheet = page.getByRole("dialog");
    const runs = sheet.getByRole("heading", { name: "Recent cleanups" });
    await expect(sheet.getByRole("status", { name: "Loading the cleanup schedule" })).toHaveAttribute("aria-busy", "true");
    await expect(runs).toBeVisible();
    const before = await box(runs);
    await expect(sheet.getByRole("button", { name: "Save schedule" })).toBeVisible({ timeout: 15_000 });
    expectClose((await box(runs)).y, before.y, "Recent cleanups heading y", 2);

    await sheet.getByRole("radio", { name: "Shell" }).click();
    const loading = sheet.getByRole("status", { name: "Loading the host shell state" });
    await expect(loading).toHaveAttribute("aria-busy", "true");
    const placeholder = await box(loading);
    const off = sheet.getByRole("region", { name: "Host shells are off for this node" });
    await expect(off).toBeVisible({ timeout: 15_000 });
    expectClose((await box(off)).height, placeholder.height, "host shell panel height", 2);
  });

  test("Docker Hub: a placeholder result is as tall as a result", async ({ page }) => {
    await slowDemo(page, 1500, (opId) => opId === "dockerHub.search");
    await page.goto("/templates?tab=docker-hub&q=gitea");
    const results = page.getByRole("region", { name: "Docker Hub images" });
    const placeholder = results.getByRole("status");
    await expect(placeholder).toHaveAttribute("aria-busy", "true");
    const rows = await boxes(placeholder.locator(":scope > div"));
    await expect(results.getByRole("button").first()).toBeVisible({ timeout: 15_000 });
    // Docker Hub descriptions are mostly one line, like the placeholder's.
    const first = await box(results.getByRole("button").first());
    expectClose(first.height, rows[0]?.height ?? 0, "result row height", 2);
  });

  test("git providers: the connection table's header cells keep their places", async ({ page }) => {
    const now = new Date().toISOString();
    await installDemo(page, {
      delay: (opId) => (opId === "gitProviders.list" ? 1500 : 0),
      overrides: {
        "gitProviders.list": () => ({
          items: [
            {
              id: "gp00000000000001",
              kind: "gitlab",
              name: "Company GitLab",
              url: "https://gitlab.com",
              host: "gitlab.com",
              workspace: null,
              authKind: "token",
              account: "deploy-bot",
              username: null,
              statusNotes: true,
              usedBy: 2,
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      },
    });
    await page.goto("/settings/git-providers");
    const table = page.getByRole("table", { name: "Connections" });
    await expect(table.locator('[data-slot="skeleton"]').first()).toBeVisible();
    const before = await boxes(table.locator("th"));
    await expect(table.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 15_000 });
    const after = await boxes(table.locator("th"));
    expect(after.length).toBe(before.length);
    after.forEach((cell, i) => {
      expectClose(cell.x, before[i]?.x ?? Number.NaN, `th ${i} x`, 5);
      expectClose(cell.width, before[i]?.width ?? Number.NaN, `th ${i} width`, 5);
    });
  });

  test("a checkbox that is checked when the screen opens does not animate", async ({ page }) => {
    await installDemo(page);
    await page.goto("/nodes");
    await expect(page.getByRole("checkbox", { name: /Auto-update/ })).toBeChecked();
    const animations = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="checkbox"][data-state="checked"] > span')].map((el) => getComputedStyle(el).animationName),
    );
    expect(animations.length).toBeGreaterThan(0);
    for (const name of animations) expect(name).toBe("none");
  });
});
