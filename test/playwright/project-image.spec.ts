// A project's image (0.2.6), on the demo data: project Settings has an
// Image card; an uploaded picture is cropped to a 256 px square in the
// browser, sent with projects.setImage and shows in the card, the sidebar,
// the dashboard and the project's header; Remove image brings the initial
// back; an SVG is refused before anything is sent; an image that does not
// load shows the initial. Screenshots go to $SHOTS_DIR/project-image/.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids, projects as demoProjects } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

const shots = `${process.env.SHOTS_DIR ?? "test/playwright/shots"}/project-image`;
type Calls = { op: string; input: Record<string, any> }[];

/** The projects as the ops answer them, with an image the ops set and remove; `uploaded` is the last data URL. */
async function open(page: Page, path: string, imageUrl: string | null = null) {
  const state = { imageUrl, uploaded: "", calls: [] as Calls };
  const list = () => demoProjects.map((p) => (p.id === ids.acme ? { ...p, imageUrl: state.imageUrl } : p));
  const acme = () => list().find((p) => p.id === ids.acme);
  await installDemo(page, {
    nodeLive: "silent",
    overrides: {
      "projects.list": () => ({ projects: list() }),
      "projects.get": (input) => list().find((p) => p.id === input.projectId) ?? acme(),
      "projects.setImage": (input) => {
        state.calls.push({ op: "projects.setImage", input });
        state.uploaded = input.dataUrl;
        state.imageUrl = `/api/avatars/project/${ids.acme}?v=demo${state.calls.length}`;
        return acme();
      },
      "projects.removeImage": (input) => {
        state.calls.push({ op: "projects.removeImage", input });
        state.imageUrl = null;
        return acme();
      },
    },
  });
  // The uploaded image, served the way the panel would; anything else under the route is a 404.
  await page.route(/\/api\/avatars\/project\//, (route) => {
    if (!state.uploaded) return route.fulfill({ status: 404, body: "Not found" });
    const [, base64 = ""] = state.uploaded.split(",");
    return route.fulfill({ status: 200, contentType: state.uploaded.slice(5, state.uploaded.indexOf(";")), body: Buffer.from(base64, "base64") });
  });
  await page.goto(path);
  return state;
}

const sidebarRow = (page: Page) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("list", { name: "Projects" }).locator(":scope > li").first();

async function loaded(image: Locator) {
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
}

/** A 320 x 200 PNG with an orange square in the middle, drawn in the page. */
async function photo(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, 320, 200);
    ctx.fillStyle = "#f7783c";
    ctx.fillRect(110, 50, 100, 100);
    return canvas.toDataURL("image/png").split(",")[1] as string;
  });
  return Buffer.from(base64, "base64");
}

test("an uploaded image is cropped to 256 px, shows in Settings, the sidebar, the dashboard and the header, and can be removed", async ({
  page,
}) => {
  const state = await open(page, `/p/${ids.acme}?tab=settings`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Image", exact: true }) });
  await expect(card.getByRole("button", { name: "Upload image" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Remove image" })).toHaveCount(0);
  await expect(sidebarRow(page).locator("img")).toHaveCount(0);
  const picker = page.locator('input[type="file"]');

  // Not an image the panel takes: refused in the browser, nothing sent.
  await picker.setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
  await expect(page.getByText("Pick a PNG, JPEG or WebP image.").first()).toBeVisible();
  expect(state.calls).toEqual([]);

  await picker.setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: await photo(page) });
  await expect(page.getByText("Project image updated").first()).toBeVisible();
  const sent = state.calls.find((c) => c.op === "projects.setImage");
  expect(sent?.input.projectId).toBe(ids.acme);
  expect(sent?.input.dataUrl).toMatch(/^data:image\/(webp|png);base64,/);
  const size = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, sent?.input.dataUrl as string);
  expect(size).toEqual([256, 256]);

  const preview = card.locator("img");
  await expect(preview).toHaveAttribute("src", new RegExp(`^/api/avatars/project/${ids.acme}\\?v=`));
  await loaded(preview);
  await expect(card.getByRole("button", { name: "Upload another" })).toBeVisible();
  await loaded(sidebarRow(page).locator("img"));
  await loaded(page.getByRole("heading", { level: 1 }).locator("img"));
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/settings.png` });

  await page.getByRole("link", { name: "Dashboard" }).first().click();
  const dashboardCard = page.getByRole("region", { name: "Projects" }).locator("article").first();
  await loaded(dashboardCard.locator("img").first());
  await page.screenshot({ path: `${shots}/dashboard.png` });

  await page.goto(`/p/${ids.acme}?tab=settings`);
  await card.getByRole("button", { name: "Remove image" }).click();
  await expect(page.getByText("Image removed. The initial is back.").first()).toBeVisible();
  expect(state.calls.at(-1)).toEqual({ op: "projects.removeImage", input: { projectId: ids.acme } });
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Remove image" })).toHaveCount(0);
  await expect(sidebarRow(page).locator("img")).toHaveCount(0);
  await expect(sidebarRow(page)).toContainText("acme-shop");
  await expect(page.getByRole("heading", { level: 1 }).locator("img")).toHaveCount(0);
});

test("an image that does not load shows the project's initial", async ({ page }) => {
  await open(page, "/", `/api/avatars/project/${ids.acme}?v=gone`);
  const row = sidebarRow(page);
  await expect(row).toContainText("acme-shop");
  await expect(row.locator("img")).toHaveCount(0);
  await expect(row.getByText("A", { exact: true })).toBeVisible();
});
