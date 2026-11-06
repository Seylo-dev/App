// Every screen of the web app with the demo data (demo/*.ts), in each of
// the four theme presets, plus a few open dialogs and the phone width. Each
// screen must render without a page error, an error page or a "not built
// yet" note, and is screenshotted to $SHOTS_DIR/screens/<preset>/<name>.png
// for comparing with the approved boards in design/project.
//
//   PRESETS=seylo,midnight  limits the presets (default: all four)
//   SCREENS=deployments     only screens whose name contains one of these

import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo, type Preset, presets } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { stateFile } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/screens`;
const wanted = (process.env.PRESETS?.split(",") ?? presets) as Preset[];
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
  ["service-environment", service(svc.worker, "environment")],
  ["service-domains", service(svc.web, "domains")],
  ["service-console", service(svc.api, "console")],
  ["service-shell", service(svc.api, "shell")],
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
  // Settings.
  ...(
    [
      "general",
      "updates",
      "people",
      "api-keys",
      "github",
      "cloudflare",
      "notifications",
      "backups",
      "cleanup",
      "maintenance",
      "appearance",
      "ai",
      "telemetry",
      "security",
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

  for (const preset of wanted) {
    test(`every screen in ${preset}`, async ({ page }) => {
      test.setTimeout(10 * 60_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
      await installDemo(page, { preset });
      mkdirSync(`${shots}/${preset}`, { recursive: true });

      for (const [name, path, kind] of screens) {
        if (only && !only.some((part) => name.includes(part))) continue;
        await test.step(name, async () => {
          await page.goto(path);
          await settle(page, kind);
          await expectRendered(page, name);
          await page.screenshot({ path: `${shots}/${preset}/${name}.png`, fullPage: kind !== "dialog" });
        });
      }

      if (!only) {
        await test.step("open dialogs", async () => {
          await page.goto(`/p/${ids.acme}`);
          // The sidebar counts what waits in Approvals (two in the demo data).
          await expect(page.getByRole("link", { name: /Approvals\s*2/ })).toBeVisible();
          await page.getByRole("button", { name: "New service" }).click();
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${shots}/${preset}/new-service-menu.png` });
          await page.keyboard.press("Escape");

          await page.goto(`/templates?project=${ids.acme}`);
          await page.getByRole("button", { name: /n8n/ }).first().click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.waitForTimeout(1200);
          await page.screenshot({ path: `${shots}/${preset}/template-install.png` });
          await page.keyboard.press("Escape");

          await page.goto(`/templates?project=${ids.acme}&tab=docker-hub&q=gitea`);
          await page.getByRole("button", { name: /^gitea\/gitea / }).click();
          await expect(page.getByRole("dialog").locator(".monaco-editor")).toBeVisible({ timeout: 15_000 });
          await page.waitForTimeout(800);
          await page.screenshot({ path: `${shots}/${preset}/docker-hub-image.png` });
          await page.keyboard.press("Escape");

          await page.keyboard.press("ControlOrMeta+k");
          await page.getByPlaceholder("Type a command or search").fill("api");
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${shots}/${preset}/palette.png` });
          await page.keyboard.press("Escape");

          await page.goto(service(svc.worker, "deployments"));
          await page.getByRole("button", { name: /Full logs|Logs/ }).first().click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.waitForTimeout(1200);
          await page.screenshot({ path: `${shots}/${preset}/deploy-log-modal.png` });
          await page.keyboard.press("Escape");

          await page.goto(service(svc.api, "storage"));
          await page.getByRole("button", { name: "Files" }).first().click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.waitForTimeout(800);
          await page.screenshot({ path: `${shots}/${preset}/files.png` });
          await page.keyboard.press("Escape");
        });
      }

      expect(errors).toEqual([]);
    });
  }

  test("a saved accent repaints every preset", async ({ context }) => {
    const accent = "#0F8A6A";
    for (const preset of presets) {
      const page = await context.newPage();
      await installDemo(page, { preset, accent });
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
        const current = document.querySelector('nav [data-status="active"]');
        const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("New service"));
        return {
          primary: css.getPropertyValue("--primary").trim(),
          nav: current ? rgb(getComputedStyle(current).color) : "",
          button: button ? rgb(getComputedStyle(button).backgroundColor) : "",
        };
      });
      expect(colors.primary.toUpperCase(), `${preset} --primary`).toBe(accent);
      // Green wins over blue in the selected nav item and the primary button.
      for (const [what, color] of [["nav", colors.nav], ["button", colors.button]] as const) {
        const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
        expect(g > b && g > r, `${preset} ${what} is green (${color})`).toBe(true);
      }
      await page.close();
    }
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
