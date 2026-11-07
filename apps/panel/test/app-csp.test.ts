// The web app's pages carry a Content-Security-Policy that only runs the
// panel's own scripts: the one inline script (the theme resolver) is allowed
// by its hash, never by 'unsafe-inline', so an injected <script> or event
// handler would not run.

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testPanel } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directives(header: string | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of (header ?? "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

test("the app shell restricts scripts to the panel's files and the hashed theme script", async () => {
  const dist = mkdtempSync(join(tmpdir(), "web-dist-"));
  dirs.push(dist);
  writeFileSync(
    join(dist, "index.html"),
    '<!doctype html><html><head><title>x</title></head><body><script type="module" src="/assets/app.js"></script></body></html>',
  );
  const panel = testPanel({ webDist: dist });
  try {
    const page = await panel.app.handle(new Request("http://203.0.113.5:3000/", { headers: { host: "203.0.113.5:3000" } }));
    const csp = directives(page.headers.get("content-security-policy"));
    const scripts = csp.get("script-src") ?? [];
    expect(scripts).toContain("'self'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("connect-src")).toEqual(["'self'"]);

    // Every inline script that runs is allowed by its hash; the boot JSON is data and never runs.
    const html = await page.text();
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter(
      ([, attrs]) => !/type="application\/json"/.test(attrs ?? ""),
    );
    expect(inline.length).toBe(1);
    for (const [, , body] of inline) {
      expect(scripts).toContain(
        `'sha256-${createHash("sha256")
          .update(body ?? "")
          .digest("base64")}'`,
      );
    }
  } finally {
    panel.close();
  }
});
