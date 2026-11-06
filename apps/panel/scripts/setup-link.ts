// Prints a fresh one-time setup link while the panel has no owner, for
// when the installer's link expired (it is valid one hour):
//
//   bun scripts/setup-link.ts [https://panel.example.com]
//
// Writes the token to <dataDir>/setup-token too, like the panel does on
// start. Older unused links stop working. The node CLI wraps this as
// `seylo panel setup-link`.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { issueSetupToken, ownerExists, setupTokenPath } from "../src/auth/setup-token";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import { loadMasterKey } from "../src/security/master-key";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const config = loadConfig(process.env, resolve(import.meta.dir, ".."));
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const panelPath = join(config.dataDir, "panel.db");
loadMasterKey(join(config.dataDir, "master.key"), !existsSync(panelPath));
const { db, close } = openDatabases({ panelPath, metricsPath: join(config.dataDir, "metrics.db"), migrationsDir: config.migrationsDir });

if (ownerExists(db)) {
  close();
  console.error("The owner account already exists. Sign in instead.");
  process.exit(1);
}
const { token, expiresAt } = issueSetupToken(db);
writeFileSync(setupTokenPath(config.dataDir), `${token}\n`, { mode: 0o600 });
close();
console.log(`${base}/setup?t=${token}`);
console.error(`Valid until ${expiresAt.toISOString()}.`);
