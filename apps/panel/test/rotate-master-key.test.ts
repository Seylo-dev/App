// scripts/rotate-master-key.ts on a seeded data dir: every sealed value
// (columns and sealed fields inside settings) opens with the new key only;
// with --new-panel-identity the edge ticket key and LB CA are made anew on
// the next start and the nodes to re-join are listed, with
// --keep-panel-identity they are sealed again and stay; the script refuses
// to run without exactly one of the two; recovery codes are cleared with
// their owners listed; a wrong key or an interrupted run never loses secrets.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { issueRecoveryCodes } from "../src/auth/second-factor";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import { gitCredentials, nodes, recoveryCodes, settings, users } from "../src/db/schema";
import { ensureEdgeTicketKey } from "../src/security/edge-ticket-key";
import { loadMasterKey } from "../src/security/master-key";
import { RotationError, rotateMasterKey } from "../src/security/rotate-master-key";
import { createSecretBox } from "../src/security/secret-box";
import { ensurePanelId, setSetting } from "../src/settings";

const migrationsDir = loadConfig({}, resolve(import.meta.dir, "..")).migrationsDir;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rotate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function open() {
  return openDatabases({ panelPath: join(dir, "panel.db"), metricsPath: join(dir, "metrics.db"), migrationsDir });
}

/** A data dir with a git token, a sealed setting, the edge ticket key and recovery codes. */
function seed() {
  const key = loadMasterKey(join(dir, "master.key"), true);
  const secrets = createSecretBox(key);
  const dbs = open();
  const user = dbs.db.insert(users).values({ email: "owner@example.com", name: "Owner", role: "owner" }).returning().get();
  dbs.db
    .insert(gitCredentials)
    .values({ name: "pat", kind: "token", host: "github.com", secretSealed: secrets.seal("ghp_secret", "git.credential") })
    .run();
  setSetting(dbs.db, "lbTlsCa", { certPem: "-", keySealed: secrets.seal("ca-key", "lb.key"), notAfter: 1 });
  ensureEdgeTicketKey(dbs.db, secrets);
  issueRecoveryCodes(dbs.db, secrets, user.id);
  const key32 = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  dbs.db.insert(nodes).values({ name: "edge-1", publicKey: key32(), publicIpv4: "203.0.113.7", isPanelNode: true }).run();
  dbs.db.insert(nodes).values({ name: "worker-2", publicKey: key32(), publicAddress: "worker-2.example.com" }).run();
  dbs.db.insert(nodes).values({ name: "retired", publicKey: key32(), disabledAt: new Date() }).run();
  dbs.close();
  return { key, secrets };
}

test("--new-panel-identity: every sealed value moves to the new key and the identity keys are made anew", () => {
  const { key: oldKey, secrets: oldBox } = seed();
  const before = open();
  const stored = before.db.select().from(settings).where(eq(settings.key, "edgeTicketKey")).get();
  const edgeKeyBefore = (stored?.value as { publicKey: string } | undefined)?.publicKey;
  expect(edgeKeyBefore).toBeDefined();
  const panelId = ensurePanelId(before.db);
  before.close();

  const result = rotateMasterKey(dir, { panelIdentity: "new" });
  expect(result.resumed).toBe(false);
  expect(result.rejoin).toEqual([
    { name: "edge-1", address: "203.0.113.7", panelNode: true },
    { name: "worker-2", address: "worker-2.example.com", panelNode: false },
  ]);
  expect(result.resealed["git_credentials.secret_sealed"]).toBe(1);
  expect(result.recoveryCodesCleared).toEqual(["owner@example.com"]);
  expect(existsSync(join(dir, "master.key.new"))).toBe(false);

  const newKey = loadMasterKey(join(dir, "master.key"), false);
  expect(Buffer.from(newKey).equals(Buffer.from(oldKey))).toBe(false);
  const newBox = createSecretBox(newKey);
  const after = open();
  const token = after.db.select().from(gitCredentials).get()?.secretSealed as string;
  expect(newBox.open(token, "git.credential")).toBe("ghp_secret");
  expect(oldBox.open(token, "git.credential")).toBeNull();
  // The LB CA and edge ticket key are gone; the next start makes a new edge key.
  expect(after.db.select().from(settings).where(eq(settings.key, "lbTlsCa")).get()).toBeUndefined();
  expect(after.db.select().from(recoveryCodes).all()).toHaveLength(0);
  const edgeAfter = ensureEdgeTicketKey(after.db, newBox);
  expect(Buffer.from(edgeAfter.publicKey).toString("base64")).not.toBe(edgeKeyBefore);
  // Only the key changes: the panel id nodes also remember stays.
  expect(ensurePanelId(after.db)).toBe(panelId);
  after.close();
});

test("sealed fields inside settings are sealed again too", () => {
  const { secrets } = seed();
  const dbs = open();
  setSetting(dbs.db, "lbTlsNodes", {}); // regenerated, but other settings keep their values
  dbs.db
    .insert(settings)
    .values({ key: "testNested", value: { list: [{ tokenSealed: secrets.seal("nested", "git.provider") }] } })
    .run();
  dbs.close();
  rotateMasterKey(dir, { panelIdentity: "new" });
  const newBox = createSecretBox(loadMasterKey(join(dir, "master.key"), false));
  const after = open();
  const nested = after.db.select().from(settings).where(eq(settings.key, "testNested")).get()?.value as {
    list: { tokenSealed: string }[];
  };
  expect(newBox.open(nested.list[0]?.tokenSealed as string, "git.provider")).toBe("nested");
  after.close();
});

test("a key that does not match the database changes nothing", () => {
  seed();
  const keyPath = join(dir, "master.key");
  const wrong = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const right = readFileSync(keyPath, "utf8");
  writeFileSync(keyPath, `${wrong}\n`);
  expect(() => rotateMasterKey(dir, { panelIdentity: "new" })).toThrow(RotationError);
  writeFileSync(keyPath, right);
  const box = createSecretBox(loadMasterKey(keyPath, false));
  const dbs = open();
  expect(box.open(dbs.db.select().from(gitCredentials).get()?.secretSealed as string, "git.credential")).toBe("ghp_secret");
  expect(existsSync(`${keyPath}.new`)).toBe(false);
  dbs.close();
});

test("a run interrupted after the commit is finished by the next run", () => {
  seed();
  const keyPath = join(dir, "master.key");
  const oldText = readFileSync(keyPath, "utf8");
  rotateMasterKey(dir, { panelIdentity: "new" });
  // As if the process died between the commit and replacing master.key.
  writeFileSync(`${keyPath}.new`, readFileSync(keyPath, "utf8"));
  writeFileSync(keyPath, oldText);
  expect(rotateMasterKey(dir, { panelIdentity: "new" }).resumed).toBe(true);
  const box = createSecretBox(loadMasterKey(keyPath, false));
  const dbs = open();
  expect(box.open(dbs.db.select().from(gitCredentials).get()?.secretSealed as string, "git.credential")).toBe("ghp_secret");
  dbs.close();
});

test("the owner keeps their account", () => {
  seed();
  rotateMasterKey(dir, { panelIdentity: "keep" });
  const dbs = open();
  expect(dbs.db.select().from(users).where(eq(users.email, "owner@example.com")).get()).toBeDefined();
  dbs.close();
});

test("--keep-panel-identity: the edge ticket key and LB CA are sealed again and stay the same", () => {
  const { secrets: oldBox } = seed();
  const before = open();
  const edgeBefore = ensureEdgeTicketKey(before.db, oldBox);
  before.close();

  const result = rotateMasterKey(dir, { panelIdentity: "keep" });
  expect(result.rejoin).toEqual([]);
  const newBox = createSecretBox(loadMasterKey(join(dir, "master.key"), false));
  const after = open();
  // Same key pair, now readable with the new master key only.
  const edgeAfter = ensureEdgeTicketKey(after.db, newBox);
  expect(Buffer.from(edgeAfter.publicKey).equals(Buffer.from(edgeBefore.publicKey))).toBe(true);
  const stored = after.db.select().from(settings).where(eq(settings.key, "edgeTicketKey")).get()?.value as { privateKeySealed: string };
  expect(oldBox.open(stored.privateKeySealed, "edge.ticket-key")).toBeNull();
  const ca = after.db.select().from(settings).where(eq(settings.key, "lbTlsCa")).get()?.value as { keySealed: string };
  expect(newBox.open(ca.keySealed, "lb.key")).toBe("ca-key");
  expect(after.db.select().from(recoveryCodes).all()).toHaveLength(0);
  after.close();
});

describe("the script", () => {
  const script = resolve(import.meta.dir, "../scripts/rotate-master-key.ts");
  const run = (...args: string[]) => {
    const out = Bun.spawnSync(["bun", script, ...args], { env: { ...process.env, SEYLO_DATA_DIR: dir } });
    return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
  };

  test("refuses without exactly one identity flag and changes nothing", () => {
    seed();
    const keyBefore = readFileSync(join(dir, "master.key"), "utf8");
    for (const args of [[], ["--new-panel-identity", "--keep-panel-identity"], ["--yes"]]) {
      const out = run(...args);
      expect({ args, code: out.code }).toEqual({ args, code: 2 });
      expect(out.stderr).toContain("--new-panel-identity");
      expect(out.stderr).toContain("join --force");
    }
    expect(readFileSync(join(dir, "master.key"), "utf8")).toBe(keyBefore);
  });

  test("--new-panel-identity lists the nodes and the re-join steps", () => {
    seed();
    const out = run("--new-panel-identity");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("edge-1  203.0.113.7  (runs the panel: join it too)");
    expect(out.stdout).toContain("worker-2  worker-2.example.com");
    expect(out.stdout).not.toContain("retired");
    expect(out.stdout).toContain("Nodes > Add node");
    expect(out.stdout).toContain("join '<url>' --token '<token>' [--pin '<pin>'] --force");
  });

  test("--keep-panel-identity says nodes keep working", () => {
    seed();
    const out = run("--keep-panel-identity");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("nodes keep working");
    expect(out.stdout).not.toContain("--force");
  });
});
