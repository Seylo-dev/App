// tailscale.get's answer (TailscaleStatus) from the panel node's facts, the
// tailscaleServe setting and the caller.

import { tailscale } from "@seylo/ops";
import type { TailscaleInfo } from "@seylo/proto";
import type { OpContext } from "../../ops/implement";
import { agentReadsTailscale, dnsNameOf, keyExpiryMs, panelNodeFacts, panelNodeId, serveStateOf, versionAtLeast } from "./facts";
import { readServeWanted } from "./keys";
import { freshSignInLink } from "./sign-in";

/** The owner, from a browser session, over HTTP: who may turn Serve on, sign in and change DNS. */
export function canManageTailscale(ctx: OpContext): boolean {
  return ctx.principal.type === "session" && ctx.principal.user.role === "owner" && (ctx.transport ?? "http") === "http";
}

/**
 * An access rule for the tailnet policy file that lets only the server's
 * owner reach the panel's port on this machine, instead of the default
 * allow-all. Tagged machines have no owner login: tailnet admins then.
 */
export function grantSnippet(info: TailscaleInfo | undefined): string {
  if (!info || !dnsNameOf(info)) return "";
  const ip = info.addresses.find((address) => address.startsWith("100.")) ?? info.addresses[0];
  const dst = ip ? [ip] : info.tags;
  if (dst.length === 0) return "";
  const src = info.loginName ? [info.loginName] : ["autogroup:admin"];
  return JSON.stringify({ grants: [{ src, dst, ip: [info.https ? "tcp:443" : "tcp:80"] }] }, null, 2);
}

/** The exact Serve entry the agent keeps: <host>:<443|80>, path "/", its unix target. */
function ownedEntry(info: TailscaleInfo | undefined): tailscale.TailscaleStatus["owned"] {
  const proxy = info?.serve?.proxy ?? "";
  if (!info || !proxy) return null;
  let host = dnsNameOf(info);
  let https = info.https;
  const url = info.serve?.url ?? "";
  if (url) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      https = parsed.protocol === "https:";
    } catch {
      // A malformed URL from the agent: fall back to the machine's name.
    }
  }
  if (!host) return null;
  return { hostPort: `${host}:${https ? 443 : 80}`, path: "/", proxy };
}

/** TailscaleStatus for this caller. `info` replaces the facts' TailscaleInfo (an agent call just answered with a newer one). */
export function tailscaleView(ctx: OpContext, info?: TailscaleInfo): tailscale.TailscaleStatus {
  const nodeId = panelNodeId(ctx.db);
  const facts = panelNodeFacts(ctx, nodeId);
  const supported = agentReadsTailscale(facts);
  const current = info ?? (supported ? facts?.tailscale : undefined);
  const canManage = canManageTailscale(ctx);
  const serveState = serveStateOf(current);
  const expiry = keyExpiryMs(current);
  return {
    detected: !!current,
    agentOnline: nodeId !== null && ctx.agents.isOnline(nodeId),
    agentSupported: supported,
    version: current?.version || null,
    minVersion: tailscale.minTailscaleVersion,
    versionOk: versionAtLeast(current?.version, tailscale.minTailscaleVersion),
    backendState: current?.backendState || null,
    tailnet: current?.tailnet || null,
    dnsName: dnsNameOf(current) || null,
    addresses: current?.addresses ?? [],
    loginName: current?.loginName || null,
    tags: current?.tags ?? [],
    magicDns: current?.magicDns ?? false,
    https: current?.https ?? false,
    acceptDns: current?.acceptDns ?? false,
    exitNodeInUse: current?.exitNodeInUse ?? false,
    advertisesRoutes: current?.advertisesRoutes ?? false,
    keyExpiry: expiry === null ? null : new Date(expiry).toISOString(),
    disabledOnServer: current?.disabledOnServer ?? false,
    serve: {
      wanted: readServeWanted(ctx.db),
      state: serveState,
      url: serveState === "active" ? current?.serve?.url || null : null,
      message: current?.serve?.message ?? "",
      panelAnswers: current?.serve?.panelAnswers ?? false,
    },
    owned: ownedEntry(current),
    viaTailnet: ctx.via === "tailnet",
    canManage,
    installCommand: tailscale.tailscaleInstallCommand,
    grantSnippet: grantSnippet(current),
    signInUrl: canManage ? (freshSignInLink(ctx)?.url ?? null) : null,
  };
}
