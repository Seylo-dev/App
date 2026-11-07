// Replaces master.key and seals every secret in panel.db again with the new
// key, for when a copy of the data dir (panel.db with master.key) leaked.
// Stop the panel first, run it against the data dir, then start the panel:
//
//   bun scripts/rotate-master-key.ts
//
// The panel makes a new edge ticket key and load balancer CA on its next
// start (nodes pick them up when they reconnect). Recovery codes cannot be
// carried over: the people listed make new ones in Settings > Security.
// See src/security/rotate-master-key.ts.

import { resolve } from "node:path";
import { loadConfig } from "../src/config";
import { RotationError, rotateMasterKey } from "../src/security/rotate-master-key";

const config = loadConfig(process.env, resolve(import.meta.dir, ".."));
try {
  const result = rotateMasterKey(config.dataDir);
  if (result.resumed) {
    console.log("Finished an earlier rotation that stopped before master.key was replaced.");
    process.exit(0);
  }
  const total = Object.values(result.resealed).reduce((sum, n) => sum + n, 0);
  console.log(`New master.key written; ${total} sealed values sealed again:`);
  for (const [where, count] of Object.entries(result.resealed)) console.log(`  ${where}: ${count}`);
  console.log("The panel makes a new edge ticket key and load balancer CA when it starts.");
  if (result.recoveryCodesCleared.length > 0) {
    console.log("Recovery codes were deleted; these people make new ones in Settings > Security:");
    for (const email of result.recoveryCodesCleared) console.log(`  ${email}`);
  }
  console.log("Start the panel now. Delete old copies of the data dir: they still open with the old key.");
} catch (error) {
  console.error(error instanceof RotationError || error instanceof Error ? error.message : String(error));
  process.exit(1);
}
