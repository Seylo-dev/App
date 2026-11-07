// Replaces master.key after a backup of the data dir leaked (panel.db and
// master.key travel together): every sealed value in panel.db is opened
// with the old key and sealed again with a new one in one transaction, and
// the keys that were themselves secrets of the old install are dropped so
// the panel makes new ones on its next start:
//
// - the edge ticket key (DB web UI, Box and status tickets): agents get the
//   new public key in their next HelloAccepted, so tickets signed with the
//   leaked key stop working once they reconnect;
// - the load balancer CA and node certificates: nodes get new ones when
//   they connect again.
//
// Recovery codes are keyed hashes under the old key and cannot be carried
// over: they are deleted and the people who had them are listed, so they
// make new ones. The agents' TLS key (agent-tls.key) stays: nodes pin it.
//
// Run it with the panel stopped. master.key is replaced only after the
// database commit; the new key waits in master.key.new until then, and a
// run that finds one left by a crash finishes or undoes it first.

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMasterKey } from "./master-key";
import { createSecretBox, type SealPurpose, type SecretBox, sealPurposes } from "./secret-box";

/** `v1.<12-byte iv>.<16-byte tag>.<ciphertext>`, all base64url (secret-box.ts). */
const sealedPattern = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$/;
/** Settings that hold keys of the old install; the panel makes new ones on start. */
const regeneratedSettings = ["edgeTicketKey", "lbTlsCa", "lbTlsNodes"];

export interface RotationResult {
  /** Sealed values sealed again, by "table.column". */
  resealed: Record<string, number>;
  /** Emails of people whose recovery codes were deleted. */
  recoveryCodesCleared: string[];
  /** True when the run only finished an earlier, interrupted rotation. */
  resumed: boolean;
}

export class RotationError extends Error {
  override name = "RotationError";
}

export function rotateMasterKey(dataDir: string): RotationResult {
  const keyPath = join(dataDir, "master.key");
  const nextPath = `${keyPath}.new`;
  const dbPath = join(dataDir, "panel.db");
  if (!existsSync(dbPath)) throw new RotationError(`${dbPath} does not exist.`);
  const sqlite = new Database(dbPath);
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    const oldKey = loadMasterKey(keyPath, false);
    if (existsSync(nextPath)) {
      const pending = loadMasterKey(nextPath, false);
      if (sealedWith(sqlite, createSecretBox(pending))) {
        // The database was re-sealed but master.key not replaced yet: finish.
        renameSync(nextPath, keyPath);
        return { resealed: {}, recoveryCodesCleared: [], resumed: true };
      }
      rmSync(nextPath);
    }

    const before = createSecretBox(oldKey);
    if (!sealedWith(sqlite, before, true)) {
      throw new RotationError("master.key does not open the sealed values in panel.db. Restore the matching key first.");
    }
    const newKey = crypto.getRandomValues(new Uint8Array(32));
    writeFileSync(nextPath, `${Buffer.from(newKey).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(nextPath, 0o600);
    const after = createSecretBox(newKey);

    const result: RotationResult = { resealed: {}, recoveryCodesCleared: [], resumed: false };
    sqlite.transaction(() => {
      for (const { table, column } of textColumns(sqlite)) {
        const rows = sqlite
          .query<{ id: number; value: string }, []>(
            `SELECT rowid AS id, "${column}" AS value FROM "${table}" WHERE "${column}" LIKE 'v1.%' OR "${column}" LIKE '{%' OR "${column}" LIKE '[%'`,
          )
          .all();
        for (const row of rows) {
          const { value, count } = resealText(row.value, before, after, `${table}.${column}`);
          if (count === 0) continue;
          sqlite.query(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`).run(value, row.id);
          result.resealed[`${table}.${column}`] = (result.resealed[`${table}.${column}`] ?? 0) + count;
        }
      }
      for (const key of regeneratedSettings) sqlite.query("DELETE FROM settings WHERE key = ?").run(key);
      result.recoveryCodesCleared = sqlite
        .query<{ email: string }, []>(
          "SELECT DISTINCT users.email AS email FROM recovery_codes JOIN users ON users.id = recovery_codes.user_id ORDER BY users.email",
        )
        .all()
        .map((r) => r.email);
      sqlite.exec("DELETE FROM recovery_codes");
    })();
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    renameSync(nextPath, keyPath);
    return result;
  } finally {
    sqlite.close();
  }
}

function textColumns(sqlite: Database): { table: string; column: string }[] {
  const tables = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all();
  const out: { table: string; column: string }[] = [];
  for (const { name } of tables) {
    for (const col of sqlite.query<{ name: string; type: string }, []>(`PRAGMA table_info("${name}")`).all()) {
      if (/text|blob|^$/i.test(col.type)) out.push({ table: name, column: col.name });
    }
  }
  return out;
}

/** Re-seals a sealed string, or every sealed string inside a JSON value. */
function resealText(text: string, before: SecretBox, after: SecretBox, where: string): { value: string; count: number } {
  if (sealedPattern.test(text)) return { value: reseal(text, before, after, where), count: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: text, count: 0 };
  }
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string" && sealedPattern.test(node)) {
      count++;
      return reseal(node, before, after, where);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  const walked = walk(parsed);
  return count === 0 ? { value: text, count: 0 } : { value: JSON.stringify(walked), count };
}

function reseal(sealed: string, before: SecretBox, after: SecretBox, where: string): string {
  for (const purpose of sealPurposes) {
    const plain = before.open(sealed, purpose);
    if (plain !== null) return after.seal(plain, purpose as SealPurpose);
  }
  // Nothing is changed when a value cannot be read: the transaction rolls back.
  throw new RotationError(`A sealed value in ${where} does not open with master.key; nothing was changed.`);
}

/** Whether `box` opens the first sealed value found (true for a database with none, when `emptyIsOk`). */
function sealedWith(sqlite: Database, box: SecretBox, emptyIsOk = false): boolean {
  for (const { table, column } of textColumns(sqlite)) {
    const row = sqlite
      .query<{ value: string }, []>(`SELECT "${column}" AS value FROM "${table}" WHERE "${column}" LIKE 'v1.%' LIMIT 1`)
      .get();
    if (row && sealedPattern.test(row.value)) return sealPurposes.some((purpose) => box.open(row.value, purpose) !== null);
  }
  return emptyIsOk;
}
