// The References panel on the demo data: worker runs on us-ash-1, db
// (exposed) and redis (not exposed) on de-fsn-1. worker itself comes first
// with its own built-ins that have a value (no domain and no port yet, so
// only INTERNAL_HOST), never its own variables. An internal variable of a
// service on another node is still listed, struck through, so it does not
// look missing; for an exposed one its tip names the exposed variable to
// use instead. The groups scroll inside the panel, which is no taller than
// the editor and shows no scrollbar; each group collapses on its header
// (a long one starts collapsed), remembered across a reload; the panel is
// up to 440px wide and wraps under the editor on a phone. Screenshots go to
// $SHOTS_DIR/env-references.

import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { envReferences, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/env-references`;

/** `count` variables of a service's own .env, as env.references lists them for another service. */
const ownVariables = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    name: `${prefix}_VAR_${i + 1}`,
    value: `value-${i + 1}`,
    scope: "plain",
    sensitive: true,
    secret: false,
    description: "variable of the service",
  }));

/** A billing service next to worker on us-ash-1 with 24 chips: its host name and its own 23 variables. */
const billing = {
  name: "billing",
  kind: "service",
  serviceId: "svcbilling00000a",
  serviceKind: "app",
  nodes: [{ id: ids.us, name: "us-ash-1" }],
  internalHost: "billing",
  exposed: false,
  variables: [
    { name: "INTERNAL_HOST", value: "billing", scope: "internal", sensitive: false, description: "host name on the project network" },
    ...ownVariables("BILLING", 23),
  ],
};

/** The demo references with api's own variables (35 chips with its 4 built-ins) and billing, before the shared variables. */
const manyReferences = {
  ...envReferences,
  targets: envReferences.targets.flatMap((target) => {
    if (target.name === "api") return [{ ...target, variables: [...target.variables, ...ownVariables("API", 31)] }, billing];
    return [target];
  }),
};

const environmentUrl = `/p/${ids.acme}/s/${svc.worker}/environment`;

/** worker's Environment tab once the References panel and the editor card next to it have loaded. */
async function environment(page: Page) {
  const panel = page.getByRole("complementary", { name: "References" });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const editor = page.getByRole("region", { name: "Environment", exact: true });
  await expect(editor.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
  // A group's header row: the button around its bold name.
  const header = (name: string) => panel.locator("button[aria-expanded]").filter({ has: page.locator("b", { hasText: new RegExp(`^${name}$`) }) });
  return { panel, editor, header, list: panel.locator('[data-slot="references-list"]') };
}

test.describe("environment references", () => {
  test.use({ storageState: stateFile });

  test("an exposed database on another node keeps its internal variables, struck through", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
    const panel = page.getByRole("complementary", { name: "References" });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
    const editorText = async () => (await page.locator(".monaco-editor .view-lines").first().innerText()).replace(/ /g, " ");
    const before = await editorText();

    // A group is the innermost div with both its header text and its buttons.
    const db = panel
      .locator("div")
      .filter({ has: page.getByText("exposed with SSL") })
      .filter({ has: page.getByRole("button", { name: "EXPOSED_URL", exact: true }) })
      .last();
    for (const name of ["EXPOSED_URL", "EXPOSED_HOST", "EXPOSED_PORT"]) {
      await expect(db.getByRole("button", { name, exact: true })).not.toHaveAttribute("aria-disabled", "true");
    }
    const internal = db.getByRole("button", { name: "INTERNAL_URL", exact: true });
    await expect(internal).toBeVisible();
    await expect(internal).toHaveAttribute("aria-disabled", "true");
    await expect(internal).toHaveCSS("text-decoration-line", "line-through");

    await internal.hover();
    await expect(page.getByText("Only for services on de-fsn-1. worker runs on us-ash-1, so use EXPOSED_URL.")).toBeVisible();

    // A struck-through variable inserts nothing (force: the open tip covers the button).
    await internal.click({ force: true });
    expect(await editorText()).toBe(before);

    // A service with no way in keeps the Expose link.
    await expect(panel.getByRole("link", { name: "Expose redis" })).toBeVisible();
  });

  test("the service itself comes first with its own built-ins that have a value, never its own variables", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
    const panel = page.getByRole("complementary", { name: "References" });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toBeVisible({ timeout: 15_000 });
    const line = (text: string) => editor.locator(".view-line", { hasText: text });
    await expect(line("SMTP_HOST")).toBeVisible();

    // First group: worker, its APP badge and "this service".
    await expect(panel.locator("b").first()).toHaveText("worker");
    const self = panel
      .locator("div")
      .filter({ has: page.getByText("this service", { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "INTERNAL_HOST", exact: true }) })
      .last();
    await expect(self.getByText("APP", { exact: true })).toBeVisible();
    // No domain and no port yet: URL, DOMAIN, DOMAINS, INTERNAL_URL and INTERNAL_PORT are empty and get no chip.
    // (The other button is the group's header row.)
    const chips = self.locator("button:not([aria-expanded])");
    await expect(chips).toHaveText(["INTERNAL_HOST"]);
    // Its internal address works from where it runs: nothing is struck through.
    for (const chip of await chips.all()) await expect(chip).not.toHaveAttribute("aria-disabled", "true");
    // Its own .env variables are the lines of the file, not references.
    for (const name of ["NODE_ENV", "QUEUE_CONCURRENCY", "LOG_LEVEL"]) {
      await expect(panel.getByRole("button", { name, exact: true })).toHaveCount(0);
    }

    // The same tips as the other groups: the value as is.
    const tip = (description: string) => page.getByRole("tooltip").filter({ hasText: description });
    await self.getByRole("button", { name: "INTERNAL_HOST", exact: true }).hover();
    await expect(tip("host name on the project network")).toContainText("worker");
    // Away first, in steps: Radix closes a tip on a pointer move outside it.
    await page.mouse.move(0, 0, { steps: 5 });
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    // A click inserts ${{worker.INTERNAL_HOST}} at the cursor, and the analyzer takes it.
    await line("SMTP_HOST").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("HOST=");
    await self.getByRole("button", { name: "INTERNAL_HOST", exact: true }).click();
    await expect(line("worker.INTERNAL_HOST")).toHaveText("HOST=${{worker.INTERNAL_HOST}}");
    await expect(page.getByText(/^Line 11:/)).toHaveCount(0);
  });

  test("many variables scroll inside the panel, no taller than the editor, with no scrollbar", async ({ page }) => {
    await installDemo(page, { overrides: { "env.references": () => manyReferences } });
    await page.goto(environmentUrl);
    const { panel, editor, header, list } = await environment(page);
    const chip = (name: string) => panel.getByRole("button", { name, exact: true });

    // api (35 chips) and billing (24) start collapsed with their counts, the short groups expanded.
    await expect(header("api")).toHaveAttribute("aria-expanded", "false");
    await expect(header("api")).toContainText("35 variables");
    await expect(header("billing")).toHaveAttribute("aria-expanded", "false");
    await expect(header("billing")).toContainText("24 variables");
    for (const name of ["worker", "db", "redis", "Project"]) await expect(header(name)).toHaveAttribute("aria-expanded", "true");
    await expect(chip("API_VAR_1")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/long-groups-collapsed.png`, animations: "disabled" });

    const pageHeight = () => page.evaluate(() => document.documentElement.scrollHeight);
    const before = await pageHeight();
    await panel.getByRole("button", { name: "Expand all" }).click();
    await expect(header("api")).toHaveAttribute("aria-expanded", "true");
    await expect(header("billing")).toHaveAttribute("aria-expanded", "true");
    await expect(chip("API_VAR_31")).toBeAttached();
    await expect(panel.getByRole("button", { name: "Collapse all" })).toBeVisible();

    // 60 more chips and the page is as tall as before: the panel stops at the editor's height.
    expect(await pageHeight()).toBe(before);
    const panelBox = await panel.boundingBox();
    const editorBox = await editor.boundingBox();
    expect(Math.abs((panelBox?.height ?? 0) - (editorBox?.height ?? 0))).toBeLessThan(1.5);
    const metrics = () =>
      list.evaluate((el) => ({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollbar: el.offsetWidth - el.clientWidth,
        scrollbarWidth: getComputedStyle(el).scrollbarWidth,
        fadeStart: el.hasAttribute("data-fade-start"),
        fadeEnd: el.hasAttribute("data-fade-end"),
      }));
    const top = await metrics();
    expect(top.scrollHeight).toBeGreaterThan(top.clientHeight + 200);
    // No scrollbar takes room or shows; the bottom edge fades while it hides chips.
    expect(top.scrollbar).toBe(0);
    expect(top.scrollbarWidth).toBe("none");
    expect(top).toMatchObject({ scrollTop: 0, fadeStart: false, fadeEnd: true });
    // The title and hint are not part of what scrolls.
    await expect(list.getByRole("heading", { name: "References" })).toHaveCount(0);
    await expect(list.getByText(/^Click to insert/)).toHaveCount(0);
    await page.screenshot({ path: `${shots}/expanded-scrolls.png`, animations: "disabled" });

    // The wheel scrolls the list, not the page.
    const pageScroll = await page.evaluate(() => window.scrollY);
    await list.hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(async () => (await metrics()).scrollTop).toBeGreaterThan(0);
    await expect.poll(async () => (await metrics()).fadeStart).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
    await page.mouse.move(0, 0, { steps: 5 });

    // Keys: from a header at the top, Page Down scrolls the list.
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    await header("worker").focus();
    await page.keyboard.press("PageDown");
    await expect.poll(async () => (await metrics()).scrollTop).toBeGreaterThan(0);

    // Tab reaches every chip, down to the last one, which scrolls into view.
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    await panel.getByRole("button", { name: "Collapse all" }).focus();
    const last = chip("SMTP_PASS");
    for (let i = 0; i < 120 && !(await last.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(last).toBeFocused();
    const shown = await last.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const view = el.closest('[data-slot="references-list"]')?.getBoundingClientRect();
      return view !== undefined && box.top >= view.top && box.bottom <= view.bottom;
    });
    expect(shown).toBe(true);
    const end = await metrics();
    expect(end.scrollTop + end.clientHeight).toBeGreaterThan(end.scrollHeight - 40);
    expect(end.fadeEnd).toBe(false);
  });

  test("each group collapses and expands by click, Enter or Space, and stays so after a reload", async ({ page }) => {
    await installDemo(page);
    await page.goto(environmentUrl);
    const { panel, header, list } = await environment(page);
    const chip = (name: string) => panel.getByRole("button", { name, exact: true });
    const groups = ["worker", "db", "redis", "api", "Project"];

    // The demo's groups are short: all start expanded, and the header offers Collapse all.
    for (const name of groups) await expect(header(name)).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByRole("button", { name: "Collapse all" })).toBeVisible();

    // A click on db's header row leaves only its count.
    await header("db").click();
    await expect(header("db")).toHaveAttribute("aria-expanded", "false");
    await expect(header("db")).toContainText("4 variables");
    await expect(chip("EXPOSED_URL")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Expand all" })).toBeVisible();
    // Enter on api's header; Space twice on the shared variables' header.
    await header("api").focus();
    await page.keyboard.press("Enter");
    await expect(header("api")).toHaveAttribute("aria-expanded", "false");
    await expect(header("api")).toContainText("4 variables");
    await expect(chip("DOMAIN")).toHaveCount(0);
    await header("Project").focus();
    await page.keyboard.press("Space");
    await expect(header("Project")).toHaveAttribute("aria-expanded", "false");
    await expect(chip("SMTP_HOST")).toHaveCount(0);
    await page.keyboard.press("Space");
    await expect(header("Project")).toHaveAttribute("aria-expanded", "true");
    await expect(chip("SMTP_HOST")).toBeVisible();
    // A collapsed group's chips leave the Tab order: from db's header, Tab goes to redis's.
    await header("db").focus();
    await page.keyboard.press("Tab");
    await expect(header("redis")).toBeFocused();
    // Everything fits now: no edge fades.
    await expect(list).not.toHaveAttribute("data-fade-end");
    await expect(list).not.toHaveAttribute("data-fade-start");
    await page.screenshot({ path: `${shots}/some-collapsed.png`, animations: "disabled" });

    // A reload keeps them.
    await page.reload();
    const reloaded = await environment(page);
    for (const name of ["db", "api"]) await expect(reloaded.header(name)).toHaveAttribute("aria-expanded", "false");
    for (const name of ["worker", "redis", "Project"]) await expect(reloaded.header(name)).toHaveAttribute("aria-expanded", "true");
    await expect(chip("EXPOSED_URL")).toHaveCount(0);
    await expect(chip("SMTP_HOST")).toBeVisible();

    // Expand all, and a reload keeps that too.
    await reloaded.panel.getByRole("button", { name: "Expand all" }).click();
    for (const name of groups) await expect(reloaded.header(name)).toHaveAttribute("aria-expanded", "true");
    await page.reload();
    const again = await environment(page);
    for (const name of groups) await expect(again.header(name)).toHaveAttribute("aria-expanded", "true");
    await expect(chip("EXPOSED_URL")).toBeVisible();
  });

  test("the panel is up to 440px wide next to the editor and wraps under it on a phone", async ({ page }) => {
    await installDemo(page, { overrides: { "env.references": () => manyReferences } });
    await page.goto(environmentUrl);
    const { panel, editor } = await environment(page);
    const boxes = async () => {
      const [p, e] = [await panel.boundingBox(), await editor.boundingBox()];
      if (!p || !e) throw new Error("the panel or the editor is not on screen");
      return { panel: p, editor: e };
    };
    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    // 1440: 440px next to the editor, the editor takes the rest.
    let at = await boxes();
    expect(Math.round(at.panel.width)).toBe(440);
    expect(Math.abs(at.panel.y - at.editor.y)).toBeLessThan(1);
    expect(at.editor.width).toBeGreaterThan(640);
    await expect.poll(sideways).toBe(0);

    // 1280: still next to it and wider than the 320px it had, while the editor keeps 600px for its lines.
    await page.setViewportSize({ width: 1280, height: 800 });
    at = await boxes();
    expect(Math.abs(at.panel.y - at.editor.y)).toBeLessThan(1);
    expect(at.panel.width).toBeGreaterThan(330);
    expect(at.panel.width).toBeLessThan(440);
    expect(Math.round(at.editor.width)).toBeGreaterThanOrEqual(600);
    await expect.poll(sideways).toBe(0);
    await page.screenshot({ path: `${shots}/width-1280.png`, animations: "disabled" });

    // 390: under the editor, the page's width less its gutters, no sideways scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    at = await boxes();
    expect(at.panel.y).toBeGreaterThanOrEqual(at.editor.y + at.editor.height);
    expect(at.panel.width).toBeLessThanOrEqual(390 - 32 + 0.5);
    expect(at.panel.width).toBeGreaterThan(300);
    await expect.poll(sideways).toBe(0);
    // Still no taller than the editor, everything expanded.
    await panel.getByRole("button", { name: "Expand all" }).click();
    await expect(panel.getByRole("button", { name: "Collapse all" })).toBeVisible();
    at = await boxes();
    expect(at.panel.height).toBeLessThanOrEqual(at.editor.height + 1);
    await expect.poll(sideways).toBe(0);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/width-390.png`, animations: "disabled" });
  });
});
