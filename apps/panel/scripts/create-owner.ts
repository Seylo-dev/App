// Creates the owner account from the command line, for development and
// for recovery when nobody can open the setup link:
//
//   bun run create-owner you@example.com                       asks for the password (not shown)
//   printf '%s\n' "$password" | bun run create-owner you@example.com
//
// The password comes from the terminal or stdin, never from the command
// line, where shell history and the process list would keep it.
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

const usage = "usage: bun run create-owner <email>   (the password, 10+ characters, is read from the terminal or stdin)";
const args = process.argv.slice(2);
const email = args[0];
if (!email || args.length > 1) {
  console.error(args.length > 1 ? `The password is never taken from the command line.\n${usage}` : usage);
  process.exit(1);
}
const password = await readPassword();
if (password.length < 10) {
  console.error(`The password needs 10 or more characters.\n${usage}`);
  process.exit(1);
}

/** One line from stdin; on a terminal, typed without echo. */
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return ((await Bun.stdin.text()).split(/\r?\n/)[0] ?? "").trim();
  process.stdout.write("Password for the owner (10+ characters, not shown): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let typed = "";
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    for (const char of chunk.toString("utf8")) {
      if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        return typed;
      }
      typed = char === "\u007f" || char === "\b" ? typed.slice(0, -1) : typed + char;
    }
  }
  return typed;
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
