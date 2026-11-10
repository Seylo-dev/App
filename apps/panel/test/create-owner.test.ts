// scripts/create-owner.ts takes the owner's password from stdin (or the
// terminal), never from the command line, where shell history and the
// process list would keep it.

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slug } from "@seylo/brand";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], stdin: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "create-owner-"));
  dirs.push(dataDir);
  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "scripts", "create-owner.ts"), ...args], {
    env: { ...process.env, [`${slug.toUpperCase()}_DATA_DIR`]: dataDir },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  return { code, stderr: await new Response(child.stderr).text(), dataDir };
}

function owners(dataDir: string): string[] {
  try {
    const db = new Database(join(dataDir, "panel.db"), { readonly: true });
    const rows = db.query("select email from users where role = 'owner'").all() as { email: string }[];
    db.close();
    return rows.map((r) => r.email);
  } catch {
    return [];
  }
}

test("the password comes from stdin", async () => {
  const { code, dataDir } = await run(["Owner@Example.com"], "a long enough password\n");
  expect(code).toBe(0);
  expect(owners(dataDir)).toEqual(["owner@example.com"]);
  // The owner gets a random generated face, like every new account.
  const db = new Database(join(dataDir, "panel.db"), { readonly: true });
  const row = db.query("select avatar from users").get() as { avatar: string };
  db.close();
  expect(JSON.parse(row.avatar)).toMatchObject({ kind: "preset", style: "notionists", seed: expect.stringMatching(/^[a-z0-9]{10}$/) });
});

test("a password on the command line is refused, and so is a short one", async () => {
  const onArgv = await run(["owner@example.com", "a long enough password"], "");
  expect(onArgv.code).toBe(1);
  expect(onArgv.stderr).toContain("never taken from the command line");
  expect(owners(onArgv.dataDir)).toEqual([]);

  const short = await run(["owner@example.com"], "short\n");
  expect(short.code).toBe(1);
  expect(owners(short.dataDir)).toEqual([]);
});
