// The panel on the owner's tailnet (added in 0.2.1): what the panel node's
// agent sees of the server's own tailscaled, Tailscale Serve for the panel,
// sign-in and Tailscale DNS. Contracts: packages/ops/src/ops/tailscale.ts.
//
// - ops.ts: the four ops; view.ts builds tailscale.get's answer.
// - status.ts: the panel node's reports in the tailscaleSeen setting, the
//   tailnet path's 5-minute debounce and the 1-minute tailscale.check job.
// - private-path.ts: the tailnet in the private-path registry
//   (settings/private-paths.ts), which decides IP access with the domain.
// - alerts.ts, sign-in.ts (the link, in memory only), keys.ts, facts.ts.
//
// The panel serves the tailnet on a unix socket in its data dir
// (main.ts, http/tailnet-host.ts); the panel node's agent points one Serve
// entry at it while NodeSettings.tailnet.panel is on.

import { create } from "@bufbuild/protobuf";
import { TailnetServeSchema } from "@seylo/proto";
import type { Deps } from "../../deps";
import { defineModule } from "../module";
import { registerPrivatePath } from "../settings/private-paths";
import { panelNodeId } from "./facts";
import { readServeWanted } from "./keys";
import { getOp, setDns, setServe, signIn } from "./ops";
import { tailnetPath } from "./private-path";
import { checkJob, watchTailscale } from "./status";

function start(deps: Deps) {
  registerPrivatePath(tailnetPath);
  // Only the panel node gets the switch, and only while it is on: an
  // install that never served the panel on a tailnet sends what 0.2.0 sent.
  deps.agents.desired.contribute({
    name: "tailscale",
    node(ctx) {
      if (!readServeWanted(ctx.db) || panelNodeId(ctx.db) !== ctx.nodeId) return;
      ctx.settings.tailnet = create(TailnetServeSchema, { panel: true });
    },
  });
  watchTailscale(deps);
}

export default defineModule({
  name: "tailscale",
  ops: [getOp, setServe, signIn, setDns],
  jobs: [checkJob],
  start,
});
