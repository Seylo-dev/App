// settings.panelAccess and settings.updatePanelAccess (added in 0.2.1):
// the Panel domain card's "Serve on IP address" and "Agents' port"
// switches and "If the domain stops working". The decision itself is
// applyPanelIpAccess (ip-access.ts); the ways in that keep working are
// private-paths.ts.
//
// Turning anything off is guarded: the owner, in a browser session (not
// an API key, MCP or the assistant), signed in or confirmed in the last 15
// minutes, over a private path that works right now, with the panel
// node's agent online and able to bind 127.0.0.1, no update running, and
// no enabled node that would be cut off (plain http:// nodes; for the
// agents' port, nodes that do not dial the domain). "Keep it closed" also
// needs the tick that the recovery commands are saved. Turning things back
// on needs settings.manage over HTTP and is always allowed.

import { OpError, settings } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { dialingNodes, dialsDomain, dialsPlainHttp } from "../../agent-hub/dialed";
import { requireFreshSignIn } from "../../auth/fresh";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { implement, type OpContext } from "../../ops/implement";
import { getSetting } from "../../settings";
import { nodeAddress, privateIpv4Of } from "../domains/lookup";
import { readDomainStatus } from "./domain";
import {
  actualIpAccess,
  agentPortOf,
  applyPanelIpAccess,
  decidePanelIpAccess,
  ipAccessOnCommand,
  panelNodeOldDocker,
  panelNodeState,
  panelPortOf,
  readIpAccessApplied,
  readPanelAccessWanted,
  updateRunning,
  writePanelAccessChoice,
} from "./ip-access";
import { listPrivatePaths, provingPrivatePath } from "./private-paths";

type Block = settings.PanelAccessBlock;

const names = (list: readonly { name: string }[]) =>
  list.length <= 2
    ? list.map((n) => n.name).join(" and ")
    : `${list
        .slice(0, -1)
        .map((n) => n.name)
        .join(", ")} and ${list.at(-1)?.name}`;

/** Where the panel's server is, for the SSH tunnel and messages: never bracketed (ssh takes IPv6 as it is). */
function panelServer(deps: Pick<Deps, "db">): string | null {
  const row = deps.db
    .select({ publicAddress: nodes.publicAddress, ipv4: nodes.publicIpv4, ipv6: nodes.publicIpv6, facts: nodes.facts })
    .from(nodes)
    .where(eq(nodes.isPanelNode, true))
    .get();
  if (!row) return null;
  return row.publicAddress || row.ipv4 || row.ipv6 || privateIpv4Of(row.facts) || null;
}

/** "http://203.0.113.10:3000": the address IP access is about. */
function ipUrl(deps: Pick<Deps, "db" | "config">): string {
  const server = panelServer(deps);
  return `http://${server ? (nodeAddress({ publicAddress: server }) ?? server) : "<server-ip>"}:${panelPortOf(deps)}`;
}

/** The refusals that come from who is asking and how. */
function callerBlocks(ctx: OpContext): Block[] {
  if ((ctx.transport ?? "http") !== "http" || ctx.principal.type !== "session") {
    return [
      {
        code: "notBrowserSession",
        message: "Only from a browser signed in to the panel. API keys, MCP and the assistant cannot turn this off.",
      },
    ];
  }
  if (ctx.principal.user.role !== "owner") return [{ code: "notOwner", message: "Only the owner can turn this off." }];
  return [];
}

/** Everything that refuses closing IP access right now, for this caller. */
export function closeBlocks(ctx: OpContext): Block[] {
  const out = callerBlocks(ctx);
  const paths = listPrivatePaths(ctx, ctx);
  const working = paths.filter((path) => path.working);
  if (working.length === 0) {
    const domain = getSetting(ctx.db, "panelDomain") ?? null;
    const status = readDomainStatus(ctx);
    out.push({
      code: "noPrivatePath",
      message: domain
        ? `The panel domain ${domain} is not active yet${status.message ? ` (${status.message.replace(/\.$/, "")})` : ""}. Turn this off once it shows Active.`
        : "Set a panel domain and wait until it shows Active, or serve the panel on your tailnet (Settings > Tailscale).",
    });
  } else if (!provingPrivatePath(ctx)) {
    out.push({
      code: "notOnPrivatePath",
      message: `You opened the panel on ${ctx.origin ?? ipUrl(ctx)}. Open ${working[0]?.url} and sign in there, then turn this off from that page.`,
    });
  }
  const panel = panelNodeState(ctx);
  if (!panel.managed) {
    out.push({
      code: "panelNotManaged",
      message:
        "This panel does not run as a service of its node's agent (a development or hand-started panel), so its port cannot be closed from here.",
    });
  } else if (!panel.online) {
    out.push({ code: "panelNodeOffline", message: "The panel node's agent is offline. Try again once it is back." });
  } else if (!panel.capable) {
    out.push({
      code: "agentTooOld",
      message: "The panel node's agent is too old to publish the panel on 127.0.0.1 only. Update it in Settings > Updates first.",
    });
  }
  if (updateRunning(ctx)) out.push({ code: "updateRunning", message: "An update is running. Try again once it finished." });
  const dialing = dialingNodes(ctx);
  const plain = dialing.filter((node) => dialsPlainHttp(node.url));
  if (plain.length > 0) {
    const one = plain.length === 1 ? plain[0] : undefined;
    out.push({
      code: "plainHttpNodes",
      message: one
        ? `${one.name} connects over ${one.url} - run the https join command from Nodes > Add node on it, with --force.`
        : `${names(plain)} connect over plain http:// - run the https join command from Nodes > Add node on each, with --force.`,
      nodeIds: plain.map((node) => node.id),
    });
  }
  const unseen = dialing.filter((node) => node.url === null);
  if (unseen.length > 0) {
    const one = unseen.length === 1;
    out.push({
      code: "plainHttpNodes",
      message: `${names(unseen)} ${one ? "has" : "have"} not connected since the panel was updated, so the panel cannot tell how ${one ? "it connects" : "they connect"}. Bring ${one ? "it" : "them"} online once, or disable ${one ? "it" : "them"} under Nodes.`,
      nodeIds: unseen.map((node) => node.id),
    });
  }
  return out;
}

/** Everything that refuses closing the agents' port right now: what closeBlocks says, plus nodes that still need the port. */
export function agentPortBlocks(ctx: OpContext): Block[] {
  const out = closeBlocks(ctx);
  if (agentPortOf(ctx) === null) {
    out.push({ code: "noAgentPort", message: "The panel has no agents' port (it was installed with --agent-tls-port 0)." });
    return out;
  }
  const domain = getSetting(ctx.db, "panelDomain") ?? null;
  const off = dialingNodes(ctx).filter((node) => !dialsDomain(node.url, domain));
  if (off.length > 0) {
    const what = off.map((node) => `${node.name} (${node.url ?? "not connected yet"})`);
    const listed = what.length <= 2 ? what.join(" and ") : `${what.slice(0, -1).join(", ")} and ${what.at(-1)}`;
    out.push({
      code: "nodesOnAgentPort",
      message: `${listed} ${off.length === 1 ? "does" : "do"} not connect over ${domain ? `https://${domain}` : "a panel domain"} yet. ${
        domain
          ? "Nodes move to the domain by themselves while it is active; wait until every node connects over it."
          : "Nodes move to the panel domain by themselves once it is active."
      }`,
      nodeIds: off.map((node) => node.id),
    });
  }
  return out;
}

/** settings.panelAccess for this caller. */
export function panelAccessView(ctx: OpContext): settings.PanelAccess {
  const wanted = readPanelAccessWanted(ctx);
  const applied = readIpAccessApplied(ctx);
  const panelPort = panelPortOf(ctx);
  const panel = panelNodeState(ctx);
  const decision = panel.online ? decidePanelIpAccess(ctx) : null;
  const reclosesAt = decision?.reclosesAt ?? null;
  const server = panelServer(ctx);
  return {
    serveOnIp: wanted.serveOnIp,
    agentPortOpen: wanted.agentPortOpen,
    onFailure: wanted.onFailure,
    panelPort,
    agentPort: agentPortOf(ctx),
    actual: actualIpAccess(ctx),
    privatePaths: listPrivatePaths(ctx, ctx),
    blocked: closeBlocks(ctx),
    agentPortBlocked: agentPortBlocks(ctx),
    reclosesAt: reclosesAt === null ? null : new Date(reclosesAt).toISOString(),
    openReason: !wanted.serveOnIp && decision && !decision.closed ? decision.why : null,
    oldDocker: panelNodeOldDocker(ctx),
    lastChange: applied.at > 0 ? { at: new Date(applied.at).toISOString(), reason: applied.reason, by: applied.by ?? "system" } : null,
    recovery: {
      sshTunnel: `ssh -L 3000:127.0.0.1:${panelPort} root@${server ?? "<server-ip>"}`,
      cli: ipAccessOnCommand,
    },
  };
}

export const panelAccessOp = implement(settings.panelAccess, (_input, ctx) => panelAccessView(ctx));

function refuse(block: Block): never {
  throw new OpError("CONFLICT", block.message, {
    reason: block.code,
    ...(block.nodeIds?.length ? { nodeIds: block.nodeIds.join(",") } : {}),
  });
}

export const updatePanelAccess = implement(settings.updatePanelAccess, (input, ctx) => {
  const fromModel = (ctx.transport ?? "http") !== "http" || (ctx.principal.type === "apiKey" && ctx.principal.keyKind === "mcp");
  const turnsOff = input.serveOnIp === false || input.agentPortOpen === false;
  const keepsClosed = input.onFailure === "stayClosed";
  if (turnsOff || keepsClosed) {
    const caller = callerBlocks(ctx)[0];
    if (caller) refuse(caller);
    const blocks = input.agentPortOpen === false ? agentPortBlocks(ctx) : turnsOff ? closeBlocks(ctx) : [];
    if (blocks[0]) refuse(blocks[0]);
    if (keepsClosed && input.savedRecovery !== true) {
      throw new OpError("BAD_REQUEST", "Save the recovery commands first and tick that you did.", { field: "savedRecovery" });
    }
    requireFreshSignIn(ctx);
  } else if (fromModel) {
    throw new OpError("FORBIDDEN", "Change panel access in the panel, not through MCP or the assistant.");
  }

  const before = readPanelAccessWanted(ctx);
  const parts: string[] = [];
  if (input.serveOnIp !== undefined && input.serveOnIp !== before.serveOnIp) {
    parts.push(`Serve on IP address turned ${input.serveOnIp ? "on" : "off"}`);
  }
  if (input.agentPortOpen !== undefined && input.agentPortOpen !== before.agentPortOpen) {
    parts.push(`the agents' port turned ${input.agentPortOpen ? "on" : "off"}`);
  }
  if (input.onFailure !== undefined && input.onFailure !== before.onFailure) {
    parts.push(
      input.onFailure === "stayClosed"
        ? "set to keep IP access closed if the private path stops working"
        : "set to reopen IP access if the private path stops working",
    );
  }
  const reason = `${parts.length ? parts.join(", ") : "saved again"} in Settings`;
  const by = ctx.principal.type === "anonymous" ? "someone" : ctx.principal.user.email;
  writePanelAccessChoice(
    ctx,
    {
      ...(input.serveOnIp !== undefined ? { serveOnIp: input.serveOnIp } : {}),
      ...(input.agentPortOpen !== undefined ? { agentPortOpen: input.agentPortOpen } : {}),
      ...(input.onFailure !== undefined ? { onFailure: input.onFailure } : {}),
    },
    { reason, by, at: Date.now() },
  );
  // Only a turn-off went through the close guards, so only it skips the hour after an automatic
  // reopen. A turn-on, or a choice made past the guards, retries a roll that failed.
  const turnsOn = input.serveOnIp === true || input.agentPortOpen === true;
  const applied = applyPanelIpAccess(ctx, reason, { by, closeNow: turnsOff, resetHold: turnsOn || keepsClosed });
  ctx.auditDetails?.({ applied: { closed: applied.closed, agentPortClosed: applied.agentPortClosed } });
  ctx.live.publish("panel", { type: "invalidate", ops: ["settings.panelAccess"] });
  return panelAccessView(ctx);
});
