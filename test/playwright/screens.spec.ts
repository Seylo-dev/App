// Every screen of the web app with the demo data (demo/*.ts), in every
// theme preset and both of its halves (light and dark), plus a few open
// dialogs and the phone width. Each screen must render without a page
// error, an error page or a "not built yet" note, and is screenshotted to
// $SHOTS_DIR/screens/<preset>/<mode>/<name>.png for comparing with the
// approved boards in design/project.
//
//   PRESETS=seylo,midnight  limits the presets (default: all of them)
//   MODES=dark              limits the halves (default: light,dark)
//   SCREENS=deployments     only screens whose name contains one of these

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids, nodes as demoNodes } from "./demo/fixtures";
import { installDemo, modes, type Preset, presets } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/screens`;
const wanted = (process.env.PRESETS?.split(",") ?? presets) as Preset[];
const wantedModes = (process.env.MODES?.split(",") ?? modes) as (typeof modes)[number][];
const only = process.env.SCREENS?.split(",");

const service = (id: string, tab = "") => `/p/${ids.acme}/s/${id}${tab ? `/${tab}` : ""}`;

/** [name, path]. Paths with a node sheet or a dialog say so with the third item. */
export const screens: [string, string, ("dialog" | "page")?][] = [
  ["dashboard", "/"],
  ["nodes", "/nodes"],
  ["node-overview", `/nodes?node=${ids.de}`, "dialog"],
  ["node-health", `/nodes?node=${ids.us}&view=health`, "dialog"],
  ["node-cleanup", `/nodes?node=${ids.de}&view=cleanup`, "dialog"],
  ["node-shell", `/nodes?node=${ids.de}&view=shell`, "dialog"],
  ["project", `/p/${ids.acme}`],
  ["project-settings", `/p/${ids.acme}?tab=settings`],
  ["templates", "/templates"],
  ["templates-docker-hub", "/templates?tab=docker-hub&q=gitea"],
  ["activity", "/activity"],
  ["approvals", "/approvals"],
  ["cli-approve", "/cli/approve?code=ABCD-EFGH"],
  ["kit", "/dev/kit"],
  // An app with every tab (Service.dc.html, Deployments, Environment, Domains).
  ["service-overview", service(svc.api)],
  ["service-deployments", service(svc.worker, "deployments")],
  ["service-source", service(svc.api, "source")],
  // A git URL source: the credential picker with Add credential (git-credentials.spec.ts covers the dialog).
  ["service-source-git", service(svc.privateApi, "source")],
  ["service-environment", service(svc.worker, "environment")],
  ["service-domains", service(svc.web, "domains")],
  // One Console tab with two modes; /shell redirects to the second (console.spec.ts).
  ["service-console", service(svc.api, "console")],
  ["service-console-shell", `${service(svc.api, "console")}?mode=shell`],
  // Nothing runs: the Overview's console note, and the failed clone's title and hint.
  ["service-overview-failed-clone", service(svc.privateApi)],
  ["service-logs", service(svc.api, "logs")],
  ["service-metrics", service(svc.api, "metrics")],
  ["service-storage", service(svc.api, "storage")],
  ["service-backups", service(svc.api, "backups")],
  ["service-previews", service(svc.web, "previews")],
  ["service-cron", service(svc.api, "cron")],
  ["service-alerts", service(svc.api, "alerts")],
  ["service-advanced", service(svc.api, "advanced")],
  ["service-notes", service(svc.api, "notes")],
  ["service-settings", service(svc.api, "settings")],
  ["cron-service", service(svc.cron)],
  ["box", service(svc.box)],
  ["compose", service(svc.stack)],
  ["compose-file", service(svc.stack, "source")],
  // A database (Database.dc.html).
  ["database-connection", service(svc.db, "connection")],
  ["database-backups", service(svc.db, "backups")],
  ["redis-connection", service(svc.redis, "connection")],
  ["clickhouse-connection", service(svc.clickhouse, "connection")],
  // Settings.
  ...(
    [
      "general",
      "updates",
      "people",
      "api-keys",
      "github",
      "git-providers",
      "cloudflare",
      "notifications",
      "backups",
      "cleanup",
      "maintenance",
      "appearance",
      "ai",
      "telemetry",
      "profile",
      "security",
      "preferences",
      "push",
    ] as const
  ).map((name): [string, string] => [`settings-${name}`, `/settings/${name}`]),
];

async function settle(page: Page, kind: "dialog" | "page" = "page"): Promise<void> {
  if (kind === "dialog") await expect(page.getByRole("dialog")).toBeVisible();
  else await expect(page.locator("main").first()).toBeVisible();
  // Loading placeholders go away once the demo data is in (a cold Vite can take a while).
  await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0, { timeout: 15_000 });
  // Charts animate, Monaco and xterm load lazily.
  await page.waitForTimeout(1600);
}

async function expectRendered(page: Page, name: string): Promise<void> {
  await expect(page.getByText("This page failed to load"), `${name} shows the error page`).toHaveCount(0);
  await expect(page.getByText("Page not found"), `${name} is not found`).toHaveCount(0);
  await expect(page.getByText("Not built yet", { exact: false }), `${name} says not built yet`).toHaveCount(0);
}

test.describe("screens", () => {
  test.use({ storageState: stateFile });

  for (const [preset, mode] of wanted.flatMap((preset) => wantedModes.map((mode) => [preset, mode] as const))) {
    test(`every screen in ${preset} ${mode}`, async ({ page }) => {
      test.setTimeout(10 * 60_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
      await installDemo(page, { preset, mode });
      const dir = `${shots}/${preset}/${mode}`;
      mkdirSync(dir, { recursive: true });

      for (const [name, path, kind] of screens) {
        if (only && !only.some((part) => name.includes(part))) continue;
        await test.step(name, async () => {
          await page.goto(path);
          await settle(page, kind);
          await expectRendered(page, name);
          await page.screenshot({ path: `${dir}/${name}.png`, fullPage: kind !== "dialog" });
        });
      }

      if (!only || only.some((part) => "sign-in".includes(part))) {
        await test.step("sign-in", async () => {
          // Signed out for this one page: whoami refuses, so /login shows its form.
          const signedOut = /\/api\/v1\/auth\.whoami/;
          await page.route(signedOut, (route) =>
            route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Sign in first" } }),
            }),
          );
          await page.goto("/login");
          await expect(page.getByRole("heading", { level: 1, name: /^Sign in to / })).toBeVisible();
          await page.waitForTimeout(400);
          await expectRendered(page, "sign-in");
          await page.screenshot({ path: `${dir}/sign-in.png`, fullPage: true });
          await page.unroute(signedOut);
        });
      }

      if (!only) {
        await test.step("open dialogs", async () => {
          await page.goto(`/p/${ids.acme}`);
          // The sidebar counts what waits in Approvals (two in the demo data).
          await expect(page.getByRole("link", { name: /Approvals\s*2/ })).toBeVisible();
          await page.getByRole("button", { name: "New service", exact: true }).click();
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${dir}/new-service-menu.png` });
          await page.keyboard.press("Escape");

          // New app > GitHub with the Browse list open (repo-picker.spec.ts covers the flows).
          await page.getByRole("button", { name: "New service", exact: true }).click();
          await page.getByRole("menuitem").filter({ hasText: "GitHub, Git, Docker image" }).click();
          const newApp = page.getByRole("dialog", { name: "New app" });
          await newApp.getByRole("radio", { name: "GitHub", exact: true }).click();
          await newApp.getByRole("button", { name: "Browse" }).click();
          await expect(page.locator('[data-slot="popover"]').getByRole("option").first()).toBeVisible();
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${dir}/new-app-repo-browse.png` });
          // One Escape per layer: the list first (once its fade is over), then the dialog.
          await page.keyboard.press("Escape");
          await expect(page.locator('[data-slot="popover"]')).toHaveCount(0);
          await page.keyboard.press("Escape");
          await expect(newApp).toHaveCount(0);

          await page.goto(`/templates?project=${ids.acme}`);
          await page.getByRole("button", { name: /n8n/ }).first().click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.waitForTimeout(1200);
          await page.screenshot({ path: `${dir}/template-install.png` });
          await page.keyboard.press("Escape");

          await page.goto(`/templates?project=${ids.acme}&tab=docker-hub&q=gitea`);
          await page.getByRole("button", { name: /^gitea\/gitea / }).click();
          await expect(page.getByRole("dialog").locator(".monaco-editor")).toBeVisible({ timeout: 15_000 });
          await page.waitForTimeout(800);
          await page.screenshot({ path: `${dir}/docker-hub-image.png` });
          await page.keyboard.press("Escape");

          await page.keyboard.press("ControlOrMeta+k");
          await page.getByPlaceholder("Type a command or search").fill("api");
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${dir}/palette.png` });
          await page.keyboard.press("Escape");

          await page.goto(service(svc.worker, "deployments"));
          await page.getByRole("button", { name: /Full logs|Logs/ }).first().click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.waitForTimeout(1200);
          await page.screenshot({ path: `${dir}/deploy-log-modal.png` });
          await page.keyboard.press("Escape");

          await page.goto(service(svc.api, "storage"));
          await page.getByRole("button", { name: "Files" }).first().click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.waitForTimeout(800);
          await page.screenshot({ path: `${dir}/files.png` });
          await page.keyboard.press("Escape");
        });
      }

      expect(errors).toEqual([]);
    });
  }

  test("a saved accent repaints every preset in both halves", async ({ context }) => {
    test.setTimeout(3 * 60_000);
    const accent = "#0F8A6A";
    for (const [preset, mode] of presets.flatMap((preset) => modes.map((mode) => [preset, mode] as const))) {
      const page = await context.newPage();
      await installDemo(page, { preset, mode, accent });
      await page.goto("/");
      await settle(page);
      const colors = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        // Computed colors can be oklab(...); a canvas turns any CSS color into rgb.
        const canvas = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
        const rgb = (color: string) => {
          canvas.fillStyle = color;
          canvas.fillRect(0, 0, 1, 1);
          const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
          return `rgb(${r}, ${g}, ${b})`;
        };
        // The selected nav item, not the logo link home (which has an aria-label and no text of its own).
        const current = [...document.querySelectorAll('nav [data-status="active"]')].find((el) => !el.getAttribute("aria-label"));
        const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("New service"));
        return {
          primary: css.getPropertyValue("--primary").trim(),
          nav: current ? rgb(getComputedStyle(current).color) : "",
          button: button ? rgb(getComputedStyle(button).backgroundColor) : "",
        };
      });
      expect(colors.primary.toUpperCase(), `${preset} ${mode} --primary`).toBe(accent);
      // Green wins over blue in the selected nav item and the primary button.
      for (const [what, color] of [["nav", colors.nav], ["button", colors.button]] as const) {
        const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
        expect(g > b && g > r, `${preset} ${mode} ${what} is green (${color})`).toBe(true);
      }
      await page.close();
    }
  });

  test("the service tabs show every tab from md up (wrapping with a line per row), and swipe on a phone", async ({ page }) => {
    await installDemo(page);
    const bar = page.getByRole("navigation", { name: "Service sections" });
    const measure = () =>
      bar.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          // Distinct tops of the tabs: 1 means one row.
          rows: new Set([...el.children].map((child) => Math.round(child.getBoundingClientRect().top))).size,
          hidden: el.scrollWidth - el.clientWidth,
          height: box.height,
          fadeStart: el.hasAttribute("data-fade-start"),
          fadeEnd: el.hasAttribute("data-fade-end"),
        };
      });

    // 1440 wide: an app's 16 tabs fit one row, nothing hidden.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(service(svc.api));
    await settle(page);
    const desktop = await measure();
    expect(desktop.rows, "the tab bar wraps").toBe(1);
    expect(desktop.hidden).toBe(0);
    expect({ start: desktop.fadeStart, end: desktop.fadeEnd }).toEqual({ start: false, end: false });
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/service-tabs-desktop.png` });

    // 1280 and 1024 (a laptop with a mouse, which cannot scroll a sideways row): the tabs wrap, every one
    // shows, and each row has its own track line, so the current tab's underline sits on a line.
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(service(svc.api, "settings"));
      await settle(page);
      const wrapped = await measure();
      expect(wrapped.rows, `${width}: two rows`).toBe(2);
      expect(wrapped.hidden, `${width}: nothing hidden`).toBe(0);
      expect(wrapped.height, `${width}: 40px rows`).toBe(80);
      expect(wrapped.fadeEnd || wrapped.fadeStart).toBe(false);
      expect(await bar.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("repeating-linear-gradient");
      for (const name of ["Notes", "Settings"]) await expect(bar.getByRole("link", { name })).toBeInViewport({ ratio: 1 });
      // The underline of the current tab (in the second row) lies on that row's line.
      const currentBottom = await bar.evaluate((el) => {
        const current = el.querySelector('[aria-current="page"]') as HTMLElement;
        return current.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
      });
      expect(currentBottom).toBe(80);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `${shots}/service-tabs-${width}.png` });
    }

    // A phone keeps one swipe row: the end fades while tabs hide past it, the start once scrolled.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(service(svc.api));
    await settle(page);
    const phone = await measure();
    expect(phone.rows).toBe(1);
    expect(phone.hidden).toBeGreaterThan(0);
    expect({ start: phone.fadeStart, end: phone.fadeEnd }).toEqual({ start: false, end: true });
    await page.screenshot({ path: `${shots}/service-tabs-phone.png` });
    await bar.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect(bar).toHaveAttribute("data-fade-start", "");
    await expect(bar).not.toHaveAttribute("data-fade-end", "");

    // Arriving on a later tab on a phone: before, the row always started at Overview and no tab looked selected.
    await page.goto(service(svc.api, "alerts"));
    await settle(page);
    await expect(bar.getByRole("link", { name: "Alerts" })).toBeInViewport({ ratio: 1 });
    await expect(bar).toHaveAttribute("data-fade-start", "");
  });

  test("the project tabs, the settings sections and the node sheet views stay one row on a phone with the current one in view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installDemo(page);

    // The project tabs wrapped onto two rows under one underline.
    await page.goto(`/p/${ids.acme}?tab=settings`);
    await settle(page);
    const tabs = page.getByRole("tablist", { name: "Project sections" });
    const rows = await tabs.evaluate((el) => new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().top))).size);
    expect(rows, "the project tabs wrap").toBe(1);
    await expect(tabs.getByRole("tab", { name: "Settings" })).toBeInViewport({ ratio: 1 });

    // The settings strip showed General to API keys whatever section was open.
    await page.goto("/settings/telemetry");
    await settle(page);
    const strip = page.getByRole("navigation", { name: "Settings" });
    await expect(strip.getByRole("link", { name: "Telemetry" })).toBeInViewport({ ratio: 1 });

    // The node sheet's Settings view sat behind the faded edge.
    await page.goto(`/nodes?node=${ids.de}&view=settings`);
    await settle(page, "dialog");
    const views = page.getByRole("radiogroup", { name: "Node views" });
    await expect(views.getByRole("radio", { name: "Settings" })).toBeInViewport({ ratio: 1 });
  });

  test("the node list never runs past its card: a table that does not fit becomes stacked rows", async ({ page }) => {
    // The widest cells: a full IPv6 address, Update now and a can-build warning on one row.
    const wide = {
      ...demoNodes[2],
      publicIpv4: null,
      publicIpv6: "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      canBuildWarning: "docker buildx is missing",
      wildcardDomain: "apps-production-eu-central.example.com",
    };
    await installDemo(page, { overrides: { "nodes.list": () => ({ nodes: [demoNodes[0], demoNodes[1], wide] }) } });
    const list = page.getByRole("region", { name: "Node list" });
    const layout = () =>
      list.evaluate((el) => {
        const table = el.querySelector("table");
        const wideRow = [...el.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Health").at(-1);
        return {
          table: table !== null,
          tableRight: table?.getBoundingClientRect().right ?? 0,
          healthRight: wideRow?.getBoundingClientRect().right ?? 0,
          right: el.getBoundingClientRect().right,
          scrolls: el.scrollWidth > el.clientWidth + 1,
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto("/nodes");
    await settle(page);
    // Resized in place, as a window is: the table turns into stacked rows once it would not fit, and back.
    for (const width of [1920, 1440, 1366, 1340, 1320, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const at = await layout();
      if (width === 1920) expect(at.table, "1920: the table").toBe(true);
      if (width === 1320) expect(at.table, "1320: stacked rows").toBe(false);
      if (at.table) {
        expect(at.tableRight, `${width}: the table sticks out of the card`).toBeLessThanOrEqual(at.right + 1);
        expect(at.scrolls, `${width}: the table scrolls inside the card`).toBe(false);
      }
      expect(at.healthRight, `${width}: Health is off the card`).toBeLessThanOrEqual(at.right);
      expect(at.page, `${width}: the page scrolls sideways`).toBeLessThanOrEqual(0);
    }
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/nodes-wide-row.png` });
  });

  test("phone width has no sideways scroll", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await installDemo(page);
    mkdirSync(`${shots}/phone`, { recursive: true });
    // Of the node sheet views, Cleanup and Shell are checked too (inside the sheet, below).
    const sheetViews = new Set(["node-cleanup", "node-shell"]);
    for (const [name, path] of screens) {
      if ((path.includes("node=") && !sheetViews.has(name)) || name === "kit") continue;
      if (only && !only.some((part) => name.includes(part))) continue;
      await page.goto(path);
      await settle(page);
      await page.screenshot({ path: `${shots}/phone/${name}.png`, fullPage: true });
      // Wide tables scroll inside their card; the page itself never does.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect.soft(overflow, `${name} scrolls sideways`).toBeLessThanOrEqual(0);
      if (sheetViews.has(name)) {
        // A sheet is fixed to the viewport, so its overflow never reaches the
        // page: it must not scroll sideways itself, and the view switcher
        // (five views) stays inside it, scrolling within its own track.
        const sheet = await page.getByRole("dialog").evaluate((el) => {
          const box = el.getBoundingClientRect();
          const views = el.querySelector('[data-slot="segmented"]')?.getBoundingClientRect();
          return { overflow: el.scrollWidth - el.clientWidth, right: box.right, viewsRight: views?.right ?? 0 };
        });
        expect.soft(sheet.overflow, `${name}: the sheet scrolls sideways`).toBeLessThanOrEqual(0);
        expect.soft(sheet.viewsRight, `${name}: the view switcher sticks out of the sheet`).toBeLessThanOrEqual(sheet.right);
        expect.soft(sheet.right, `${name}: the sheet is wider than the phone`).toBeLessThanOrEqual(390);
      }
    }
  });
});
