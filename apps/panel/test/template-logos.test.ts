// Template logos are generated monograms (no third-party marks), served by
// the panel, so every catalog entry has a logo URL that answers.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { templates } from "@seylo/ops";
import { initials, monogramSvg } from "../src/modules/templates/logo";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

test("initials and stable colors", () => {
  expect(initials("Uptime Kuma")).toBe("UK");
  expect(initials("n8n")).toBe("N8");
  expect(initials("Grafana")).toBe("GR");
  expect(initials("IT-Tools")).toBe("IT");
  expect(initials("")).toBe("?");
  expect(monogramSvg("ghost", "Ghost")).toBe(monogramSvg("ghost", "Ghost"));
  // Names are escaped: nothing in a template name becomes markup.
  const svg = monogramSvg("x", `<script>alert(1)</script> & "q"`);
  expect(svg).not.toContain("<script>");
  expect(svg).toStartWith("<svg ");
});

test("every template lists a logo URL that serves an SVG", async () => {
  const { cookie } = await createUser(panel, "owner");
  const list = await callOp(panel, templates.list, {}, { cookie });
  expect(list.status).toBe(200);
  const all = list.body.templates as { slug: string; name: string; logoUrl: string | null }[];
  expect(all.length).toBeGreaterThan(5);
  for (const t of all) expect(t.logoUrl).toBe(`/api/templates/${t.slug}/logo.svg`);
  const first = all[0] as { logoUrl: string; name: string };
  const res = await panel.app.handle(new Request(`http://localhost${first.logoUrl}`));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("image/svg+xml");
  expect(res.headers.get("content-security-policy")).toContain("sandbox");
  const body = await res.text();
  expect(body).toContain(`aria-label="${first.name}"`);
  expect((await panel.app.handle(new Request("http://localhost/api/templates/no-such-template/logo.svg"))).status).toBe(404);
});
