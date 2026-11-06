// The master key seals secrets stored in panel.db. It lives in its own
// file next to the database (never inside it), so a leaked database copy
// alone reveals no secrets.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const keyBytes = 32;

export class MasterKeyError extends Error {
  override name = "MasterKeyError";
}

/**
 * Reads the key at `path`. When it is missing, a new one is created only if
 * `allowCreate` is set, which the caller does for a fresh install. Creating
 * a key for an existing database would silently make every sealed secret
 * unreadable, so that case fails loudly instead.
 */
export function loadMasterKey(path: string, allowCreate: boolean): Uint8Array {
  if (!existsSync(path)) {
    if (!allowCreate) {
      throw new MasterKeyError(
        `${path} is missing but the database already exists. Restore the key from your backup; without it sealed secrets cannot be read.`,
      );
    }
    const key = crypto.getRandomValues(new Uint8Array(keyBytes));
    writeFileSync(path, `${Buffer.from(key).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  }
  // Tighten permissions on every start in case a restore loosened them.
  chmodSync(path, 0o600);
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (key.length !== keyBytes) {
    throw new MasterKeyError(`${path} does not hold a ${keyBytes}-byte base64 key.`);
  }
  return new Uint8Array(key);
}
