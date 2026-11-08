// Motion in the web app: the selected item's background in the sidebar is
// one element that slides to the item you click, selecting an item never
// changes its font weight, and people who ask for reduced motion get the
// same result without the slide. Runs on the demo data, motion on unless
// a test says otherwise.

import { expect, type Locator, type Page, test } from "@playwright/test";
import { ids, projects, systemInfo } from "./demo/fixtures";
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

  test("a project's page gets the same sliding background, and project rows fade on hover", async ({ page }) => {
    await installDemo(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    const project = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^acme-shop/ });
    // The whole row (chevron and link), what the background covers.
    const row = project.locator("xpath=..");
    const from = await top(indicator(page));
    const tops = await clickAndTrack(page, project);
    await expect(project).toHaveAttribute("data-status", "active");
    // Before: the pill left Dashboard and no item had one; only the name turned blue.
    await expect(indicator(page)).toHaveCount(1);
    await expect(row.locator('[data-slot="active-indicator"]')).toHaveCount(1);
    const to = await top(row);
    expect(Math.abs((await top(indicator(page))) - to)).toBeLessThan(1);
    const between = tops.filter((y) => y > Math.min(from, to) + 1 && y < Math.max(from, to) - 1);
    expect(between.length, `frames between ${from} and ${to}: ${tops.join(", ")}`).toBeGreaterThan(0);

    // Hovering a row fades its background in 200ms, like every other sidebar item.
    const fade = await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      const props = cs.transitionProperty.split(",").map((p) => p.trim());
      const durations = cs.transitionDuration.split(",").map((d) => d.trim());
      const i = props.findIndex((p) => p === "background-color" || p === "all");
      return i < 0 ? "none" : durations[i % durations.length];
    });
    expect(fade).toBe("0.2s");
  });

  test("a selection pill stays on its item while the page reflows above it", async ({ page }) => {
    // One open project, so "Expand all" is the selected half of its track. When system.info comes
    // in (late), the dashboard re-renders the track while the nodes card above it changes height
    // (no nodes: its placeholders give way to the empty state), in one commit.
    await installDemo(page, {
      delay: (opId) => (opId === "system.info" ? 1000 : opId === "metrics.nodes" ? 5000 : 0),
      overrides: {
        "projects.list": () => ({ projects: [{ ...projects[0], collapsed: false }] }),
        "metrics.nodes": () => ({ nodes: [] }),
        "system.info": () => ({ ...systemInfo, nodes: { total: 0, online: 0 } }),
      },
    });
    await page.goto("/");
    const expand = page.getByRole("button", { name: "Expand all" });
    await expect(expand.locator('[data-slot="active-indicator"]')).toHaveCount(1);
    const samples = await page.evaluate(
      () =>
        new Promise<{ button: number; offset: number }[]>((resolve) => {
          const out: { button: number; offset: number }[] = [];
          const start = performance.now();
          const sample = () => {
            const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Expand all");
            const pill = button?.querySelector('[data-slot="active-indicator"]');
            if (button && pill) {
              const b = button.getBoundingClientRect().top;
              out.push({ button: b, offset: pill.getBoundingClientRect().top - b });
            }
            if (performance.now() - start < 2500) requestAnimationFrame(sample);
            else resolve(out);
          };
          requestAnimationFrame(sample);
        }),
    );
    const buttonTops = samples.map((s) => s.button);
    // The reflow happened while sampling...
    expect(Math.max(...buttonTops) - Math.min(...buttonTops), JSON.stringify(buttonTops)).toBeGreaterThan(5);
    // ...and the pill never left its button (before: 19.5px off, sliding after it).
    const worst = Math.max(...samples.map((s) => Math.abs(s.offset)));
    expect(worst, JSON.stringify(samples.map((s) => s.offset))).toBeLessThan(1);
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
