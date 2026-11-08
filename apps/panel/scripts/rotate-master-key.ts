// Replaces master.key and seals every secret in panel.db again with the new
// key, for when a copy of the data dir leaked. On an install, run
// `sudo seylo panel rotate-key --new-panel-identity` (or
// --keep-panel-identity) on the panel's node: it stops the agent and the
// panel, runs this script from the panel's image and starts them again. By
// hand: stop the panel, run it against the data dir with exactly one of the
// two flags, then start the panel:
//
//   bun scripts/rotate-master-key.ts --new-panel-identity    # panel.db leaked
//   bun scripts/rotate-master-key.ts --keep-panel-identity   # only master.key leaked
//
// `--from-cli` (from `seylo panel rotate-key`) leaves out the line that says
// to start the panel: the command does that itself.
// See src/security/rotate-master-key.ts for what each one does.

import { resolve } from "node:path";
import { slug } from "@seylo/brand";
import { loadConfig } from "../src/config";
import { type PanelIdentity, type RejoinPlan, rotateMasterKey } from "../src/security/rotate-master-key";

const choice = `Choose what happens to the panel's identity with exactly one flag:

  --new-panel-identity    panel.db leaked (a copy of the data dir, a backup).
                          The edge ticket key that proves this panel to its
                          nodes and signs DB web UI, Box and status tickets
                          was in it, so it is replaced, with the load balancer
                          CA and the agents' TLS key (agent-tls.key, in the
                          same copy). Nodes remember those keys from their
                          first connect and refuse a panel with other ones:
                          afterwards every node must be joined again with
                          \`${slug} join --force\`, a token from Nodes > Add
                          node and the new pin. The script lists the nodes
                          and the commands.

  --keep-panel-identity   only master.key leaked; panel.db never did. The edge
                          key and the load balancer CA are sealed again under
                          the new key, agent-tls.key stays, and nodes keep
                          working.

Both seal every secret in panel.db again and delete recovery codes (people
make new ones in Settings > Security). On the panel's node,
\`sudo ${slug} panel rotate-key\` with the same flag stops the panel, runs
this and starts it again; by hand, stop the panel before running it.`;

const flags = ["--new-panel-identity", "--keep-panel-identity", "--from-cli"];

function parseArgs(args: string[]): { identity: PanelIdentity; fromCli: boolean } | null {
  const fresh = args.includes("--new-panel-identity");
  const keep = args.includes("--keep-panel-identity");
  if (args.some((a) => !flags.includes(a)) || fresh === keep) return null;
  return { identity: fresh ? "new" : "keep", fromCli: args.includes("--from-cli") };
}

/** `seylo join` for one node: the panel's own on loopback as the installer joined it, others like the Add node dialog. */
function joinLine(plan: RejoinPlan, node: RejoinPlan["nodes"][number]): string {
  if (node.panelNode) return `sudo ${slug} join ${plan.localUrl} --token '<token>'${node.canBuild ? " --can-build" : ""} --force`;
  const { url, pin, insecureTransport } = plan.target;
  return `sudo ${slug} join '${url}' --token '<token>'${pin ? ` --pin '${pin}'` : ""}${insecureTransport ? " --insecure" : ""} --force`;
}

function rejoinSteps(plan: RejoinPlan): string[] {
  const lines = [
    "",
    "Every node now refuses the panel until it is joined again. Its services keep running meanwhile, and a",
    "re-joined node keeps its place in the panel (same machine key). Once the panel runs, sign in and, for",
    "each node below, open Nodes > Add node for a new token (one node per token, valid for an hour) and run",
    "the command under the node on that node, with the token in place of <token>:",
    "",
  ];
  if (plan.nodes.length === 0) lines.push("  (no nodes)");
  for (const node of plan.nodes) {
    lines.push(`  ${node.name}  ${node.address ?? "(no public address known)"}${node.panelNode ? "  (runs the panel)" : ""}`);
    lines.push(`    ${joinLine(plan, node)}`);
  }
  lines.push("", `\`${slug} status\` on a node then shows it connected, and the Nodes screen shows it online.`);
  return lines;
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  console.error(choice);
  process.exit(2);
}
const { identity, fromCli } = parsed;

const config = loadConfig(process.env, resolve(import.meta.dir, ".."));
const closing = fromCli
  ? "Delete old copies of the data dir: they still open with the old key."
  : `Start the agent now (\`sudo systemctl start ${slug}\`); it starts the panel. Delete old copies of the data dir: they still open with the old key.`;
try {
  const result = rotateMasterKey(config.dataDir, { panelIdentity: identity, config });
  if (result.resumed) {
    console.log("Finished an earlier rotation that stopped before master.key was replaced.");
  } else {
    const total = Object.values(result.resealed).reduce((sum, n) => sum + n, 0);
    console.log(`New master.key written; ${total} sealed values sealed again:`);
    for (const [where, count] of Object.entries(result.resealed)) console.log(`  ${where}: ${count}`);
    if (identity === "new") {
      console.log("The panel makes a new edge ticket key and load balancer CA when it starts; the panel id stays.");
      if (result.agentTlsPin) console.log(`The agents' TLS key was replaced too; its new pin is ${result.agentTlsPin}.`);
    } else {
      console.log("The edge ticket key and load balancer CA were sealed again and agent-tls.key stays: nodes keep working.");
    }
    if (result.recoveryCodesCleared.length > 0) {
      console.log("Recovery codes were deleted; these people make new ones in Settings > Security:");
      for (const email of result.recoveryCodesCleared) console.log(`  ${email}`);
    }
  }
  if (result.rejoin) for (const line of rejoinSteps(result.rejoin)) console.log(line);
  console.log("");
  console.log(closing);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
