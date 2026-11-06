import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slug } from "@seylo/brand";
import { joinTokens, nodes } from "../src/db/schema";
import { importInstallerJoinToken, installerJoinTokenFile } from "../src/modules/nodes/installer-join";
import { hashToken } from "../src/security/tokens";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let dir: string;
beforeEach(() => {
  panel = testPanel();
  dir = mkdtempSync(join(tmpdir(), "installer-join-"));
});
afterEach(() => {
  panel.close();
  rmSync(dir, { recursive: true, force: true });
});

const token = `${slug}_join_${"a".repeat(43)}`;

test("the installer's join token is imported once while there are no nodes", () => {
  writeFileSync(join(dir, installerJoinTokenFile), `${token}\n`);
  expect(importInstallerJoinToken(panel.deps.db, dir, panel.deps.logger)).toBe(true);
  expect(existsSync(join(dir, installerJoinTokenFile))).toBe(false);
  const rows = panel.deps.db.select().from(joinTokens).all();
  expect(rows.map((r) => r.tokenHash)).toEqual([hashToken(token)]);
  expect(rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
  expect(importInstallerJoinToken(panel.deps.db, dir, panel.deps.logger)).toBe(false);
});

test("with a node already joined, or a malformed token, the file is dropped", () => {
  writeFileSync(join(dir, installerJoinTokenFile), "not-a-token\n");
  expect(importInstallerJoinToken(panel.deps.db, dir, panel.deps.logger)).toBe(false);
  expect(existsSync(join(dir, installerJoinTokenFile))).toBe(false);

  panel.deps.db
    .insert(nodes)
    .values({ name: "first", publicKey: new Uint8Array(32) } as never)
    .run();
  writeFileSync(join(dir, installerJoinTokenFile), `${token}\n`);
  expect(importInstallerJoinToken(panel.deps.db, dir, panel.deps.logger)).toBe(false);
  expect(panel.deps.db.select().from(joinTokens).all()).toEqual([]);
});
