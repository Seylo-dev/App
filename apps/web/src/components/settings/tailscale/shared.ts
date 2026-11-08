// Shared bits of Settings > Tailscale: the status type, the admin console
// links, the commands people run on the server, and why Serve cannot be
// turned on right now (the panel answers the same reasons as CONFLICT).

import { slug } from "@seylo/brand";
import type { tailscale } from "@seylo/ops";

export type TailscaleStatus = tailscale.TailscaleStatus;

export const adminConsole = {
  machines: "https://login.tailscale.com/admin/machines",
  dns: "https://login.tailscale.com/admin/dns",
  acls: "https://login.tailscale.com/admin/acls/file",
} as const;

export const commands = {
  signIn: "sudo tailscale up --accept-dns=false",
  allowOnServer: `sudo ${slug} panel tailscale on`,
  status: `sudo ${slug} panel tailscale status`,
} as const;

/** tailscaled still has to sign in (no BackendState counts as signed out too). */
export function isSignedOut(status: Pick<TailscaleStatus, "backendState">): boolean {
  return !status.backendState || ["NoState", "NeedsLogin", "Stopped"].includes(status.backendState);
}

/** Why tailscale.setServe would refuse to turn Serve on, in the order the panel checks; null when it can. */
export function serveBlockedReason(status: TailscaleStatus): tailscale.ServeBlockedReason | null {
  if (!status.agentOnline) return "offline";
  if (!status.agentSupported) return "agentTooOld";
  if (!status.detected) return "notInstalled";
  if (status.disabledOnServer) return "disabledOnServer";
  if (!status.versionOk) return "tooOld";
  if (status.backendState === "NeedsMachineAuth") return "needsApproval";
  if (status.backendState !== "Running") return "notSignedIn";
  if (!status.magicDns) return "magicDnsOff";
  return null;
}

/** The node sheet's Shell view of the panel node with the install command typed in (node-shell.tsx). */
export function installShellSearch(panelNodeId: string) {
  return { node: panelNodeId, view: "shell" as const, prefill: "tailscale-install" as const };
}
