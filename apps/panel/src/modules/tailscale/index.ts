// The panel on the owner's tailnet (added in 0.2.1): what the panel node's
// agent sees of the server's own tailscaled, Tailscale Serve for the panel,
// sign-in and Tailscale DNS. Contracts: packages/ops/src/ops/tailscale.ts.
// The tailnet as a private path for IP access is settings/private-paths.ts.

import { defineModule } from "../module";
import { getOp, setDns, setServe, signIn } from "./ops";

export default defineModule({
  name: "tailscale",
  ops: [getOp, setServe, signIn, setDns],
});
