// Creates the owner account from the command line, for development and
// for recovery when nobody can open the setup link:
//
//   bun run create-owner you@example.com 'a long password'
//
// Uses the same data dir as the panel (SEYLO_DATA_DIR, or the default).
// The normal path is the installer's /setup?t= link (scripts/setup-link.ts).

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isNull } from "drizzle-orm";
import { ownerExists, removeSetupTokenFile } from "../src/auth/setup-token";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import { setupTokens, users } from "../src/db/schema";
import { loadMasterKey } from "../src/security/master-key";
import { hashPassword } from "../src/security/password";

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error("usage: bun run create-owner <email> <password of 10+ characters>");
  process.exit(1);
}

const config = loadConfig(process.env, resolve(import.meta.dir, ".."));
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const panelPath = join(config.dataDir, "panel.db");
// Create the master key alongside a new database, exactly as the panel would.
loadMasterKey(join(config.dataDir, "master.key"), !existsSync(panelPath));
const { db, close } = openDatabases({ panelPath, metricsPath: join(config.dataDir, "metrics.db"), migrationsDir: config.migrationsDir });

const normalized = email.trim().toLowerCase();
if (ownerExists(db)) {
  console.error("An owner already exists.");
  process.exit(1);
}
db.insert(users)
  .values({ email: normalized, name: "", role: "owner", passwordHash: await hashPassword(password) })
  .run();
// The setup link has no job left.
db.update(setupTokens).set({ usedAt: new Date() }).where(isNull(setupTokens.usedAt)).run();
removeSetupTokenFile(config.dataDir);
close();
console.log(`Owner ${normalized} created in ${config.dataDir}.`);
