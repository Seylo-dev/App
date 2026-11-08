// Handlers of the tailscale ops (packages/ops/src/ops/tailscale.ts).
//
// Not built yet (WP-F3b): tailscale.get reports Tailscale as not detected
// (no agent reports it before 0.2.1) and the three changes answer
// NOT_IMPLEMENTED.

import { tailscale } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement, notImplemented, type OpContext } from "../../ops/implement";

/** Advertised by agents that report TailscaleInfo and keep the Serve entry (no methods). */
export const tailnetServeCapability = "tailnet.serve.v1";

function panelNodeId(deps: Pick<Deps, "db">): string | null {
  return deps.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get()?.id ?? null;
}

/** tailscale.get while nothing reads Tailscale yet. */
export function notDetected(ctx: OpContext): tailscale.TailscaleStatus {
  const nodeId = panelNodeId(ctx);
  return {
    detected: false,
    agentOnline: nodeId !== null && ctx.agents.isOnline(nodeId),
    agentSupported: nodeId !== null && (ctx.agents.capabilities(nodeId)?.has(tailnetServeCapability) ?? false),
    version: null,
    minVersion: tailscale.minTailscaleVersion,
    versionOk: false,
    backendState: null,
    tailnet: null,
    dnsName: null,
    addresses: [],
    loginName: null,
    tags: [],
    magicDns: false,
    https: false,
    acceptDns: false,
    exitNodeInUse: false,
    advertisesRoutes: false,
    keyExpiry: null,
    disabledOnServer: false,
    serve: { wanted: false, state: "off", url: null, message: "", panelAnswers: false },
    owned: null,
    viaTailnet: ctx.via === "tailnet",
    canManage: ctx.principal.type === "session" && ctx.principal.user.role === "owner" && (ctx.transport ?? "http") === "http",
    installCommand: tailscale.tailscaleInstallCommand,
    grantSnippet: "",
    signInUrl: null,
  };
}

export const getOp = implement(tailscale.get, (_input, ctx) => notDetected(ctx));

export const setServe = notImplemented(tailscale.setServe);

export const signIn = notImplemented(tailscale.signIn);

export const setDns = notImplemented(tailscale.setDns);
