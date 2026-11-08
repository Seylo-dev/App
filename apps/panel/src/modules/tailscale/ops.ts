// Handlers of the tailscale ops (packages/ops/src/ops/tailscale.ts).
//
// tailscale.get reads what the panel node's agent reported. setServe turns
// the one Serve entry on or off through NodeSettings.tailnet (the agent
// writes it); signIn and setDns call the agent (tailnet.login.v1). Turning
// Serve on, signing in and changing DNS are the owner's, from a browser
// session with a fresh sign-in, over HTTP. Turning Serve off only needs
// settings.manage, unless it would leave a closed panel without a way in.

import { OpError, tailscale } from "@seylo/ops";
import type { TailscaleInfo } from "@seylo/proto";
import { requireFreshSignIn } from "../../auth/fresh";
import { requireSession } from "../../auth/sign-in";
import { implement, type OpContext } from "../../ops/implement";
import { setSetting } from "../../settings";
import { applyPanelIpAccess, readIpAccessApplied, readPanelAccessWanted, writePanelAccessChoice } from "../settings/ip-access";
import { privatePathSources } from "../settings/private-paths";
import { panelIpUrl } from "../settings/public-url";
import { serveOnAlert } from "./alerts";
import { agentReadsTailscale, dnsNameOf, panelNodeFacts, panelNodeId, signedOutStates, versionAtLeast } from "./facts";
import { readServeWanted } from "./keys";
import { rememberSignInLink } from "./sign-in";
import { invalidateTailscale, serveTurnedOff, tailnetPathState } from "./status";
import { tailscaleView } from "./view";

export { tailnetServeCapability } from "./facts";

/** Agent calls that wait on tailscaled: the login waits up to 15 s for its link. */
const agentCallMs = 30_000;

function changeHere(ctx: OpContext, what: string): void {
  if ((ctx.transport ?? "http") !== "http") throw new OpError("FORBIDDEN", `${what} in the panel, not through MCP or the assistant.`);
}

/** The owner, from a browser session that signed in or confirmed it is them in the last 15 minutes. */
function requireOwnerAtBrowser(ctx: OpContext, what: string): void {
  changeHere(ctx, what);
  const { user } = requireSession(ctx);
  if (user.role !== "owner") throw new OpError("FORBIDDEN", `Only the owner can ${what.charAt(0).toLowerCase()}${what.slice(1)}.`);
  requireFreshSignIn(ctx);
}

const blocked = (reason: tailscale.ServeBlockedReason, message: string) => new OpError("CONFLICT", message, { reason });

/** The panel node, online, with an agent that reads Tailscale and found tailscaled. */
function readyServer(ctx: OpContext): { nodeId: string; info: TailscaleInfo } {
  const nodeId = panelNodeId(ctx.db);
  if (!nodeId || !ctx.agents.isOnline(nodeId)) {
    throw blocked("offline", "The panel server's agent is offline. Try again when it is back.");
  }
  const facts = panelNodeFacts(ctx, nodeId);
  if (!agentReadsTailscale(facts)) {
    throw blocked("agentTooOld", "The panel server's agent is too old to serve the panel on a tailnet. Update it under Nodes first.");
  }
  const info = facts?.tailscale;
  if (!info) throw blocked("notInstalled", "Tailscale is not installed on the panel server. Install it first.");
  if (info.disabledOnServer) {
    throw blocked(
      "disabledOnServer",
      "Tailscale is turned off for the panel on the server (no_tailnet in config.yml). Run `sudo seylo panel tailscale on` there first.",
    );
  }
  return { nodeId, info };
}

/** Why Serve cannot be turned on now; nothing when it can. */
function assertCanServe(ctx: OpContext): { nodeId: string; info: TailscaleInfo } {
  const ready = readyServer(ctx);
  const { info } = ready;
  if (!versionAtLeast(info.version, tailscale.minTailscaleVersion)) {
    throw blocked(
      "tooOld",
      `Tailscale ${info.version || "on the server"} is too old. Update it to ${tailscale.minTailscaleVersion} or newer on the panel server.`,
    );
  }
  if (info.backendState === "NeedsMachineAuth") {
    throw blocked("needsApproval", "The server waits for approval. Approve it in the Tailscale admin console under Machines first.");
  }
  if (info.backendState !== "Running") {
    // Starting is signed in already: tailscaled has not reached the tailnet yet, and Sign in would refuse.
    throw blocked(
      "notSignedIn",
      signedOutStates.has(info.backendState)
        ? "The server is not signed in to Tailscale. Sign in first."
        : `Tailscale on the server is signed in but not connected yet (${info.backendState}). Try again once it is.`,
    );
  }
  if (!info.magicDns) {
    throw blocked("magicDnsOff", "MagicDNS is off for this tailnet. Turn it on in the Tailscale admin console under DNS first.");
  }
  return ready;
}

export const getOp = implement(tailscale.get, (_input, ctx) => tailscaleView(ctx));

export const setServe = implement(tailscale.setServe, (input, ctx) => {
  changeHere(ctx, "Change Tailscale Serve");
  const nodeId = panelNodeId(ctx.db);
  const wanted = readServeWanted(ctx.db);

  if (input.serve) {
    requireOwnerAtBrowser(ctx, "Turn on Tailscale Serve");
    const { nodeId: serverId, info } = assertCanServe(ctx);
    const tailnet = info.tailnet;
    const dnsName = dnsNameOf(info);
    ctx.auditDetails?.({ tailnet, dnsName });
    if (!wanted) {
      setSetting(ctx.db, "tailscaleServe", true);
      ctx.agents.desired.markDirty({ nodeId: serverId });
      serveOnAlert(
        ctx,
        { tailnet, url: dnsName ? `${info.https ? "https" : "http"}://${dnsName}` : null },
        info.loginName || null,
        serverId,
      );
      invalidateTailscale(ctx);
    }
    return { tailscale: tailscaleView(ctx), reopenedUrl: null };
  }

  if (!wanted) return { tailscale: tailscaleView(ctx), reopenedUrl: null };
  // A change of IP access that follows is this person's doing, in this op's audit row.
  const by = ctx.principal.type === "anonymous" ? "someone" : ctx.principal.user.email;
  let reopened = false;
  // Turning it off while the tailnet is the only way into a closed panel.
  const applied = readIpAccessApplied(ctx);
  const otherPath = privatePathSources().some((source) => source.kind !== "tailnet" && source.state(ctx).working);
  if (applied.closed && tailnetPathState(ctx).working && !otherPath) {
    if (readPanelAccessWanted(ctx).onFailure === "stayClosed") {
      if (!input.reopenIpAccess) {
        throw new OpError(
          "CONFLICT",
          "The tailnet is the only way into the panel right now and IP access is set to stay closed. Turn Serve off together with reopening IP access, or reopen IP access first in Settings > General.",
          { reason: "stayClosed" },
        );
      }
      // The owner's switch goes back on: IP access does not depend on a path any more.
      writePanelAccessChoice(
        ctx,
        { serveOnIp: true },
        { reason: "Serve on IP address turned on with Tailscale Serve turned off", by, at: Date.now() },
      );
      reopened = true;
    }
  }
  setSetting(ctx.db, "tailscaleServe", false);
  if (nodeId) ctx.agents.desired.markDirty({ nodeId });
  serveTurnedOff(ctx);
  const after = applyPanelIpAccess(ctx, "Tailscale Serve was turned off", { by, resetHold: reopened });
  invalidateTailscale(ctx);
  return { tailscale: tailscaleView(ctx), reopenedUrl: applied.closed && !after.closed ? panelIpUrl(ctx) : null };
});

/** Only http(s) links leave the panel: the web app opens it in a new tab. */
function checkedLink(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString();
  } catch {
    // fall through
  }
  throw new OpError(
    "UNAVAILABLE",
    "Tailscale on the server gave no usable sign-in link. Try again, or run `sudo tailscale up --accept-dns=false` there.",
  );
}

export const signIn = implement(tailscale.signIn, async (_input, ctx) => {
  requireOwnerAtBrowser(ctx, "Sign in to Tailscale");
  const { nodeId, info } = readyServer(ctx);
  if (info.backendState === "NeedsMachineAuth") {
    throw blocked(
      "needsApproval",
      "The server is signed in and waits for approval. Approve it in the Tailscale admin console under Machines.",
    );
  }
  if (!signedOutStates.has(info.backendState)) {
    throw new OpError("CONFLICT", "The server is signed in to Tailscale already.", { reason: "signedIn" });
  }
  const response = await ctx.agents.call(nodeId, "tailscaleLogin", {}, { timeoutMs: agentCallMs });
  if (!response.authUrl) {
    throw new OpError(
      "UNAVAILABLE",
      "Tailscale on the server gave no sign-in link in time. Try again, or run `sudo tailscale up --accept-dns=false` there.",
    );
  }
  const url = checkedLink(response.authUrl);
  const expiresAt = rememberSignInLink(ctx, url);
  invalidateTailscale(ctx);
  return { url, expiresAt: expiresAt.toISOString() };
});

export const setDns = implement(tailscale.setDns, async (input, ctx) => {
  requireOwnerAtBrowser(ctx, "Change Tailscale DNS");
  const { nodeId } = readyServer(ctx);
  const response = await ctx.agents.call(nodeId, "tailscaleSetDns", { acceptDns: input.acceptDns }, { timeoutMs: agentCallMs });
  invalidateTailscale(ctx);
  return tailscaleView(ctx, response.info);
});
