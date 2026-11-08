// Alerts about the panel on the tailnet. The alert events are a closed list
// (packages/ops alerts.ts), so these are keys on existing events:
//
//   security_change           tailnet-serve-on:<ms>         Serve turned on, naming the tailnet and the login
//                             tailnet-moved:<ms>            the server signed in to another tailnet than Serve was turned on for
//   node_health_check_failed  tailnet-key-expiry:<expiry>   the server's key expires within 14 days
//                             tailnet-needs-login:<ms>      the server is signed out (NeedsLogin)
//                             tailnet-needs-approval:<ms>   the machine waits for approval (NeedsMachineAuth)
//                             tailnet-stopped:<ms>          the tailnet path stopped working; says whether IP access reopened
//
// Only while Serve is wanted: a server that never served the panel on its
// tailnet has nothing to warn about. All of them link to Settings > Tailscale.

import { eq } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import type { OpContext } from "../../ops/implement";
import type { TailscaleSeen } from "./keys";

export const tailscalePage = "/settings/tailscale";
export const keyExpiryWarnMs = 14 * 86_400_000;

const prefixes = {
  keyExpiry: "tailnet-key-expiry:",
  needsLogin: "tailnet-needs-login:",
  needsApproval: "tailnet-needs-approval:",
  stopped: "tailnet-stopped:",
  moved: "tailnet-moved:",
} as const;

/** What happened to IP access when the tailnet path stopped working. */
export type IpAccessNote = "reopened" | "staysClosed" | "open";

const ipAccessNotes: Record<IpAccessNote, string> = {
  reopened: " IP access reopened: the panel answers on its IP address and port again.",
  staysClosed: " IP access stays closed (Keep it closed). Use the SSH tunnel or `sudo seylo panel ip-access on` on the server.",
  open: "",
};

function nodeName(deps: Pick<Deps, "db">, nodeId: string | null): string {
  if (!nodeId) return "the panel server";
  return deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? "the panel server";
}

/** Raises one alert per incident while `on`, and resolves it once `on` is false. */
function toggle(deps: Pick<Deps, "alerts">, prefix: string, on: boolean, now: number, build: () => { title: string; message: string }) {
  if (!on) {
    deps.alerts.resolve(prefix);
    return;
  }
  if (deps.alerts.isOpen(prefix)) return;
  deps.alerts.raise({ event: "node_health_check_failed", key: `${prefix}${now}`, ...build(), link: tailscalePage });
}

/** The alerts that follow the server's state: key expiry, signed out, waiting for approval. */
export function stateAlerts(deps: Pick<Deps, "db" | "alerts">, seen: TailscaleSeen, wanted: boolean, nodeId: string | null, now: number) {
  const name = nodeName(deps, nodeId);
  toggle(deps, prefixes.needsLogin, wanted && seen.detected && seen.state === "NeedsLogin", now, () => ({
    title: `Tailscale on ${name} needs a new sign-in`,
    message:
      "The panel server is signed out of its tailnet, so the panel's tailnet URL does not work. Sign in again in Settings > Tailscale, or run `sudo tailscale up --accept-dns=false` on the server (add --force-reauth after an expired key).",
  }));
  toggle(deps, prefixes.needsApproval, wanted && seen.detected && seen.state === "NeedsMachineAuth", now, () => ({
    title: `Tailscale on ${name} waits for approval`,
    message: "Approve the machine in the Tailscale admin console under Machines. Until then the panel's tailnet URL does not work.",
  }));

  const expiry = seen.keyExpiry;
  if (wanted && seen.detected && expiry !== null && expiry - now <= keyExpiryWarnMs) {
    const key = `${prefixes.keyExpiry}${expiry}`;
    if (deps.alerts.isOpen(key)) return;
    // A new expiry date (signed in again) replaces the warning about the old one.
    deps.alerts.resolve(prefixes.keyExpiry);
    const when = new Date(expiry).toISOString().slice(0, 10);
    deps.alerts.raise({
      event: "node_health_check_failed",
      key,
      title: expiry <= now ? `The Tailscale key of ${name} expired` : `The Tailscale key of ${name} expires on ${when}`,
      message:
        "When the key expires the server drops off the tailnet and the panel's tailnet URL stops working. In the Tailscale admin console, open Machines and choose Disable key expiry for this machine, or sign in again before then.",
      nodeId,
      link: tailscalePage,
    });
  } else {
    deps.alerts.resolve(prefixes.keyExpiry);
  }
}

/** The tailnet path stopped working (after the debounce) or works again. */
export function pathAlert(deps: Pick<Deps, "db" | "alerts">, working: boolean, nodeId: string | null, ipAccess: IpAccessNote, now: number) {
  const name = nodeName(deps, nodeId);
  if (working) {
    deps.alerts.resolve(prefixes.stopped, {
      event: "health_recovered",
      key: `tailnet-recovered:${now}`,
      title: `The panel answers on the tailnet again`,
      nodeId,
      link: tailscalePage,
    });
    return;
  }
  deps.alerts.raise({
    event: "node_health_check_failed",
    key: `${prefixes.stopped}${now}`,
    severity: "error",
    title: `The panel stopped answering on the tailnet`,
    message: `For 5 minutes ${name} has not served the panel on its tailnet: tailscaled stopped, signed out, or the Serve entry is gone.${ipAccessNotes[ipAccess]} Check Settings > Tailscale, or run \`sudo seylo panel tailscale status\` on the server.`,
    nodeId,
    link: tailscalePage,
  });
}

/**
 * The server is signed in to another tailnet than the one Serve was turned
 * on for (`tailnets`), or not any more (null). `ipAccess` is set when the
 * tailnet path stopped working with the move.
 */
export function movedAlert(
  deps: Pick<Deps, "db" | "alerts">,
  tailnets: { from: string; to: string } | null,
  nodeId: string | null,
  ipAccess: IpAccessNote | null,
  now: number,
) {
  if (!tailnets) {
    deps.alerts.resolve(prefixes.moved);
    return;
  }
  if (deps.alerts.isOpen(prefixes.moved)) return;
  const { from, to } = tailnets;
  deps.alerts.raise({
    event: "security_change",
    key: `${prefixes.moved}${now}`,
    severity: "error",
    title: `Tailscale on ${nodeName(deps, nodeId)} moved from the tailnet ${from} to ${to}`,
    message: `Serve was turned on for ${from}, so the panel is not served on ${to} and its Serve entry is removed.${ipAccessNotes[ipAccess ?? "open"]} If you moved the server, turn Serve on again in Settings > Tailscale to serve the panel on ${to}. If not, run \`sudo tailscale logout\` on the server and sign it in to ${from} again.`,
    nodeId,
    link: tailscalePage,
  });
}

/** The server is back on the tailnet Serve was turned on for, or Serve was turned on again for the new one. */
export function resolveMovedAlert(deps: Pick<Deps, "alerts">) {
  deps.alerts.resolve(prefixes.moved);
}

/** Serve was turned on: a new way into the panel, from every device the tailnet's access rules allow. */
export function serveOnAlert(
  ctx: OpContext,
  where: { tailnet: string; url: string | null; previousTailnet: string | null },
  loginName: string | null,
  nodeId: string | null,
) {
  const user = ctx.principal.type === "anonymous" ? null : ctx.principal.user;
  const who = user ? user.name || user.email : "Someone";
  const tailnet = where.tailnet || "its tailnet";
  const before = where.previousTailnet ? ` It was served on ${where.previousTailnet} before.` : "";
  ctx.alerts.raise({
    event: "security_change",
    key: `tailnet-serve-on:${Date.now()}`,
    title: `${who} turned on the panel on the tailnet ${tailnet}`,
    message: `${where.url ?? "The server's tailnet name"} now serves the panel to the devices of ${tailnet}${loginName ? ` (the server is signed in as ${loginName})` : ""}.${before} If this was not ${who}, turn it off in Settings > Tailscale.${ctx.ip ? ` From ${ctx.ip}.` : ""}`,
    nodeId,
    link: tailscalePage,
  });
}
