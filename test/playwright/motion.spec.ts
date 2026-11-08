// Motion in the web app: the selected item's background in the sidebar is
// one element that slides to the item you click, selecting an item never
// changes its font weight, and people who ask for reduced motion get the
// same result without the slide. Runs on the demo data, motion on unless
// a test says otherwise.

import { expect, type Locator, type Page, test } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { stateFile } from "./helpers";

test.use({ storageState: stateFile, reducedMotion: "no-preference" });

const indicator = (page: Page) => page.getByRole("navigation", { name: "Main" }).locator('[data-slot="active-indicator"]');
const navLink = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name });

async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no bounding box");
  return box.y;
}

/** Clicks `link` and records the indicator's top edge on every animation frame for 500ms. */
async function clickAndTrack(page: Page, link: Locator): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __tops: number[] };
    w.__tops = [];
    const start = performance.now();
    const sample = () => {
      const el = document.querySelector('nav[aria-label="Main"] [data-slot="active-indicator"]');
      if (el) w.__tops.push(el.getBoundingClientRect().top);
      if (performance.now() - start < 500) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await link.click();
  await page.waitForTimeout(650);
  return page.evaluate(() => (window as unknown as { __tops: number[] }).__tops);
}

test.describe("motion", () => {
  test("the sidebar's selected background slides to each clicked item", async ({ page }) => {
    await installDemo(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const dashboard = navLink(page, /^Dashboard$/);
    const nodes = navLink(page, /^Nodes \d+$/);
    const templates = navLink(page, /^Templates$/);

    // One indicator, inside the current item.
    await expect(indicator(page)).toHaveCount(1);
    expect(Math.abs((await top(indicator(page))) - (await top(dashboard)))).toBeLessThan(1);

    for (const target of [nodes, templates]) {
      const from = await top(indicator(page));
      const tops = await clickAndTrack(page, target);
      await expect(target).toHaveAttribute("data-status", "active");
      await expect(indicator(page)).toHaveCount(1);
      const to = await top(target);
      // It ends on the clicked item...
      expect(Math.abs((await top(indicator(page))) - to)).toBeLessThan(1);
      // ...and got there through the space in between: one element moving, not two swapping.
      const between = tops.filter((y) => y > Math.min(from, to) + 1 && y < Math.max(from, to) - 1);
      expect(between.length, `frames between ${from} and ${to}: ${tops.join(", ")}`).toBeGreaterThan(0);
    }
  });

  test("selected items keep their font weight", async ({ page }) => {
    await installDemo(page);
    const weights = (selector: string) =>
      page.evaluate(
        (sel) =>
          [...document.querySelectorAll(sel)].map((el) => ({
            active: el.getAttribute("data-status") === "active" || el.getAttribute("aria-current") === "page",
            weight: getComputedStyle(el).fontWeight,
            text: (el.textContent ?? "").trim(),
          })),
        selector,
      );
    const expectSameWeight = async (selector: string) => {
      const items = await weights(selector);
      expect(items.some((item) => item.active), `${selector} has a selected item`).toBe(true);
      const active = items.filter((item) => item.active).map((item) => item.weight);
      const rest = new Set(items.filter((item) => !item.active).map((item) => item.weight));
      for (const weight of active) expect(rest.has(weight), `${selector}: ${JSON.stringify(items)}`).toBe(true);
    };

    // Main navigation.
    await page.goto("/nodes");
    await expect(navLink(page, /^Nodes \d+$/)).toHaveAttribute("data-status", "active");
    await expectSameWeight('nav[aria-label="Main"] > #sidebar-menu > div > a');

    // Settings sections.
    await page.goto("/settings/people");
    await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "People" })).toHaveAttribute(
      "data-status",
      "active",
    );
    await expectSameWeight('nav[aria-label="Settings"] > a');

    // Service tabs, before and after switching.
    await page.goto(`/p/${ids.acme}/s/${svc.api}`);
    const tabs = page.getByRole("navigation", { name: "Service sections" });
    await expect(tabs.getByRole("link", { name: "Overview" })).toHaveAttribute("data-status", "active");
    await expectSameWeight('nav[aria-label="Service sections"] > a');
    await tabs.getByRole("link", { name: "Logs" }).click();
    await expect(tabs.getByRole("link", { name: "Logs" })).toHaveAttribute("data-status", "active");
    await expectSameWeight('nav[aria-label="Service sections"] > a');
  });

  test("the catalog, node sheet and git provider switches slide one pill and keep the font weight", async ({ page }) => {
    await installDemo(page, { overrides: { "gitProviders.list": () => ({ items: [] }) } });
    /** Clicks `name` in the segmented `group` and records its pill's left edge on every frame for 500ms. */
    const slide = async (group: Locator, name: string) => {
      const pill = group.locator('[data-slot="active-indicator"]');
      await expect(pill).toHaveCount(1);
      // A sheet that is still sliding in moves the whole track: start once the pill stands still.
      await expect
        .poll(async () => {
          const a = (await pill.boundingBox())?.x;
          await page.waitForTimeout(100);
          return a !== undefined && a === (await pill.boundingBox())?.x;
        })
        .toBe(true);
      const from = (await pill.boundingBox())?.x ?? Number.NaN;
      await group.evaluate((el) => {
        const w = window as unknown as { __xs: number[] };
        w.__xs = [];
        const start = performance.now();
        const sample = () => {
          const found = el.querySelector('[data-slot="active-indicator"]');
          if (found) w.__xs.push(found.getBoundingClientRect().left);
          if (performance.now() - start < 500) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const item = group.getByRole("radio", { name });
      await item.click();
      await page.waitForTimeout(650);
      await expect(item).toHaveAttribute("data-state", "on");
      await expect(pill).toHaveCount(1);
      const to = (await item.boundingBox())?.x ?? Number.NaN;
      expect(Math.abs(((await pill.boundingBox())?.x ?? Number.NaN) - to)).toBeLessThan(1);
      const xs = await page.evaluate(() => (window as unknown as { __xs: number[] }).__xs);
      const between = xs.filter((x) => x > Math.min(from, to) + 1 && x < Math.max(from, to) - 1);
      expect(between.length, `frames between ${from} and ${to}: ${xs.join(", ")}`).toBeGreaterThan(0);
      const weights = await group
        .getByRole("radio")
        .evaluateAll((els) => els.map((el) => `${el.getAttribute("data-state")}:${getComputedStyle(el).fontWeight}`));
      expect(new Set(weights.map((w) => w.split(":")[1])).size, weights.join(", ")).toBe(1);
    };

    await page.goto("/templates");
    await slide(page.getByRole("radiogroup", { name: "Catalog" }), "Docker Hub");

    await page.goto(`/nodes?node=${ids.de}&view=overview`);
    const views = page.getByRole("radiogroup", { name: "Node views" });
    await slide(views, "Cleanup");
    await slide(views, "Shell");

    await page.goto("/settings/git-providers");
    await slide(page.getByRole("radiogroup", { name: "Provider" }), "Bitbucket");
  });

  test("the Console | Shell switch slides one background and keeps the font weight", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/p/${ids.acme}/s/${svc.api}/console`);
    const group = page.getByRole("navigation", { name: "Console or shell" });
    const pill = group.locator('[data-slot="active-indicator"]');
    const consoleLink = group.getByRole("link", { name: "Console" });
    await expect(consoleLink).toHaveAttribute("aria-current", "page");
    // One indicator, inside the current item (before: a background painted on the link itself).
    await expect(pill).toHaveCount(1);
    await expect.poll(async () => Math.abs(((await pill.boundingBox())?.x ?? 0) - ((await consoleLink.boundingBox())?.x ?? 0))).toBeLessThan(1);
    const from = (await pill.boundingBox())?.x ?? Number.NaN;
    // The whole terminal is a new screen after the click, so look the indicator up again on every frame.
    await page.evaluate(() => {
      const w = window as unknown as { __xs: number[] };
      w.__xs = [];
      const start = performance.now();
      const sample = () => {
        const el = document.querySelector('nav[aria-label="Console or shell"] [data-slot="active-indicator"]');
        if (el) w.__xs.push(el.getBoundingClientRect().left);
        if (performance.now() - start < 500) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const shellLink = group.getByRole("link", { name: "Shell" });
    await shellLink.click();
    await page.waitForTimeout(650);
    await expect(shellLink).toHaveAttribute("aria-current", "page");
    await expect(pill).toHaveCount(1);
    const to = (await shellLink.boundingBox())?.x ?? Number.NaN;
    expect(Math.abs(((await pill.boundingBox())?.x ?? Number.NaN) - to)).toBeLessThan(1);
    const xs = await page.evaluate(() => (window as unknown as { __xs: number[] }).__xs);
    const between = xs.filter((x) => x > Math.min(from, to) + 1 && x < Math.max(from, to) - 1);
    expect(between.length, `frames between ${from} and ${to}: ${xs.join(", ")}`).toBeGreaterThan(0);
    const weights = await group.getByRole("link").evaluateAll((els) => els.map((el) => getComputedStyle(el).fontWeight));
    expect(new Set(weights).size, weights.join(", ")).toBe(1);
  });

  test("node sheet views and setup steps fade in when they change", async ({ page }) => {
    /** After `act`, the lowest opacity (with its ancestors') the first element `selector` finds had on any frame for 400ms. */
    const lowestOpacity = async (selector: string, act: () => Promise<void>) => {
      await page.evaluate((sel) => {
        const w = window as unknown as { __ops: number[] };
        w.__ops = [];
        const start = performance.now();
        const sample = () => {
          let opacity = 1;
          for (let el = document.querySelector(sel); el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
          w.__ops.push(opacity);
          if (performance.now() - start < 400) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, selector);
      await act();
      await page.waitForTimeout(500);
      return Math.min(...(await page.evaluate(() => (window as unknown as { __ops: number[] }).__ops)));
    };

    await installDemo(page);
    await page.goto(`/nodes?node=${ids.de}&view=overview`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: "Agent logs" })).toBeVisible();
    // The sheet itself slides in first: start once it stands still.
    await expect
      .poll(async () => {
        const a = (await sheet.boundingBox())?.x;
        await page.waitForTimeout(100);
        return a !== undefined && a === (await sheet.boundingBox())?.x;
      })
      .toBe(true);
    // The first element in the sheet's scrolling body: the view (before), or the wrapper that fades it in.
    const view = '[role="dialog"] .overflow-y-auto > *';
    const health = await lowestOpacity(view, () => sheet.getByRole("radio", { name: "Health" }).click());
    await expect(sheet.getByRole("radio", { name: "Health" })).toHaveAttribute("data-state", "on");
    expect(health, "node sheet Health view").toBeLessThan(0.9);

    // Setup: signed in, the owner exists, so the wizard opens on the panel domain step.
    await installDemo(page, {
      overrides: {
        "setup.status": () => ({
          ownerExists: true,
          completed: false,
          link: null,
          githubAvailable: false,
          steps: ["owner", "panelDomain", "wildcardDomain", "firstProject"],
        }),
      },
    });
    await page.goto("/setup");
    await expect(page.getByRole("heading", { level: 1, name: "Name and domain" })).toBeVisible();
    await page.waitForTimeout(400);
    // The element after the step list: the step's panel (before), or the wrapper that fades it in.
    const step = await lowestOpacity("main > ol + *", () => page.getByRole("button", { name: "Skip for now" }).click());
    await expect(page.getByRole("heading", { level: 1, name: "Automatic domains" })).toBeVisible();
    expect(step, "setup step").toBeLessThan(0.9);
  });

  test("with reduced motion the background moves at once", async ({ browser }) => {
    const context = await browser.newContext({ storageState: stateFile, reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await installDemo(page);
    await page.goto("/");
    await expect(indicator(page)).toHaveCount(1);
    const from = await top(indicator(page));
    const target = navLink(page, /^Activity$/);
    const tops = await clickAndTrack(page, target);
    const to = await top(target);
    expect(Math.abs((await top(indicator(page))) - to)).toBeLessThan(1);
    expect(tops.filter((y) => y > Math.min(from, to) + 1 && y < Math.max(from, to) - 1)).toEqual([]);
    await context.close();
  });
});
