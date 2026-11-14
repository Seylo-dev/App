// scripts/sync-templates.ts (`make sync-templates`, a release step): until
// the Templates repo publishes its first catalog GitHub answers 404, and the
// script keeps templates/ as committed, says so and does not fail, so it
// never blocks a release while nothing is published. Any other failure, a
// 404 for the signature alone included, fails and writes nothing. A fork
// without the catalog key downloads nothing.

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { minisignPublicKey } from "@seylo/brand";
import { SyncError, type SyncOptions, syncTemplates } from "../../../scripts/sync-templates";
import { catalogDir } from "../src/modules/templates/catalog";

const root = resolve(import.meta.dir, "../../..");
const url = "https://github.com/Seylo-dev/Templates/releases/download/catalog/catalog.json";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of templates/ to run on, and what it holds. */
function vendored() {
  const dir = mkdtempSync(join(tmpdir(), "sync-templates-"));
  dirs.push(dir);
  cpSync(catalogDir() as string, dir, { recursive: true });
  return { dir, snapshot: () => readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]) };
}

/** Answers `files` by URL (a status, a Response maker, or a thrown error), recording what was asked. */
function serve(files: Record<string, number | (() => Response) | Error>) {
  const fetched: string[] = [];
  const fetch = async (requested: string) => {
    fetched.push(requested);
    const answer = files[requested] ?? 404;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer();
    return new Response(answer === 200 ? "{}" : "Not Found", { status: answer });
  };
  return { fetch, fetched };
}

function run(dir: string, fetch: SyncOptions["fetch"], publicKey = minisignPublicKey) {
  const lines: string[] = [];
  const result = syncTemplates({ dir, publicKey, url, fetch, log: (line) => lines.push(line), warn: (line) => lines.push(line) });
  return { result, lines };
}

test("not published yet (404 for catalog.json): templates/ stays as committed, it says so and does not fail", async () => {
  const { dir, snapshot } = vendored();
  const before = snapshot();
  const { fetch, fetched } = serve({});
  const { result, lines } = run(dir, fetch);
  expect(await result).toEqual({ written: false, reason: "not published" });
  expect(fetched).toEqual([url]);
  const said = lines.join("\n");
  expect(said).toContain(`the official catalog is not published yet (${url} answered 404)`);
  expect(said).toMatch(/templates\/catalog\.json stays as committed \(sequence \d+, unsigned\) and this release ships it/);
  expect(said).toContain("nothing was written");
  expect(snapshot()).toEqual(before);
});

test.each([
  ["a 404 for the signature alone", { [url]: 200 }, "catalog.json.minisig answered 404"],
  ["another status", { [url]: 503 }, "answered 503"],
  ["no answer", { [url]: new TypeError("network down") }, `could not reach ${url}`],
  [
    "a download that breaks off",
    { [url]: () => new Response(new ReadableStream({ pull: (c) => c.error(new TypeError("socket closed")) })) },
    `the download of ${url} broke off`,
  ],
] as const)("%s fails and writes nothing", async (_, files, message) => {
  const { dir, snapshot } = vendored();
  const before = snapshot();
  const { result } = run(dir, serve(files as Record<string, number | (() => Response) | Error>).fetch);
  const error = await result.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SyncError);
  expect((error as Error).message).toContain(message);
  expect(snapshot()).toEqual(before);
});

test("a fork without the catalog key downloads nothing and does not fail", async () => {
  const { dir, snapshot } = vendored();
  const before = snapshot();
  const { fetch, fetched } = serve({});
  const { result, lines } = run(dir, fetch, "PLACEHOLDER_TEMPLATES_MINISIGN_PUBLIC_KEY");
  expect(await result).toEqual({ written: false, reason: "no catalog key" });
  expect(fetched).toEqual([]);
  expect(lines.join("\n")).toContain("--local <catalog.json>");
  expect(snapshot()).toEqual(before);
});

test("the command line: a bad argument exits 1 with the usage", () => {
  for (const args of [["--bogus"], ["--signature", "x.minisig"]]) {
    const run = Bun.spawnSync(["bun", "scripts/sync-templates.ts", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: run.exitCode, err: run.stderr.toString() }).toMatchObject({
      exitCode: 1,
      err: expect.stringContaining("sync-templates: usage: bun scripts/sync-templates.ts"),
    });
  }
}, 60_000);
