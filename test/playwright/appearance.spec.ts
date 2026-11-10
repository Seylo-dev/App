// Theme presets and color modes with the demo data: "system" follows the
// device before and after the app starts and switches live; every preset
// paints both halves with its own surfaces and readable text; and the
// Appearance screen's tiles, default branding images, sign-in message
// placeholder and the custom CSS guide with Insert example.

import type { Page } from "@playwright/test";
import { installDemo, modes, presets } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/appearance`;
const darkClass = /(^|\s)dark(\s|$)/;

/** The page's tokens as rgb() strings (computed colors can be oklab(...) or color-mix: a canvas turns any CSS color into rgb). */
function tokens(page: Page, names: string[]) {
  return page.evaluate((list) => {
    const canvas = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
    const probe = document.createElement("span");
    document.body.append(probe);
    const out: Record<string, [number, number, number]> = {};
    for (const name of list) {
      probe.style.color = `var(${name})`;
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = getComputedStyle(probe).color;
      canvas.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = canvas.getImageData(0, 0, 1, 1).data;
      out[name] = [r, g, b];
    }
    probe.remove();
    return out;
  }, names);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const luminance = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test.describe("appearance", () => {
  test.use({ storageState: stateFile });

  test("System follows the device before the app paints and every switch after", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await installDemo(page, { preset: "clay", mode: "system" });
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "clay");
    await expect(html).toHaveAttribute("data-color-mode", "system");
    await expect(html).toHaveClass(darkClass);
    expect((await tokens(page, ["--background"]))["--background"]).toEqual([0x1a, 0x14, 0x10]);

    await page.emulateMedia({ colorScheme: "light" });
    await expect(html).not.toHaveClass(darkClass);
    expect((await tokens(page, ["--background"]))["--background"]).toEqual([0xf3, 0xec, 0xe3]);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(html).toHaveClass(darkClass);
  });

  test("an explicit mode wins over the device", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await installDemo(page, { preset: "harbor", mode: "light" });
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "harbor");
    await expect(html).not.toHaveClass(darkClass);
    await page.emulateMedia({ colorScheme: "light" });
    await installDemo(page, { preset: "harbor", mode: "dark" });
    await page.goto("/");
    await expect(html).toHaveClass(darkClass);
  });

  test("every preset paints both halves with its own surfaces and text that reads", async ({ page }) => {
    await installDemo(page, { preset: "seylo" });
    await page.goto("/");
    await expect(page.locator("main").first()).toBeVisible();
    const seen = new Map<string, string>();
    for (const preset of presets) {
      for (const mode of modes) {
        await page.evaluate(
          ([p, m]) => {
            document.documentElement.setAttribute("data-theme", p);
            document.documentElement.classList.toggle("dark", m === "dark");
          },
          [preset, mode],
        );
        const t = await tokens(page, [
          "--background",
          "--card",
          "--sidebar",
          "--foreground",
          "--muted-foreground",
          "--ink-faint",
          "--primary",
          "--primary-foreground",
          "--link",
          "--accent",
          "--accent-foreground",
          "--chip-green-bg",
          "--chip-green-fg",
          "--chip-red-bg",
          "--chip-red-fg",
        ]);
        const where = `${preset} ${mode}`;
        const card = t["--card"] as [number, number, number];
        expect(contrast(t["--foreground"] as never, card), `${where} text on card`).toBeGreaterThanOrEqual(10);
        expect(contrast(t["--foreground"] as never, t["--background"] as never), `${where} text on ground`).toBeGreaterThanOrEqual(10);
        expect(contrast(t["--muted-foreground"] as never, card), `${where} muted text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--ink-faint"] as never, card), `${where} faint icons`).toBeGreaterThanOrEqual(3);
        expect(contrast(t["--primary-foreground"] as never, t["--primary"] as never), `${where} text on the accent`).toBeGreaterThanOrEqual(4);
        expect(contrast(t["--link"] as never, card), `${where} links`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--accent-foreground"] as never, t["--accent"] as never), `${where} selected nav item`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--chip-green-fg"] as never, t["--chip-green-bg"] as never), `${where} green chip`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--chip-red-fg"] as never, t["--chip-red-bg"] as never), `${where} red chip`).toBeGreaterThanOrEqual(4.5);
        // Dark halves are dark and light halves light.
        const darkCard = contrast(card, [0, 0, 0]) < contrast(card, [255, 255, 255]);
        expect(darkCard, `${where} card`).toBe(mode === "dark");
        // No two presets share a look: ground, card, sidebar and accent together.
        const look = JSON.stringify([t["--background"], t["--card"], t["--sidebar"], t["--primary"]]);
        expect(seen.get(look), `${where} looks like ${seen.get(look)}`).toBeUndefined();
        seen.set(look, where);
      }
    }
  });

  test("the Appearance screen: tiles follow the mode, defaults show, and Insert example adds the sample", async ({ page }) => {
    await installDemo(page, { preset: "seylo", mode: "light" });
    await page.goto("/settings/appearance");
    const tiles = page.getByRole("radiogroup", { name: "Theme preset" }).getByRole("radio");
    await expect(tiles).toHaveCount(presets.length);
    const firstGround = () => tiles.first().locator("span").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const light = await firstGround();
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(darkClass);
    expect(await firstGround()).not.toBe(light);
    await page.getByRole("radio", { name: /^Harbor/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "harbor");

    // Nothing uploaded: the tiles show the product mark and the built-in favicon, marked Default.
    for (const name of ["Logo, light", "Logo, dark"]) {
      const tile = page.getByRole("button", { name, exact: true });
      await expect(tile.locator("svg")).toBeVisible();
      await expect(tile).toContainText("Default");
    }
    const favicon = page.getByRole("button", { name: "Favicon", exact: true });
    await expect(favicon.locator("img")).toHaveAttribute("src", "/favicon.svg");
    await expect(favicon).toContainText("Default");

    // The sign-in page has no message of its own: the placeholder says so.
    const message = page.getByLabel("Sign-in page message");
    await message.fill("");
    await expect(message).toHaveAttribute("placeholder", /Sign in to Acme Cloud/);

    await expect(page.getByText("How it works")).toBeVisible();
    const css = page.getByRole("region", { name: "Custom CSS" });
    const editor = css.locator(".monaco-editor");
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await css.getByRole("button", { name: "Insert example" }).click();
    // The editor scrolls to the end of the sample.
    await expect(editor.locator(".view-line", { hasText: "var(--link)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
    await page.screenshot({ path: `${shots}/appearance-harbor-dark.png`, fullPage: true });
    // The sample is live in the preview: its dark --background (#0b1210) paints the page.
    await expect
      .poll(async () => (await tokens(page, ["--background"]))["--background"], { timeout: 5_000 })
      .toEqual([0x0b, 0x12, 0x10]);
  });
});
