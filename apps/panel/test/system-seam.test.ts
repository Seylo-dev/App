// System seam: system ops, the settings.boot payload, theme injection into
// index.html, and permission checks on service-scoped ops.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayName } from "@seylo/brand";
import { cron, settings, system } from "@seylo/ops";
import { injectBoot, readBoot } from "../src/modules/settings/boot";
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
  expect(html).toContain("<title>Acme &lt;Cloud&gt;</title>");
  expect(html).toContain(`<link rel="icon" href="/branding/favicon?v=${"ab".repeat(8)}" />`);
  expect(html).toContain('<style id="panel-accent">:root:root,:root:root[data-theme]{--primary:#0F8A6A;');
  // Custom CSS cannot close its <style> element.
  expect(html).not.toContain("</style><script>x");
  // Styles come after the app stylesheet; the charset meta stays first.
  expect(html.indexOf('id="panel-custom-css"')).toBeGreaterThan(html.indexOf("/assets/app.css"));
  expect(html.indexOf("<meta charset")).toBeLessThan(html.indexOf('id="panel-boot"'));

  const json = html.match(/<script type="application\/json" id="panel-boot">(.*?)<\/script>/)?.[1];
  expect(JSON.parse(json ?? "null")).toEqual(readBoot(panel.deps.db));
});

test("the default theme leaves data-theme to the inline script in system mode", () => {
  panel = testPanel();
  const html = injectBoot(indexHtml, readBoot(panel.deps.db));
  expect(html).toContain('<html lang="en" data-color-mode="system">');
  expect(html).toContain("prefers-color-scheme: dark");
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
