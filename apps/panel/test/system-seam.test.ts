// System seam: system ops, the settings.boot payload, theme injection into
// index.html, and permission checks on service-scoped ops.

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayName } from "@seylo/brand";
import { cron, settings, system } from "@seylo/ops";
import { appContentSecurityPolicy, injectBoot, readBoot } from "../src/modules/settings/boot";
import type { StoredAppearance } from "../src/modules/settings/keys";
import { setSetting } from "../src/settings";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel | undefined;
afterEach(() => panel?.close());

const indexHtml =
  '<!doctype html><html lang="en"><head><meta charset="utf-8" /><link rel="icon" href="/favicon.svg" type="image/svg+xml" /><title>Panel</title><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>';

function webDist() {
  const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), indexHtml);
  return dir;
}

test("system.version and system.features answer for signed-in people", async () => {
  panel = testPanel();
  const { cookie } = await createUser(panel, "member");
  const version = await callOp(panel, system.version, {}, { cookie });
  expect(version.status).toBe(200);
  expect(version.body).toMatchObject({ version: "dev", protocol: "v1" });

  const features = await callOp(panel, system.features, {}, { cookie });
  expect(features.status).toBe(200);
  expect(features.body.passkeys.enabled).toBe(false);
  expect(features.body.ai).toEqual({ enabled: false, reason: expect.any(String) });
  expect(features.body.notifications.enabled).toBe(false);
});

test("settings.boot is public and has defaults on a fresh panel", async () => {
  panel = testPanel();
  const boot = await callOp(panel, settings.boot, {});
  expect(boot.status).toBe(200);
  expect(boot.body).toMatchObject({
    name: displayName,
    productName: displayName,
    preset: "seylo",
    colorMode: "system",
    accent: null,
    customCss: "",
    favicon: null,
  });
  expect(boot.body.revision).toMatch(/^[0-9a-f]{16}$/);
});

test("system.info uses the white-label name", async () => {
  panel = testPanel();
  setSetting(panel.deps.db, "panelName", "Acme Cloud");
  const { cookie } = await createUser(panel, "owner");
  expect((await callOp(panel, system.info, {}, { cookie })).body.name).toBe("Acme Cloud");
});

test("index.html carries the theme, name, accent and custom CSS before the app loads", async () => {
  panel = testPanel({ webDist: webDist() });
  setSetting(panel.deps.db, "panelName", "Acme <Cloud>");
  setSetting(panel.deps.db, "appearance", {
    preset: "classic",
    colorMode: "light",
    accent: "#0F8A6A",
    customCss: "a{color:red}</style><script>x</script>",
  });
  setSetting(panel.deps.db, "branding", {
    loginMessage: "",
    hidePoweredBy: true,
    assets: { favicon: { hash: "ab".repeat(32), contentType: "image/png" } },
  });

  const html = await (await panel.app.handle(new Request("http://panel.test/p/x"))).text();
  expect(html).toContain('<html lang="en" data-theme="classic" data-color-mode="light">');
  expect(html).toContain('<style id="panel-accent">:root{--primary:#0F8A6A;');
  expect(html).toContain("<title>Acme &lt;Cloud&gt;</title>");
  expect(html).toContain(`<link rel="icon" href="/branding/favicon?v=${"ab".repeat(8)}" />`);
  // Custom CSS cannot close its <style> element.
  expect(html).not.toContain("</style><script>x");
  // Styles come after the app stylesheet; the charset meta stays first.
  expect(html.indexOf('id="panel-custom-css"')).toBeGreaterThan(html.indexOf("/assets/app.css"));
  expect(html.indexOf("<meta charset")).toBeLessThan(html.indexOf('id="panel-boot"'));

  const json = html.match(/<script type="application\/json" id="panel-boot">(.*?)<\/script>/)?.[1];
  expect(JSON.parse(json ?? "null")).toEqual(readBoot(panel.deps.db));
});

test("system mode leaves light or dark to the inline script, which runs before the body paints", () => {
  panel = testPanel();
  const html = injectBoot(indexHtml, readBoot(panel.deps.db));
  // The preset is in the markup; no dark class from the server, so a dark device is not forced light or dark here.
  expect(html).toContain('<html lang="en" data-theme="seylo" data-color-mode="system">');
  const script = html.match(/<script>(.*?)<\/script>/)?.[1] ?? "";
  expect(html.indexOf(script)).toBeLessThan(html.indexOf("<body>"));
  expect(appContentSecurityPolicy).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`);

  // The script on a dark device, then on a light one: the dark class follows prefers-color-scheme.
  for (const prefersDark of [true, false]) {
    const classes = new Set<string>(["stale"]);
    const root = {
      getAttribute: (name: string) => (name === "data-color-mode" ? "system" : null),
      classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
    };
    new Function("document", "matchMedia", script)({ documentElement: root }, () => ({ matches: prefersDark }));
    expect(classes.has("dark")).toBe(prefersDark);
  }
});

test("an explicit mode is in the markup: dark gets the class, light none, other classes stay", () => {
  panel = testPanel();
  const boot = readBoot(panel.deps.db);
  const dark = injectBoot('<html lang="en" class="dark js">', { ...boot, preset: "clay", colorMode: "dark" });
  expect(dark).toBe('<html lang="en" data-theme="clay" data-color-mode="dark" class="js dark">');
  const light = injectBoot('<html lang="en" class="dark js">', { ...boot, preset: "clay", colorMode: "light" });
  expect(light).toBe('<html lang="en" data-theme="clay" data-color-mode="light" class="js">');
  const plain = injectBoot('<html lang="en" class="dark">', { ...boot, colorMode: "light" });
  expect(plain).toBe('<html lang="en" data-theme="seylo" data-color-mode="light">');
});

test("appearance saved before presets had two halves keeps how it looked", async () => {
  const fresh = testPanel();
  panel = fresh;
  const { db } = fresh.deps;
  const read = (stored: StoredAppearance) => {
    setSetting(db, "appearance", stored);
    const boot = readBoot(db);
    return { preset: boot.preset, colorMode: boot.colorMode };
  };
  const old = { accent: null, customCss: "" };
  // "seylo-night" was the dark half of the default; the mode decided between the halves as it does now.
  expect(read({ ...old, preset: "seylo-night", colorMode: "system" })).toEqual({ preset: "seylo", colorMode: "system" });
  expect(read({ ...old, preset: "seylo-night", colorMode: "dark" })).toEqual({ preset: "seylo", colorMode: "dark" });
  // Midnight was dark and Classic light whatever the mode said.
  expect(read({ ...old, preset: "midnight", colorMode: "system" })).toEqual({ preset: "midnight", colorMode: "dark" });
  expect(read({ ...old, preset: "midnight", colorMode: "light" })).toEqual({ preset: "midnight", colorMode: "dark" });
  expect(read({ ...old, preset: "classic", colorMode: "system" })).toEqual({ preset: "classic", colorMode: "light" });
  // Rows saved since then mean what they say.
  expect(read({ ...old, preset: "midnight", colorMode: "system", themeVersion: 2 })).toEqual({ preset: "midnight", colorMode: "system" });
  expect(read({ ...old, preset: "classic", colorMode: "dark", themeVersion: 2 })).toEqual({ preset: "classic", colorMode: "dark" });
});

test("user text with replacement patterns is inserted literally", () => {
  panel = testPanel();
  setSetting(panel.deps.db, "panelName", "$& $' cash");
  const html = injectBoot(indexHtml, readBoot(panel.deps.db));
  expect(html).toContain("<title>$&amp; $' cash</title>");
});

test("service-scoped ops check the permission before anything else", async () => {
  panel = testPanel();
  const member = await createUser(panel, "member");
  const forbidden = await callOp(panel, cron.list, { serviceId: "a".repeat(16) }, { cookie: member.cookie });
  expect(forbidden.status).toBe(403);
});
