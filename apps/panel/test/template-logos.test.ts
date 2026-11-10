// Template logos: a built-in template that ships its app's logo
// (templates/<slug>/logo.svg, .webp or .png, from dashboard-icons) lists a
// URL the panel serves; every other template, custom ones included, lists
// null and the web shows its letter tile.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { templates } from "@seylo/ops";
import { builtInTemplates, catalogDir, logoFiles } from "../src/modules/templates/catalog";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

/** Small enough for a 38 px tile: SVGs up to 50 KB, rasters up to 30 KB. */
const maxBytes = (file: string) => (file.endsWith(".svg") ? 50_000 : 30_000);

const get = (path: string) => panel.app.handle(new Request(`http://localhost${path}`));

test("every logo file in the catalog is small, safe and listed in templates/NOTICE", () => {
  const dir = catalogDir() as string;
  const notice = readFileSync(join(dir, "NOTICE"), "utf8");
  expect(notice).toContain("Apache License");
  expect(existsSync(join(dir, "LICENSE.dashboard-icons"))).toBe(true);
  let count = 0;
  for (const slug of readdirSync(dir)) {
    for (const file of logoFiles) {
      const path = join(dir, slug, file);
      if (!existsSync(path)) continue;
      count++;
      expect({ path, size: statSync(path).size <= maxBytes(file) }).toEqual({ path, size: true });
      expect(notice).toContain(`templates/${slug}/${file}`);
      if (file !== "logo.svg") continue;
      // Shown through <img> (no scripts run there), but opened directly an SVG is a document: nothing active or remote in it.
      const svg = readFileSync(path, "utf8");
      expect(svg).toContain("<svg");
      expect(svg).not.toMatch(/<script|<foreignObject|<image|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']?(?:https?:|data:|javascript:)/i);
    }
  }
  expect(count).toBeGreaterThanOrEqual(20);
});

test("templates with a logo list its URL and the panel serves the file", async () => {
  const { cookie } = await createUser(panel, "owner");
  const list = await callOp(panel, templates.list, {}, { cookie });
  expect(list.status).toBe(200);
  const all = list.body.templates as { slug: string; name: string; logoUrl: string | null }[];
  const bySlug = new Map(all.map((t) => [t.slug, t]));
  for (const [slug, template] of builtInTemplates()) {
    const file = template.logoPath?.split("/").pop();
    expect(bySlug.get(slug)?.logoUrl).toBe(file ? `/api/templates/${slug}/${file}` : null);
  }
  expect(bySlug.get("grafana")?.logoUrl).toBe("/api/templates/grafana/logo.svg");
  expect(bySlug.get("uptime-kuma")?.logoUrl).toBe("/api/templates/uptime-kuma/logo.svg");
  // No SVG upstream: a small WebP instead.
  expect(bySlug.get("ghost")?.logoUrl).toBe("/api/templates/ghost/logo.webp");
  // dashboard-icons has no Appsmith logo: the web shows the letter tile.
  expect(bySlug.get("appsmith")?.logoUrl).toBeNull();
  // templates.get carries the same URL.
  expect((await callOp(panel, templates.get, { slug: "grafana" }, { cookie })).body.logoUrl).toBe("/api/templates/grafana/logo.svg");

  // Public (an <img> sends no credentials), typed, cached, and sandboxed if opened directly.
  const svg = await get("/api/templates/grafana/logo.svg");
  expect(svg.status).toBe(200);
  expect(svg.headers.get("content-type")).toStartWith("image/svg+xml");
  expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  expect(svg.headers.get("content-security-policy")).toContain("sandbox");
  expect(svg.headers.get("cache-control")).toContain("max-age");
  expect(await svg.text()).toBe(readFileSync(join(catalogDir() as string, "grafana", "logo.svg"), "utf8"));
  const webp = await get("/api/templates/ghost/logo.webp");
  expect(webp.status).toBe(200);
  expect(webp.headers.get("content-type")).toBe("image/webp");
  const bytes = Buffer.from(await webp.arrayBuffer());
  expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
});

test("only the file a template ships is served", async () => {
  for (const path of [
    "/api/templates/appsmith/logo.svg", // no logo
    "/api/templates/ghost/logo.svg", // ships logo.webp
    "/api/templates/grafana/logo.png",
    "/api/templates/grafana/meta.yaml",
    "/api/templates/grafana/index.ts",
    "/api/templates/no-such-template/logo.svg",
    "/api/templates/..%2Fgrafana/logo.svg",
  ])
    expect({ path, status: (await get(path)).status }).toEqual({ path, status: 404 });
});

test("custom templates have no logo", async () => {
  const { cookie } = await createUser(panel, "owner");
  const meta = 'name: "Hello"\ndescription: "A test."\n';
  const source = `export function generate(input: { serviceName: string }) {
  return { services: [{ type: "app", data: { serviceName: input.serviceName, source: { type: "image", image: "nginx:1.27" } } }] };
}`;
  const saved = await callOp(panel, templates.saveCustom, { slug: "hello", metaYaml: meta, source }, { cookie });
  expect(saved.status).toBe(200);
  expect(saved.body.logoUrl).toBeNull();
  const list = await callOp(panel, templates.list, { query: "hello" }, { cookie });
  expect(list.body.templates.find((t: { slug: string }) => t.slug === "hello")?.logoUrl).toBeNull();
  expect((await get("/api/templates/hello/logo.svg")).status).toBe(404);
});
