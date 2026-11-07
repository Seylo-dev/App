// Replaces master.key and seals every secret in panel.db again with the new
// key, for when a copy of the data dir leaked. Stop the panel first, run it
// against the data dir with exactly one of the two flags, then start the
// panel:
//
//   bun scripts/rotate-master-key.ts --new-panel-identity    # panel.db leaked
//   bun scripts/rotate-master-key.ts --keep-panel-identity   # only master.key leaked
//
// See src/security/rotate-master-key.ts for what each one does.

import { resolve } from "node:path";
import { installUrl, slug } from "@seylo/brand";
import { loadConfig } from "../src/config";
import { type PanelIdentity, type RejoinNode, rotateMasterKey } from "../src/security/rotate-master-key";

const choice = `Choose what happens to the panel's identity with exactly one flag:

  --new-panel-identity    panel.db leaked (a copy of the data dir, a backup).
                          The edge ticket key that proves this panel to its
                          nodes and signs DB web UI, Box and status tickets
                          was in it, so it is replaced, with the load balancer
                          CA. Nodes remember that key from their first connect
                          and refuse a panel with another one: afterwards every
                          node must be joined again with \`${slug} join --force\`
                          and a token from Nodes > Add node. The script lists
                          the nodes and the steps.

  --keep-panel-identity   only master.key leaked; panel.db never did. The edge
                          key and the load balancer CA are sealed again under
                          the new key and nodes keep working.

Both seal every secret in panel.db again and delete recovery codes (people
make new ones in Settings > Security). Stop the panel before running it.`;

function identityFromArgs(args: string[]): PanelIdentity | null {
  const fresh = args.includes("--new-panel-identity");
  const keep = args.includes("--keep-panel-identity");
  const unknown = args.filter((a) => a !== "--new-panel-identity" && a !== "--keep-panel-identity");
  if (unknown.length > 0 || fresh === keep) return null;
  return fresh ? "new" : "keep";
}

/** The re-join procedure of the Nodes screen's Add node dialog (nodes/ops.ts joinCommand), for nodes that already joined. */
function rejoinSteps(nodes: RejoinNode[]): string[] {
  const lines = [
    "",
    "Every node now refuses the panel until it is joined again. Its services keep running meanwhile, and a",
    "re-joined node keeps its place in the panel (same machine key). For each node below:",
    "  1. Start the panel and sign in.",
    "  2. Open Nodes > Add node. The dialog shows a join command with a new token (one node per token,",
    "     valid for one hour).",
    "  3. On that node, run that command with --force added at the end:",
    `       curl -fsSL https://${installUrl} | sudo sh -s -- join --panel '<url>' --token '<token>' [--pin '<pin>'] --force`,
    "     or, with the panel URL, token and pin from the same dialog, the node CLI directly:",
    `       sudo ${slug} join '<url>' --token '<token>' [--pin '<pin>'] --force`,
    `  4. \`${slug} status\` on the node shows it connected, and the Nodes screen shows it online.`,
    "",
    "Nodes:",
  ];
  if (nodes.length === 0) lines.push("  (none)");
  for (const node of nodes) {
    lines.push(`  ${node.name}  ${node.address ?? "(no public address known)"}${node.panelNode ? "  (runs the panel: join it too)" : ""}`);
  }
  return lines;
}

const identity = identityFromArgs(process.argv.slice(2));
if (!identity) {
  console.error(choice);
  process.exit(2);
}

const config = loadConfig(process.env, resolve(import.meta.dir, ".."));
try {
  const result = rotateMasterKey(config.dataDir, { panelIdentity: identity });
  if (result.resumed) {
    console.log("Finished an earlier rotation that stopped before master.key was replaced.");
    process.exit(0);
  }
  const total = Object.values(result.resealed).reduce((sum, n) => sum + n, 0);
  console.log(`New master.key written; ${total} sealed values sealed again:`);
  for (const [where, count] of Object.entries(result.resealed)) console.log(`  ${where}: ${count}`);
  if (identity === "new") {
    console.log("The panel makes a new edge ticket key and load balancer CA when it starts; the panel id stays.");
  } else {
    console.log("The edge ticket key and load balancer CA were sealed again: nodes keep working.");
  }
  if (result.recoveryCodesCleared.length > 0) {
    console.log("Recovery codes were deleted; these people make new ones in Settings > Security:");
    for (const email of result.recoveryCodesCleared) console.log(`  ${email}`);
  }
  if (identity === "new") for (const line of rejoinSteps(result.rejoin)) console.log(line);
  console.log("");
  console.log("Start the panel now. Delete old copies of the data dir: they still open with the old key.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
