// The Templates page's toolbar on the demo data (0.2.18): Catalog source
// and the refresh button on the title row, left of the search, with no
// status line under the title; at phone width the buttons keep their row
// and the search takes the next one. The refresh button spins while the
// panel checks and ends with the same toasts as "Check for new templates"
// did; a problem puts a dot on it whose tooltip says what is wrong and what
// to do, and nothing shows while all is well. The Catalog source dialog
// says what is in use: the source, when it was built, its commit and the
// last check. Opening the page asks for a check once when one is due, and
// the list takes a newer catalog from the live invalidation. The panel's
// own tests (template-catalog.test.ts) cover the checks; screenshots go to
// $SHOTS_DIR/templates-toolbar/.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { catalogStatus, templates as demoTemplates } from "./demo/fixtures";
import { type Handler, installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

type Status = typeof catalogStatus;
const shots = `${process.env.SHOTS_DIR ?? "shots"}/templates-toolbar`;
mkdirSync(shots, { recursive: true });

test.use({ storageState: stateFile });

const toolbar = (page: Page) => page.getByTestId("templates-toolbar");
const sourceButton = (page: Page) => toolbar(page).getByRole("button", { name: "Catalog source" });
const refreshButton = (page: Page) => toolbar(page).getByRole("button", { name: "Check for new templates" });
const search = (page: Page) => page.getByRole("searchbox", { name: "Search templates" });
const notifications = (page: Page) => page.getByRole("region", { name: "Notifications" });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not on screen");
  return { ...b, right: b.x + b.width, bottom: b.y + b.height, middle: b.y + b.height / 2 };
}

/** The demo with the catalog status a test gives (the demo's own otherwise). */
async function demo(page: Page, status: Partial<Status> | (() => Status) = {}, overrides: Record<string, Handler> = {}) {
  await installDemo(page, {
    overrides: { "templates.catalogStatus": typeof status === "function" ? status : () => ({ ...catalogStatus, ...status }), ...overrides },
  });
}

test("Catalog source, the refresh button, then the search, on the title row; no status line under it", async ({ page }) => {
  await demo(page);
  await page.goto("/templates");
  await expect(search(page)).toBeVisible();
  const source = await box(sourceButton(page));
  const refresh = await box(refreshButton(page));
  const input = await box(search(page));
  // In this order, left to right, the refresh button right beside Catalog source (the toolbar's 8px gap).
  expect(refresh.x - source.right).toBeGreaterThanOrEqual(6);
  expect(refresh.x - source.right).toBeLessThanOrEqual(10);
  expect(input.x).toBeGreaterThan(refresh.right);
  // One line: the same height and center.
  for (const b of [source, refresh]) {
    expect(Math.abs(b.middle - input.middle)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.height - input.height)).toBeLessThanOrEqual(1);
  }
  // On the title's row, at its right end.
  const title = await box(page.getByRole("heading", { level: 1, name: "Templates" }));
  expect(source.y).toBeLessThan(title.bottom);
  expect(input.width).toBeGreaterThanOrEqual(299);
  // No line under the title, and nothing that says a problem.
  await expect(page.getByTestId("catalog-status")).toHaveCount(0);
  await expect(page.getByText(/Official catalog, updated/)).toHaveCount(0);
  await expect(page.getByTestId("catalog-notes")).toHaveCount(0);
  await expect(page.getByTestId("catalog-problem")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/desktop.png` });

  // Docker Hub has the same search box, without the catalog's buttons.
  await page.getByRole("radio", { name: "Docker Hub" }).click();
  await expect(page.getByRole("searchbox", { name: "Search Docker Hub" })).toBeVisible();
  await expect(toolbar(page).getByRole("button")).toHaveCount(0);
});

test("at phone width the buttons keep their row and the search spans the next; nothing scrolls sideways", async ({ page }) => {
  await demo(page);
  for (const [width, height] of [
    [390, 844],
    [320, 700],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/templates");
    await expect(search(page)).toBeVisible();
    const source = await box(sourceButton(page));
    const refresh = await box(refreshButton(page));
    const input = await box(search(page));
    const bar = await box(toolbar(page));
    expect(Math.abs(source.middle - refresh.middle)).toBeLessThanOrEqual(1);
    expect(refresh.x).toBeGreaterThan(source.right);
    expect(input.y).toBeGreaterThanOrEqual(refresh.bottom);
    expect(Math.abs(input.x - bar.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(input.right - bar.right)).toBeLessThanOrEqual(1);
    expect(bar.right).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${shots}/phone-${width}.png` });
  }
});

test("the refresh button spins while the panel checks and ends with what it found", async ({ page }) => {
  const answers: Status[] = [
    catalogStatus,
    { ...catalogStatus, newSlugs: ["n8n", "umami"] },
    { ...catalogStatus, official: { ...catalogStatus.official, origin: "bundled", notPublished: true } },
    { ...catalogStatus, official: { ...catalogStatus.official, lastError: "Could not reach github.com.", lastTriedAt: minutesAgo(0) } },
  ];
  const checks: number[] = [];
  await installDemo(page, {
    overrides: {
      "templates.refreshCatalog": () => answers[checks.push(1) - 1] as Status,
    },
    delay: (opId) => (opId === "templates.refreshCatalog" ? 700 : 0),
  });
  await page.goto("/templates");
  const button = refreshButton(page);
  for (const toast of [
    "No new templates.",
    "2 new templates.",
    "The official catalog is not published yet.",
    "The check failed: Could not reach github.com.",
  ]) {
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(button.locator("svg")).toHaveClass(/animate-spin/);
    // A second click while it checks sends nothing.
    await button.click();
    await expect(notifications(page).getByText(toast)).toBeVisible();
    await expect(button).not.toHaveAttribute("aria-busy", "true");
    await expect(button.locator("svg")).not.toHaveClass(/animate-spin/);
  }
  expect(checks).toHaveLength(4);
});

test("a problem is a dot on the refresh button whose tooltip says what is wrong and what to do", async ({ page }) => {
  let status: Status = catalogStatus;
  await demo(page, () => status);
  await page.goto("/templates");
  const button = refreshButton(page);
  await expect(button).toBeVisible();
  await expect(button.getByTestId("catalog-problem")).toHaveCount(0);

  const cases: [string, Status, RegExp][] = [
    [
      "failed",
      { ...catalogStatus, official: { ...catalogStatus.official, lastError: "The catalog is signed with a different key.", lastTriedAt: minutesAgo(5) } },
      /^Checking for new templates failed 5 minutes ago: The catalog is signed with a different key\. .*make sure this panel can reach GitHub\.$/,
    ],
    [
      "private",
      {
        ...catalogStatus,
        extra: {
          ...catalogStatus.official,
          host: "templates.example.com",
          signed: true,
          lastError: "templates.example.com answered 404 for catalog.json.",
          lastTriedAt: minutesAgo(2),
        },
      } as Status,
      /^The private catalog templates\.example\.com failed 2 minutes ago: .*its URL and key in Catalog source\.$/,
    ],
    ["off", { ...catalogStatus, official: { ...catalogStatus.official, origin: "bundled", enabled: false } }, /Turn them on in Catalog source\.$/],
    ["no-key", { ...catalogStatus, official: { ...catalogStatus.official, origin: "bundled", signingKey: false } }, /^This build has no key/],
  ];
  for (const [name, next, text] of cases) {
    status = next;
    await page.reload();
    await expect(button.getByTestId("catalog-problem")).toBeVisible();
    await expect(button).toHaveAccessibleDescription(text);
    await button.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("Check for new templates");
    await expect(tip.getByText(text)).toBeVisible();
    await page.screenshot({ path: `${shots}/problem-${name}.png` });
    await page.mouse.move(0, 0);
  }

  // Downloads off and no private catalog: nothing to check, the button dimmed and a click sends nothing.
  status = { ...catalogStatus, official: { ...catalogStatus.official, origin: "bundled", enabled: false } };
  await page.reload();
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/templates.refreshCatalog")) sent.push(request.url());
  });
  await expect(button).toHaveAttribute("aria-disabled", "true");
  // Playwright waits for an aria-disabled button to be enabled; a person can still click it.
  await button.click({ force: true });
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);

  // All well again: no dot.
  status = catalogStatus;
  await page.reload();
  await expect(button).toBeVisible();
  await expect(button.getByTestId("catalog-problem")).toHaveCount(0);
});

test("the Catalog source dialog says what is in use: the source, when it was built, its commit, the last check and any problem", async ({
  page,
}) => {
  let status: Status = { ...catalogStatus, official: { ...catalogStatus.official, lastTriedAt: minutesAgo(3) } };
  await demo(page, () => status);
  await page.goto("/templates");
  await sourceButton(page).click();
  const dialog = page.getByRole("dialog");
  const inUse = dialog.getByTestId("catalog-in-use");
  await expect(inUse.getByText("In use")).toBeVisible();
  await expect(inUse.getByText("Downloaded from Seylo-dev/Templates")).toBeVisible();
  await expect(inUse.getByText("Nov 14, 2026")).toBeVisible();
  await expect(inUse.getByRole("link", { name: "a1b2c3d" })).toHaveAttribute(
    "href",
    "https://github.com/Seylo-dev/Templates/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  );
  await expect(inUse.getByText("3 minutes ago")).toBeVisible();
  await expect(dialog.getByTestId("catalog-problems")).toHaveCount(0);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: `${shots}/dialog.png` });
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // A failed check and a private catalog: both in the dialog, the problem as a warning.
  status = {
    ...catalogStatus,
    official: { ...catalogStatus.official, lastError: "Could not reach github.com.", lastTriedAt: minutesAgo(5) },
    extra: { ...catalogStatus.official, host: "templates.example.com", signed: false, commit: "0123456789abcdef0123456789abcdef01234567" },
  } as Status;
  await page.reload();
  await sourceButton(page).click();
  await expect(dialog.getByTestId("catalog-in-use-private")).toContainText("templates.example.com, unsigned");
  await expect(dialog.getByTestId("catalog-in-use-private")).toContainText("0123456");
  await expect(dialog.getByTestId("catalog-problems")).toContainText("Checking for new templates failed 5 minutes ago: Could not reach github.com.");
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: `${shots}/dialog-problem.png` });
});

test("opening the page asks for a check once when one is due, and a newer catalog reaches the list by itself", async ({ page }) => {
  let due = true;
  let arrived = false;
  const asked: number[] = [];
  const panelTopic: ((event: object) => void)[] = [];
  const notes = { ...demoTemplates.templates[0], slug: "notes", name: "Notes", category: "Developer tools", description: "Shared notes." };
  await installDemo(page, {
    overrides: {
      "templates.catalogStatus": () => ({ ...catalogStatus, checkDue: due, newSlugs: arrived ? ["notes"] : [] }),
      "templates.checkCatalogIfDue": () => {
        asked.push(Date.now());
        // The panel runs it now: no longer due.
        due = false;
        return { started: true };
      },
      "templates.list": (input) => {
        const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
        const all = [...demoTemplates.templates, ...(arrived ? [notes] : [])];
        return { templates: all.filter((t) => t.name.toLowerCase().includes(query)), categories: demoTemplates.categories };
      },
    },
    onLiveSubscribe: (topic, send) => {
      if (topic === "panel") panelTopic.push(send);
    },
  });
  // A query (the check is the panel's own, so it is not audited): a GET, not a POST.
  const methods: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/templates.checkCatalogIfDue")) methods.push(request.method());
  });
  await page.goto("/templates");
  await expect.poll(() => asked.length).toBe(1);
  expect(methods).toEqual(["GET"]);
  // Typing, filtering and the refetches after it ask nothing more.
  await search(page).pressSequentially("gh");
  await search(page).fill("");
  await page.getByRole("button", { name: "Analytics", exact: true }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.waitForTimeout(500);
  expect(asked).toHaveLength(1);

  // The check brought a newer catalog: the panel invalidates the list, and the card shows without a reload.
  await expect(page.getByRole("button", { name: /^Notes Developer tools / })).toHaveCount(0);
  arrived = true;
  await expect.poll(() => panelTopic.length).toBeGreaterThan(0);
  for (const send of panelTopic)
    send({ type: "invalidate", ops: ["templates.list", "templates.get", "templates.source", "templates.catalogStatus"] });
  const card = page.getByRole("button", { name: /^Notes Developer tools / });
  await expect(card).toBeVisible();
  await expect(card.getByText("New", { exact: true })).toBeVisible();

  // Not due: opening the page again asks nothing.
  await page.reload();
  await expect(card).toBeVisible();
  await page.waitForTimeout(500);
  expect(asked).toHaveLength(1);
});
