// Loading placeholders take the room of what they stand for: with the demo
// API held back, the parts of a screen that are already drawn keep their
// place and size when the data arrives. Also: a checkbox that is already
// checked when a screen opens does not animate.

import type { Locator, Page } from "@playwright/test";
import { hostShellStatus, ids, systemInfo } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { demoNow } from "./demo/settings";
import { dashboardHeading, expect, stateFile, test, withDashboardView } from "./helpers";

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
    // The rows' times are relative ("3 minutes ago") and count from when the demo data was made, which in a
    // full run is many specs before this one. So the page's clock is pinned: at that moment, then 9 and 50
    // minutes on, where a full run gets here ("12 minutes ago", "1 hour ago"). Before (0.2.16) the time
    // columns took their text's width: People's header moved 5.6px at 9 minutes, the API keys' 23px at 50.
    for (const [minutes, signedIn, keyUsed] of [
      [0, "3 minutes ago", "30 minutes ago"],
      [9, "12 minutes ago", "39 minutes ago"],
      [50, "53 minutes ago", "1 hour ago"],
    ] as const) {
      await page.clock.setFixedTime(demoNow + minutes * 60_000);
      for (const [path, name, firstRowReads] of [
        ["/activity", "Activity", null],
        ["/settings/people", "People", signedIn],
        ["/settings/api-keys", "API keys", keyUsed],
        ["/settings/api-keys", "MCP tokens", null],
      ] as const) {
        await page.goto(path);
        const table = page.getByRole("table", { name });
        await expect(table.locator('[data-slot="skeleton"]').first()).toBeVisible();
        const before = await boxes(table.locator("th"));
        await expect(table.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 15_000 });
        if (firstRowReads) await expect(table.locator("tbody tr").first()).toContainText(firstRowReads);
        const after = await boxes(table.locator("th"));
        expect(after.length).toBe(before.length);
        after.forEach((cell, i) => {
          // The widths are what typical rows give, so a few pixels either way.
          expectClose(cell.x, before[i]?.x ?? Number.NaN, `${name} at +${minutes} min th ${i} x`, 5);
          expectClose(cell.width, before[i]?.width ?? Number.NaN, `${name} at +${minutes} min th ${i} width`, 5);
        });
      }
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

  for (const view of ["cards", "list", "table"] as const) {
    test(`dashboard ${view}: placeholder services are as tall as running services`, async ({ page }) => {
      await withDashboardView(page, view);
      // Projects come in first, their services later: the second project (two running services) keeps its
      // height, as cards or as rows; the table keeps its height with a placeholder row per service.
      await slowDemo(page, 2000, (opId) => opId === "services.list");
      await page.goto("/");
      const projects = page.getByRole("region", { name: "Projects" });
      const part = view === "table" ? projects.getByRole("region", { name: "Every service" }) : projects.locator("article").nth(1);
      await expect(part.locator('[data-slot="skeleton"]').first()).toBeVisible();
      const before = await box(part);
      await loaded(page);
      // Layout is exact here: the old rows were a quarter pixel short each.
      expectClose((await box(part)).height, before.height, `${view}: project height`, 0.2);
    });
  }

  test("dashboard without nodes: the nodes card is its empty state from the start, so Projects stays put", async ({ page }) => {
    // A first-run panel: no nodes yet, and the metrics answer comes late.
    await installDemo(page, {
      delay: (opId) => (opId === "metrics.nodes" ? 1500 : 0),
      overrides: {
        "metrics.nodes": () => ({ nodes: [] }),
        "system.info": () => ({ ...systemInfo, nodes: { total: 0, online: 0 } }),
      },
    });
    await page.goto("/");
    const heading = page.getByRole("region", { name: "Projects" }).getByRole("heading", { name: "Projects" });
    const nodesCard = page.getByRole("region", { name: "Node usage" });
    // system.info is in: the panel knows it has no nodes.
    await expect(page.getByText("0 nodes", { exact: false }).first()).toBeVisible();
    await expect(heading).toBeVisible();
    // Before: three chart placeholders until metrics.nodes answered, 59px shorter than the empty state after them.
    await expect(nodesCard.getByText("No nodes yet")).toBeVisible({ timeout: 1000 });
    const before = await box(heading);
    await page.waitForTimeout(1800);
    expectClose((await box(heading)).y, before.y, "Projects heading y");
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

  test("notifications: a placeholder channel card is as tall as a channel card", async ({ page }) => {
    await slowDemo(page, 1500, (opId) => opId === "notifications.channels");
    await page.goto("/settings/notifications");
    const channels = page.getByRole("region", { name: "Channels" });
    const card = channels.locator('[data-slot="card"]').first();
    await expect(card).toBeVisible();
    // Read at once, while the answer is held back. Before: one blank card pulsing on its own (animate-pulse), 8px short of a real one.
    expect(await channels.locator(".animate-pulse").count()).toBe(0);
    await expect(channels.getByRole("status")).toHaveAttribute("aria-busy", "true");
    await expect(card.locator('[data-slot="skeleton"]').first()).toBeVisible();
    const before = await box(card);
    await expect(channels.getByText("Ops Discord")).toBeVisible({ timeout: 15_000 });
    expectClose((await box(card)).height, before.height, "channel card height");
  });

  test("the shell and the dashboard show placeholders, not made-up numbers, until they know", async ({ page }) => {
    await slowDemo(page, 2500);
    await page.goto("/");
    const sidebar = page.getByRole("navigation", { name: "Main" });
    const nodesCard = sidebar.getByRole("link", { name: "Nodes and updates" });
    const header = page.locator('[data-slot="page-header"]');
    await expect(dashboardHeading(page)).toBeVisible();
    // Read at once, while the answers are held back. Before: "0 nodes online", "not available yet" and "0 projects".
    expect(await nodesCard.textContent()).not.toMatch(/0 nodes online|not available yet/);
    expect(await header.textContent()).not.toContain("0 projects");
    await expect(nodesCard).toHaveAttribute("aria-busy", "true");
    await expect(nodesCard.locator('[data-slot="skeleton"]')).toHaveCount(3);
    await expect(header.locator('[data-slot="skeleton"]')).toHaveCount(1);
    // The version chip's place next to the brand is held while system.info loads.
    const brandRow = sidebar.locator("div").first();
    const placeholder = await box(brandRow.locator('[data-slot="skeleton"]'));

    await expect(nodesCard).toContainText("3 nodes online", { timeout: 15_000 });
    await expect(nodesCard).not.toHaveAttribute("aria-busy");
    // The counts are chips under the greeting: 3 nodes, then the services once known.
    const counts = header.getByTestId("dashboard-counts");
    await expect(counts).toContainText("3 nodes", { timeout: 15_000 });
    await expect(counts).toContainText(/\d+ services/);
    const chip = await box(brandRow.locator('[data-slot="chip"]'));
    expectClose(chip.height, placeholder.height, "version chip height");
    expectClose(chip.x + chip.width, placeholder.x + placeholder.width, "version chip right edge");
  });

  test("pickers and the overview's Domains show placeholders, not the word Loading", async ({ page }) => {
    await slowDemo(page, 1500, (opId) => opId === "nodes.list" || opId === "domains.list");
    await page.goto("/settings/cleanup");
    const picker = page.getByRole("combobox", { name: "Node" });
    await expect(picker).toBeVisible();
    // Read at once, while nodes.list is held back.
    expect(await picker.textContent()).not.toContain("Loading");
    await expect(picker).toHaveAttribute("aria-busy", "true");
    await expect(picker.locator('[data-slot="skeleton"]')).toBeVisible();
    await expect(picker).toContainText(/de-fsn-1|Pick a node/, { timeout: 15_000 });
    await expect(picker).not.toHaveAttribute("aria-busy");

    await page.goto(`/p/${ids.acme}/s/${svc.api}`);
    const domainsCard = page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name: "Domains", exact: true }) });
    await expect(domainsCard).toBeVisible();
    expect(await domainsCard.textContent()).not.toContain("Loading");
    await expect(domainsCard.getByRole("status")).toHaveAttribute("aria-busy", "true");
    await expect(domainsCard.locator("li").first()).toBeVisible({ timeout: 15_000 });
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
