// The tailnet as a private path (settings/private-paths.ts): a way into the
// panel that keeps working when IP access is closed. Working: Serve is
// wanted and an online panel node agent reported tailscaled Running, the
// Serve entry active and the panel answering through its socket, with the
// 5-minute debounce of status.ts; an offline agent keeps the last state.
// Proven by ctx.via "tailnet", which only the tailnet listener's HTTP
// adapter sets (http/ops-http.ts): a request on IP:port cannot claim it.

import { type PrivatePathSource, registerPrivatePath } from "../settings/private-paths";
import { settleRunOut, tailnetPathState } from "./status";

export const tailnetPath: PrivatePathSource = {
  kind: "tailnet",
  state: (deps) => tailnetPathState(deps),
  provenBy: (ctx) => ctx.via === "tailnet",
  settle: (deps, now) => settleRunOut(deps, now),
};

registerPrivatePath(tailnetPath);
