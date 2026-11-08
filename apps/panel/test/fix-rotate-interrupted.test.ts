// A master-key rotation that did not finish leaves master.key.new. The
// panel's start finishes it when panel.db is already sealed with the new key
// (starting on the old key after a commit would leave every secret
// unreadable and, with a new identity, make new identity keys sealed with
// the old key). One that never committed (killed before the commit, or an
// rc.1 run whose transaction failed: that script left master.key.new
// behind) is removed and the panel starts on the old key, instead of
// stopping until a full rotation runs. A rotation still running holds
// panel.db's write lock from writing master.key.new until its commit, so the
// start check waits for it and never takes its key for a leftover.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import { gitCredentials } from "../src/db/schema";
import { ensureEdgeTicketKey } from "../src/security/edge-ticket-key";
import { loadMasterKey } from "../src/security/master-key";
import { finishInterruptedRotation, rotateMasterKey } from "../src/security/rotate-master-key";
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

function openToken(): string | null {
  const dbs = openDatabases({ panelPath: join(dir, "panel.db"), metricsPath: join(dir, "metrics.db"), migrationsDir });
  try {
    const sealed = dbs.db.select().from(gitCredentials).get()?.secretSealed as string;
    return createSecretBox(loadMasterKey(keyPath(), false)).open(sealed, "git.credential");
  } finally {
    dbs.close();
  }
}

test("nothing to do without master.key.new", () => {
  expect(finishInterruptedRotation(dir)).toBe("none");
});

test("a rotation that committed is finished on start", () => {
  const oldText = readFileSync(keyPath(), "utf8");
  rotateMasterKey(dir, { panelIdentity: "keep" });
  const newText = readFileSync(keyPath(), "utf8");
  writeFileSync(`${keyPath()}.new`, newText);
  writeFileSync(keyPath(), oldText);

  expect(finishInterruptedRotation(dir)).toBe("finished");
  expect(readFileSync(keyPath(), "utf8")).toBe(newText);
  expect(existsSync(`${keyPath()}.new`)).toBe(false);
  expect(openToken()).toBe("ghp_secret");
});

test("a rotation that never committed is removed on start and the old key stays", () => {
  writeFileSync(`${keyPath()}.new`, randomKey());
  writeFileSync(join(dir, "agent-tls.key.new"), "-");
  const oldText = readFileSync(keyPath(), "utf8");
  expect(finishInterruptedRotation(dir)).toBe("removed");
  expect(existsSync(`${keyPath()}.new`)).toBe(false);
  expect(existsSync(join(dir, "agent-tls.key.new"))).toBe(false);
  expect(readFileSync(keyPath(), "utf8")).toBe(oldText);
  expect(openToken()).toBe("ghp_secret");
  // A rotation run afterwards rotates from the old key as usual.
  expect(rotateMasterKey(dir, { panelIdentity: "keep" }).resumed).toBe(false);
  expect(openToken()).toBe("ghp_secret");
});

test("the panel's start removes a leftover that never committed and runs on the old key", async () => {
  writeFileSync(`${keyPath()}.new`, randomKey());
  const oldText = readFileSync(keyPath(), "utf8");
  // Port 3604 is this test's own.
  const panel = Bun.spawn(["bun", join(packageRoot, "src/main.ts")], {
    env: { ...process.env, SEYLO_DATA_DIR: dir, SEYLO_HOST: "127.0.0.1", SEYLO_PORT: "3604", SEYLO_LOG_LEVEL: "warn" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let healthy = false;
    for (let i = 0; i < 150 && !healthy && panel.exitCode === null; i++) {
      healthy = await fetch("http://127.0.0.1:3604/api/health")
        .then((r) => r.ok)
        .catch(() => false);
      if (!healthy) await Bun.sleep(100);
    }
    expect(healthy).toBe(true);
    expect(existsSync(`${keyPath()}.new`)).toBe(false);
    expect(readFileSync(keyPath(), "utf8")).toBe(oldText);
  } finally {
    panel.kill();
    await panel.exited;
  }
  expect(await new Response(panel.stdout).text()).toContain("removed master.key.new");
}, 30_000);

test("a rotation still running is waited for, not taken for a leftover", async () => {
  // Enough sealed values that the rotation's transaction stays open for a while.
  const secrets = createSecretBox(loadMasterKey(keyPath(), false));
  const dbs = openDatabases({ panelPath: join(dir, "panel.db"), metricsPath: join(dir, "metrics.db"), migrationsDir });
  dbs.db.transaction((tx) => {
    for (let i = 0; i < 20_000; i++) {
      tx.insert(gitCredentials)
        .values({ name: `pat-${i}`, kind: "token", host: "github.com", secretSealed: secrets.seal(`ghp_${i}`, "git.credential") })
        .run();
    }
  });
  dbs.close();
  const oldText = readFileSync(keyPath(), "utf8");
  const rotation = Bun.spawn(["bun", join(packageRoot, "scripts/rotate-master-key.ts"), "--keep-panel-identity"], {
    env: { ...process.env, SEYLO_DATA_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  // The panel starts while master.key.new exists and the rotation has not committed.
  while (!existsSync(`${keyPath()}.new`) && rotation.exitCode === null) await Bun.sleep(1);
  expect(rotation.exitCode).toBeNull();
  const found = finishInterruptedRotation(dir);
  expect(await rotation.exited).toBe(0);
  // The check waited for the commit: it finished the files itself, or the rotation did.
  expect(["finished", "none"]).toContain(found);
  expect(existsSync(`${keyPath()}.new`)).toBe(false);
  expect(readFileSync(keyPath(), "utf8")).not.toBe(oldText);
  expect(openToken()).toBe("ghp_secret");
}, 60_000);
