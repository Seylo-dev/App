// scripts/check-templates.ts, the check the Templates repository runs on
// every pull request and before it publishes a catalog: a copy of the
// fixture repository with one problem at a time, the command line's
// output and exit code, and the catalog --emit writes.

import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkTemplates, formatProblems, readRepo } from "../scripts/check-templates";
import { parseCatalogFile } from "../src/modules/templates/catalog-file";
import { fixtureRepo } from "./catalog-fakes";

const script = resolve(import.meta.dir, "../scripts/check-templates.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture repository to break. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "templates-repo-"));
  dirs.push(dir);
  cpSync(fixtureRepo, dir, { recursive: true });
  return dir;
}
const edit = (dir: string, file: string, change: (text: string) => string) =>
  writeFileSync(join(dir, file), change(readFileSync(join(dir, file), "utf8")));

async function problems(dir: string, options: Parameters<typeof checkTemplates>[1] = {}) {
  const result = await checkTemplates(readRepo(dir), options);
  return formatProblems(result.problems);
}

function cli(...args: string[]) {
  const run = Bun.spawnSync(["bun", script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GITHUB_ACTIONS: "true" } });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

describe("check-templates", () => {
  test("the fixture repository passes", async () => {
    expect(await problems(fixtureRepo)).toEqual([]);
  });

  test("meta.yaml: unknown keys, a long description, http links, a moving image tag and a new category", async () => {
    const dir = repo();
    edit(dir, "templates/flows/meta.yaml", (t) =>
      t
        .replace(
          'description: "Test template: an app and its Postgres database, wired with references."',
          `description: "${"x".repeat(141)}"`,
        )
        .replace('creates: "App + Postgres"', 'creates: "App + Postgres"\nauthor: "someone"'),
    );
    edit(dir, "templates/metrics/meta.yaml", (t) =>
      t.replace('default: "example/metrics:3.1.0"', 'default: "example/metrics:latest"').replace('"Monitoring"', '"Observability"'),
    );
    edit(dir, "templates/board/meta.yaml", (t) =>
      t.replace('category: "Productivity"', 'category: "Productivity"\nlinks:\n  - label: "Site"\n    url: "http://example.com"'),
    );
    const out = await problems(dir);
    expect(out).toContain("templates/flows/meta.yaml: /author: Unexpected property");
    expect(out.some((l) => l.startsWith("templates/flows/meta.yaml: /description: Expected string length less or equal to 140"))).toBe(
      true,
    );
    expect(out).toContain(
      'templates/metrics/meta.yaml: image: example/metrics:latest uses the moving tag "latest". Pin a version, or pin the digest (image:latest@sha256:...).',
    );
    expect(out.some((l) => l.startsWith('warning: templates/metrics/meta.yaml: "Observability" is a new category'))).toBe(true);
    expect(out.some((l) => l.startsWith("templates/board/meta.yaml: /links/0/url:"))).toBe(true);
  });

  test("index.ts: it must run, name its services after the service name, and install", async () => {
    const dir = repo();
    edit(dir, "templates/metrics/index.ts", (t) => t.replace("serviceName: input.serviceName,", 'serviceName: "metrics",'));
    edit(dir, "templates/board/index.ts", () => "export function generate() { return { services: [] }; }\n");
    // A custom domain must be a host name, as domains.add takes it (installing adds it through domains.add's code).
    edit(dir, "templates/flows/index.ts", (t) =>
      t.replace(
        "domains: [{ host: PRIMARY_DOMAIN, port: 5678 }]",
        'domains: [{ host: "a.example.com`) || Host(`b.example.com", port: 5678 }]',
      ),
    );
    // Runs and validates, but asks for a Postgres the panel does not offer: only installing finds it.
    cpSync(join(dir, "templates/metrics"), join(dir, "templates/old-db"), { recursive: true });
    writeFileSync(
      join(dir, "templates/old-db/index.ts"),
      readFileSync(join(fixtureRepo, "templates/flows/index.ts"), "utf8").replace('version: "16"', 'version: "3"'),
    );
    const out = await problems(dir);
    expect(out.some((l) => l.startsWith("templates/metrics/index.ts: Service metrics does not start with the service name"))).toBe(true);
    expect(out.some((l) => l.startsWith("templates/board/index.ts: generate() returned an invalid result at /services"))).toBe(true);
    expect(
      out.some((l) => l.startsWith("templates/flows/index.ts: generate() returned an invalid result at /services/1/data/domains/0/host")),
    ).toBe(true);
    expect(out).toContain("templates/old-db/index.ts: Installing failed: PostgreSQL 3 is not offered. Pick one of 18, 17, 16, 15.");
  });

  test("logos: size, file type, active SVG content and a NOTICE line; NOTICE lines for missing files", async () => {
    const dir = repo();
    writeFileSync(join(dir, "templates/flows/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>\n');
    writeFileSync(join(dir, "templates/board/logo.webp"), "not a webp");
    writeFileSync(
      join(dir, "templates/metrics/logo.png"),
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(31_000)]),
    );
    edit(dir, "NOTICE", (t) => `${t}  templates/gone/logo.svg             removed\n`);
    const out = await problems(dir);
    expect(out).toContain(
      "templates/flows/logo.svg: Has a script, an event handler, a foreignObject, an embedded image or an external link.",
    );
    expect(out).toContain("templates/board/logo.webp: Not a WebP file.");
    expect(out).toContain("templates/metrics/logo.png: 31008 bytes; keep a raster under 30 KB.");
    expect(out).toContain("templates/metrics/logo.png: Add a line for templates/metrics/logo.png to NOTICE: where the logo comes from.");
    expect(out).toContain("NOTICE: Lists templates/gone/logo.svg, which does not exist.");
  });

  test("folders: slug, stray files, two logos; the editor types must match the sandbox's", async () => {
    const dir = repo();
    cpSync(join(dir, "templates/metrics"), join(dir, "templates/Bad_Slug"), { recursive: true });
    writeFileSync(join(dir, "templates/flows/README.md"), "hi\n");
    writeFileSync(join(dir, "templates/board/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
    edit(dir, "types/templates-utils.d.ts", (t) => t.replace("  export const PRIMARY_DOMAIN: string;\n", ""));
    const out = await problems(dir);
    expect(out.some((l) => l.startsWith("templates/Bad_Slug/: The folder name is the slug"))).toBe(true);
    expect(out.some((l) => l.startsWith("templates/flows/README.md: Not a template file."))).toBe(true);
    expect(out).toContain("templates/board/logo.webp: Keep one logo, not logo.svg and logo.webp.");
    expect(
      out.some((l) =>
        l.startsWith("types/templates-utils.d.ts: Declares env, randomBase64, randomHex, randomPassword, randomString, ref;"),
      ),
    ).toBe(true);
  });

  test("minPanel: above panel.json's check fails; --skip-newer-than leaves newer templates out", async () => {
    const dir = repo();
    edit(dir, "templates/metrics/meta.yaml", (t) => t.replace('creates: "App"', 'creates: "App"\nminPanel: "0.3.0"'));
    expect(await problems(dir)).toContain(
      "templates/metrics/meta.yaml: minPanel 0.3.0 is newer than the panel this repository checks against (v0.2.17 in panel.json).",
    );
    edit(dir, "panel.json", () => '{ "check": "v0.3.0", "oldest": "v0.2.17" }\n');
    expect(await problems(dir)).toEqual([]);
    const oldest = await checkTemplates(readRepo(dir), { skipNewerThan: "v0.2.17" });
    expect(oldest.skipped).toEqual(["metrics"]);
    expect(oldest.passed.map((c) => c.slug).sort()).toEqual(["board", "flows"]);
  });

  test("the run against panel.json's oldest: newer templates are left out before their meta.yaml is read, and the d.ts is not compared", async () => {
    const dir = repo();
    edit(dir, "panel.json", () => '{ "check": "v0.3.0", "oldest": "v0.2.17" }\n');
    // Say 0.3.0 reads links written as one URL and adds a util; the d.ts follows it (panel.json's check), not 0.2.17.
    edit(dir, "templates/metrics/meta.yaml", (t) =>
      t
        .replace('creates: "App"', 'creates: "App"\nminPanel: "0.3.0"')
        .replace(/links:\n( {4}.*\n| {2}- .*\n)+/, 'links: "https://docs.example.com/metrics"\n'),
    );
    edit(dir, "types/templates-utils.d.ts", (t) =>
      t.replace("  export const PRIMARY_DOMAIN", "  export function slugify(text: string): string;\n  export const PRIMARY_DOMAIN"),
    );
    const oldest = await checkTemplates(readRepo(dir), { skipNewerThan: "v0.2.17" });
    expect(formatProblems(oldest.problems)).toEqual([]);
    expect(oldest.skipped).toEqual(["metrics"]);
    // This panel is not 0.3.0: run as the check, both are problems.
    const out = await problems(dir);
    expect(out).toContain("templates/metrics/meta.yaml: links must be a list.");
    expect(out.some((l) => l.startsWith("types/templates-utils.d.ts: Declares") && l.includes("slugify"))).toBe(true);
  });

  test("the command line: one line per problem with GitHub annotations, exit 1; --only; --emit writes a catalog the panel reads", () => {
    const dir = repo();
    edit(dir, "templates/metrics/meta.yaml", (t) => t.replace('default: "example/metrics:3.1.0"', 'default: "example/metrics"'));
    const bad = cli("--dir", dir);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("::error file=templates/metrics/meta.yaml::image: example/metrics has no tag. Pin a version (or a digest).");
    expect(bad.out).toContain("templates/metrics/meta.yaml: image: example/metrics has no tag. Pin a version (or a digest).");
    expect(bad.out).toContain("check-templates: 3 checked, 2 passed, 1 error");
    expect(cli("--dir", dir, "--only", "flows").code).toBe(0);
    expect(cli("--dir", dir, "--only", "flows", "--emit", join(dir, "x.json")).code).toBe(2);

    const out = join(dir, "catalog.json");
    expect(cli("--dir", dir, "--emit", out, "--commit", "c".repeat(40), "--sequence", "42").code).toBe(1);
    const good = repo();
    const emitted = cli(
      "--dir",
      good,
      "--emit",
      out,
      "--commit",
      "c".repeat(40),
      "--sequence",
      "42",
      "--generated-at",
      "2026-11-14T10:00:00.000Z",
    );
    expect(emitted.code).toBe(0);
    const text = readFileSync(out, "utf8");
    const catalog = parseCatalogFile(new TextEncoder().encode(text));
    expect(catalog).toMatchObject({ format: 1, source: "Seylo-dev/Templates", commit: "c".repeat(40), sequence: 42 });
    expect(catalog.templates.map((t) => [t.slug, t.name, t.category, [...t.files.keys()].sort()])).toEqual([
      ["board", "Board", "Productivity", ["index.ts", "logo.webp", "meta.yaml"]],
      ["flows", "Flows", "Automation", ["index.ts", "logo.svg", "meta.yaml"]],
      ["metrics", "Metrics", "Monitoring", ["index.ts", "meta.yaml"]],
    ]);
    expect(Object.keys(catalog.licenses)).toEqual(["LICENSE.fixture"]);
    // Two builds of one commit are the same file.
    cli("--dir", good, "--emit", `${out}.2`, "--commit", "c".repeat(40), "--sequence", "42", "--generated-at", "2026-11-14T10:00:00.000Z");
    expect(readFileSync(`${out}.2`, "utf8")).toBe(text);
    // And the built catalog passes the check too (what sync-templates runs).
    expect(cli("--catalog", out).code).toBe(0);
  }, 60_000);
});
