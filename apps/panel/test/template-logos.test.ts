// Template logos: a catalog template that has its app's logo (logo.svg,
// .webp or .png in the catalog) lists a URL the panel serves from the
// catalog in memory, with ?v= from the file's sha256; every other template,
// custom ones included, lists null and the web shows its letter tile. The
// catalog is the fixture repository (flows: logo.svg, board: logo.webp,
// metrics: none); the logo rules (size, safe SVG, NOTICE) are
// scripts/check-templates.ts's.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { templates } from "@seylo/ops";
import { fixtureRepo, resetCatalogs, useFixtureBundle } from "./catalog-fakes";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeAll(() => useFixtureBundle());
afterAll(resetCatalogs);
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

const get = (path: string) => panel.app.handle(new Request(`http://localhost${path}`));
const fixture = (path: string) => readFileSync(join(fixtureRepo, "templates", path));
const v = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 8);

test("templates with a logo list its URL and the panel serves the file", async () => {
  const { cookie } = await createUser(panel, "owner");
  const list = await callOp(panel, templates.list, {}, { cookie });
  expect(list.status).toBe(200);
  const bySlug = new Map((list.body.templates as { slug: string; logoUrl: string | null }[]).map((t) => [t.slug, t.logoUrl]));
  const svgUrl = `/api/templates/flows/logo.svg?v=${v(fixture("flows/logo.svg"))}`;
  expect(bySlug.get("flows")).toBe(svgUrl);
  // A raster logo when the app has no small SVG.
  expect(bySlug.get("board")).toBe(`/api/templates/board/logo.webp?v=${v(fixture("board/logo.webp"))}`);
  // No logo: the web shows the letter tile.
  expect(bySlug.get("metrics")).toBeNull();
  // templates.get carries the same URL.
  expect((await callOp(panel, templates.get, { slug: "flows" }, { cookie })).body.logoUrl).toBe(svgUrl);

  // Public (an <img> sends no credentials), typed, cached, and sandboxed if opened directly; the ?v= query is ignored.
  const svg = await get(svgUrl);
  expect(svg.status).toBe(200);
  expect(svg.headers.get("content-type")).toStartWith("image/svg+xml");
  expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  expect(svg.headers.get("content-security-policy")).toContain("sandbox");
  expect(svg.headers.get("cache-control")).toContain("max-age");
  expect(await svg.text()).toBe(fixture("flows/logo.svg").toString("utf8"));
  const webp = await get("/api/templates/board/logo.webp");
  expect(webp.status).toBe(200);
  expect(webp.headers.get("content-type")).toBe("image/webp");
  expect(Buffer.from(await webp.arrayBuffer()).equals(fixture("board/logo.webp"))).toBe(true);
});

test("only the file a template has is served", async () => {
  for (const path of [
    "/api/templates/metrics/logo.svg", // no logo
    "/api/templates/board/logo.svg", // has logo.webp
    "/api/templates/flows/logo.png",
    "/api/templates/flows/meta.yaml",
    "/api/templates/flows/index.ts",
    "/api/templates/no-such-template/logo.svg",
    "/api/templates/..%2Fflows/logo.svg",
  ])
    expect({ path, status: (await get(path)).status }).toEqual({ path, status: 404 });
});

test("a changed logo gets a new URL", async () => {
  const { cookie } = await createUser(panel, "owner");
  const before = (await callOp(panel, templates.get, { slug: "flows" }, { cookie })).body.logoUrl;
  panel.close();
  useFixtureBundle({ add: {}, edit: (json) => changeLogo(json) });
  panel = testPanel();
  const { cookie: again } = await createUser(panel, "owner");
  const after = (await callOp(panel, templates.get, { slug: "flows" }, { cookie: again })).body.logoUrl as string;
  expect(after).toStartWith("/api/templates/flows/logo.svg?v=");
  expect(after).not.toBe(before);
  expect(await (await get(after)).text()).toContain("#123456");
  useFixtureBundle();
});

function changeLogo(json: Record<string, unknown>) {
  const flows = (json.templates as { slug: string; files: Record<string, { sha256: string; base64?: string }> }[]).find(
    (t) => t.slug === "flows",
  );
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4" fill="#123456"/></svg>\n');
  if (flows) flows.files["logo.svg"] = { sha256: new Bun.CryptoHasher("sha256").update(svg).digest("hex"), base64: svg.toString("base64") };
}

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
