// Settings > Personal details on the demo data: the page sits above
// Security under Your account; the name saves; the email shows a taken
// address under the field; the generated faces (Randomize, another style,
// picking one) and an uploaded image (cropped to 256 px in the browser,
// removed again) change the avatar on the page and in the sidebar chip.
// The faces come from the real panel's /api/avatars route. Screenshots of
// the page and the sidebar in a light and a dark preset go to
// $SHOTS_DIR/personal-details/.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { viewer as demoViewer } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { type Handler, installDemo, type Preset } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

const shots = `${process.env.SHOTS_DIR ?? "test/playwright/shots"}/personal-details`;
const face = (style: string, seed: string) => `/api/avatars/${style}/${seed}.svg`;

type Avatar = { kind: "preset" | "upload"; style: string; seed: string; url: string; presetUrl: string };

/** The signed-in person as the ops answer it, changed by the ops the page calls; `calls` records what they got. */
function account() {
  const state = {
    viewer: { ...demoViewer, name: "Dana Levi", email: "dana@acme.dev" },
    avatar: { kind: "preset", style: "notionists", seed: "dana", url: face("notionists", "dana"), presetUrl: face("notionists", "dana") } as Avatar,
    uploaded: "",
    calls: [] as { op: string; input: Record<string, any> }[],
  };
  const sync = () => {
    state.viewer = { ...state.viewer, avatarUrl: state.avatar.url };
    return { avatar: state.avatar };
  };
  sync();
  const record = (op: string, input: Record<string, any>) => state.calls.push({ op, input });
  const overrides: Record<string, Handler> = {
    "auth.whoami": () => ({ viewer: state.viewer, via: "session" }),
    "auth.updateProfile": (input) => {
      record("auth.updateProfile", input);
      state.viewer = { ...state.viewer, name: input.name };
      return { viewer: state.viewer };
    },
    "auth.changeEmail": (input) => {
      record("auth.changeEmail", input);
      if (String(input.email).toLowerCase() === "lee@acme.dev") {
        throw new DemoRefusal(409, "CONFLICT", "Another account already uses this email.", { field: "email" });
      }
      state.viewer = { ...state.viewer, email: String(input.email).toLowerCase() };
      return { viewer: state.viewer, oldAddressNotified: false };
    },
    "avatars.mine": () => ({ avatar: state.avatar }),
    "avatars.setPreset": (input) => {
      record("avatars.setPreset", input);
      const url = face(input.style, input.seed);
      state.avatar = { kind: "preset", style: input.style, seed: input.seed, url, presetUrl: url };
      return sync();
    },
    "avatars.upload": (input) => {
      record("avatars.upload", input);
      state.uploaded = input.dataUrl;
      state.avatar = { ...state.avatar, kind: "upload", url: `/api/avatars/user/${state.viewer.id}?v=demo${state.calls.length}` };
      return sync();
    },
    "avatars.removeUpload": () => {
      record("avatars.removeUpload", {});
      state.avatar = { ...state.avatar, kind: "preset", url: state.avatar.presetUrl };
      return sync();
    },
  };
  return { state, overrides };
}

async function openPage(page: Page, options: { preset?: Preset; mode?: "light" | "dark" } = {}) {
  const demo = account();
  await installDemo(page, { overrides: demo.overrides, ...options });
  // The uploaded image, served the way the panel would (the demo keeps it in the test).
  await page.route(/\/api\/avatars\/user\//, (route) => {
    const [, base64 = ""] = demo.state.uploaded.split(",");
    return route.fulfill({ status: 200, contentType: demo.state.uploaded.slice(5, demo.state.uploaded.indexOf(";")), body: Buffer.from(base64, "base64") });
  });
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { level: 1, name: "Personal details" })).toBeVisible();
  return demo.state;
}

/** The sidebar chip's picture: the avatar next to the name, linking to this page. */
function chipImage(page: Page) {
  return page.getByTitle("Your personal details and sign-in methods").locator("xpath=..").locator("img");
}

/** True once an <img> has loaded a real picture. */
async function loaded(page: Page, selector: ReturnType<Page["locator"]>) {
  await expect.poll(() => selector.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
}

const faces = (page: Page) => page.getByRole("list", { name: "Generated avatars" }).getByRole("button", { name: "Use this avatar" });
const faceSources = (page: Page) => faces(page).locator("img").evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src") ?? ""));

test("Personal details is the first page under Your account, above Security", async ({ page }) => {
  await openPage(page);
  const links = page.getByRole("navigation", { name: "Settings" }).getByRole("link");
  const names = await links.allTextContents();
  // Your account: Personal details, Security, then Preferences (0.2.5).
  expect(names.slice(-3)).toEqual(["Personal details", "Security", "Preferences"]);
  // Security keeps the sign-in methods; the profile moved here.
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Security" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Password" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Profile" })).toHaveCount(0);
  // The sidebar chip leads here.
  await page.getByTitle("Your personal details and sign-in methods").click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
});

test("the name saves, and a taken email shows under the field", async ({ page }) => {
  const state = await openPage(page);
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue("Dana Levi");
  await name.fill("Dana L.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  expect(state.calls.filter((c) => c.op === "auth.updateProfile").map((c) => c.input)).toEqual([{ name: "Dana L." }]);
  // The sidebar follows.
  await expect(page.getByTitle("Your personal details and sign-in methods")).toContainText("Dana L.");

  const email = page.getByLabel("Email", { exact: true });
  await email.fill("lee@acme.dev");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Another account already uses this email." })).toBeVisible();
  await email.fill("dana.levi@acme.dev");
  await expect(page.getByText("Another account already uses this email.")).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Email changed", { exact: true }).first()).toBeVisible();
  await expect(email).toHaveValue("dana.levi@acme.dev");
});

test("generated faces: Randomize, another style, pick one; the sidebar chip follows", async ({ page }) => {
  const state = await openPage(page);
  const preview = page.getByRole("img", { name: "Your avatar" });
  await expect(preview).toHaveAttribute("src", face("notionists", "dana"));
  await loaded(page, preview);
  await expect(chipImage(page)).toHaveAttribute("src", face("notionists", "dana"));

  // Six faces of the style in use, the current one first and marked.
  await expect(faces(page)).toHaveCount(6);
  await expect(faces(page).first()).toHaveAttribute("aria-pressed", "true");
  const first = await faceSources(page);
  expect(first[0]).toBe(face("notionists", "dana"));
  for (const src of first) expect(src).toMatch(/^\/api\/avatars\/notionists\/[a-z0-9]+\.svg$/);
  for (const img of await faces(page).locator("img").all()) await loaded(page, img);

  await page.getByRole("button", { name: "Randomize" }).click();
  const rolled = await faceSources(page);
  expect(rolled).toHaveLength(6);
  expect(rolled.filter((src) => first.includes(src))).toEqual([]);
  await expect(page.getByRole("list", { name: "Generated avatars" }).locator('[aria-pressed="true"]')).toHaveCount(0);

  await page.getByRole("combobox", { name: "Style" }).click();
  await page.getByRole("option", { name: "Lorelei" }).click();
  // The open list hides the rest of the page from the accessibility tree until it has closed.
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(faces(page)).toHaveCount(6);
  const lorelei = await faceSources(page);
  expect(lorelei).toHaveLength(6);
  for (const src of lorelei) expect(src).toMatch(/^\/api\/avatars\/lorelei\/[a-z0-9]+\.svg$/);
  // The credit names the style's artwork and license.
  await expect(page.getByText(/by Lisa Wischofsky, CC0 1\.0\. Drawn by the panel with DiceBear\./)).toBeVisible();

  await faces(page).nth(2).click();
  const seed = /lorelei\/([a-z0-9]+)\.svg/.exec(lorelei[2] as string)?.[1];
  await expect(page.getByText("Avatar updated").first()).toBeVisible();
  expect(state.calls.filter((c) => c.op === "avatars.setPreset").map((c) => c.input)).toEqual([{ style: "lorelei", seed }]);
  await expect(preview).toHaveAttribute("src", lorelei[2] as string);
  await expect(faces(page).nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(chipImage(page)).toHaveAttribute("src", lorelei[2] as string);
  await loaded(page, chipImage(page));
});

test("an uploaded image is cropped to a 256 px square in the browser, shows, and can be removed", async ({ page }) => {
  const state = await openPage(page);
  // A 320 x 200 PNG made by the browser, so the crop has something to cut.
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(0, 0, 320, 200);
    ctx.fillStyle = "#f59e0b";
    ctx.fillRect(110, 50, 100, 100);
    return canvas.toDataURL("image/png").split(",")[1] as string;
  });
  const picker = page.locator('input[type="file"]');

  // Not an image the panel takes: refused in the browser, nothing uploaded.
  await picker.setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
  await expect(page.getByText("Pick a PNG, JPEG or WebP image.").first()).toBeVisible();
  expect(state.calls.filter((c) => c.op === "avatars.upload")).toEqual([]);

  await picker.setInputFiles({ name: "me.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.getByText("Avatar updated").first()).toBeVisible();
  const sent = state.calls.find((c) => c.op === "avatars.upload")?.input.dataUrl as string;
  expect(sent).toMatch(/^data:image\/(webp|png);base64,/);
  const size = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, sent);
  expect(size).toEqual([256, 256]);

  const preview = page.getByRole("img", { name: "Your avatar" });
  await expect(preview).toHaveAttribute("src", /^\/api\/avatars\/user\/user000000000001\?v=/);
  await loaded(page, preview);
  await expect(chipImage(page)).toHaveAttribute("src", /^\/api\/avatars\/user\//);
  // No face is marked while the upload shows.
  await expect(page.getByRole("list", { name: "Generated avatars" }).locator('[aria-pressed="true"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Remove image" }).click();
  await expect(page.getByText("Image removed. Your generated avatar is back.").first()).toBeVisible();
  await expect(preview).toHaveAttribute("src", face("notionists", "dana"));
  await expect(page.getByRole("button", { name: "Remove image" })).toHaveCount(0);
  await expect(chipImage(page)).toHaveAttribute("src", face("notionists", "dana"));
});

for (const mode of ["light", "dark"] as const) {
  const preset = mode === "light" ? "seylo" : "seylo-dark";
  test(`screenshots in ${preset}`, async ({ page }) => {
    mkdirSync(shots, { recursive: true });
    await openPage(page, { preset: "seylo", mode });
    await loaded(page, page.getByRole("img", { name: "Your avatar" }));
    for (const img of await faces(page).locator("img").all()) await loaded(page, img);
    await loaded(page, chipImage(page));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shots}/page-${preset}.png`, fullPage: true });
    await page.getByRole("navigation", { name: "Main" }).screenshot({ path: `${shots}/sidebar-${preset}.png` });
    // People and Activity show the avatars too.
    await page.goto("/settings/people");
    await expect(page.getByRole("table").first()).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${shots}/people-${preset}.png` });
    await page.goto("/activity");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${shots}/activity-${preset}.png` });
  });
}
