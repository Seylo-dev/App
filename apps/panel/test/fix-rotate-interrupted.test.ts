// A master-key rotation killed half way leaves master.key.new. The panel's
// start finishes it when panel.db is already sealed with the new key, and
// refuses to start on one that never committed (master.key.new may belong
// to a rotation still running, so only the next rotation run removes it).
// Starting on the old key after a commit would leave every secret unreadable
// and, with a new identity, make new identity keys sealed with the old key.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import { gitCredentials } from "../src/db/schema";
import { ensureEdgeTicketKey } from "../src/security/edge-ticket-key";
import { loadMasterKey } from "../src/security/master-key";
import { finishInterruptedRotation, RotationError, rotateMasterKey } from "../src/security/rotate-master-key";
import { createSecretBox } from "../src/security/secret-box";

const packageRoot = resolve(import.meta.dir, "..");
const migrationsDir = loadConfig({}, packageRoot).migrationsDir;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rotate-interrupted-"));
  const secrets = createSecretBox(loadMasterKey(join(dir, "master.key"), true));
  const dbs = openDatabases({ panelPath: join(dir, "panel.db"), metricsPath: join(dir, "metrics.db"), migrationsDir });
  dbs.db
    .insert(gitCredentials)
    .values({ name: "pat", kind: "token", host: "github.com", secretSealed: secrets.seal("ghp_secret", "git.credential") })
    .run();
  ensureEdgeTicketKey(dbs.db, secrets);
  dbs.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const keyPath = () => join(dir, "master.key");
const randomKey = () => `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}\n`;

test("nothing to do without master.key.new", () => {
  expect(finishInterruptedRotation(dir)).toBe(false);
});

test("a rotation that committed is finished on start", () => {
  const oldText = readFileSync(keyPath(), "utf8");
  rotateMasterKey(dir, { panelIdentity: "keep" });
  const newText = readFileSync(keyPath(), "utf8");
  writeFileSync(`${keyPath()}.new`, newText);
  writeFileSync(keyPath(), oldText);

  expect(finishInterruptedRotation(dir)).toBe(true);
  expect(readFileSync(keyPath(), "utf8")).toBe(newText);
  expect(existsSync(`${keyPath()}.new`)).toBe(false);
  const dbs = openDatabases({ panelPath: join(dir, "panel.db"), metricsPath: join(dir, "metrics.db"), migrationsDir });
  const sealed = dbs.db.select().from(gitCredentials).get()?.secretSealed as string;
  expect(createSecretBox(loadMasterKey(keyPath(), false)).open(sealed, "git.credential")).toBe("ghp_secret");
  dbs.close();
});

test("a rotation that never committed stops the panel and keeps master.key.new for the next rotation run", () => {
  const pending = randomKey();
  writeFileSync(`${keyPath()}.new`, pending);
  const oldText = readFileSync(keyPath(), "utf8");
  expect(() => finishInterruptedRotation(dir)).toThrow(RotationError);
  expect(() => finishInterruptedRotation(dir)).toThrow("seylo panel rotate-key");
  expect(readFileSync(`${keyPath()}.new`, "utf8")).toBe(pending);
  expect(readFileSync(keyPath(), "utf8")).toBe(oldText);
});

test("the panel's start runs the check", async () => {
  writeFileSync(`${keyPath()}.new`, randomKey());
  // Port 3604 is this test's own; the panel stops before it listens.
  const panel = Bun.spawn(["bun", join(packageRoot, "src/main.ts")], {
    env: { ...process.env, SEYLO_DATA_DIR: dir, SEYLO_HOST: "127.0.0.1", SEYLO_PORT: "3604", SEYLO_LOG_LEVEL: "error" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([panel.exited, Bun.sleep(15_000).then(() => null)]);
  if (exited === null) panel.kill();
  expect(exited).not.toBeNull();
  expect(exited).not.toBe(0);
  expect(await new Response(panel.stderr).text()).toContain("did not finish");
}, 20_000);
