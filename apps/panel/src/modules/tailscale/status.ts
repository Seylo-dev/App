// What the panel last heard about Tailscale on its own server, kept in the
// tailscaleSeen setting so it survives a panel restart, and the tailnet
// path's debounce.
//
// Every NodeFacts of the panel node from an agent that reads Tailscale
// (tailnet.serve.v1) is an explicit report: a missing TailscaleInfo means
// the agent found no tailscaled socket. A report "works" when Serve is
// wanted, tailscaled is Running, the Serve entry is active and the agent's
// last request through the panel's socket answered. The path stops working
// only after 5 minutes of reports that do not work from an online agent; a
// disconnect restarts that clock and an offline agent flips nothing. Turning
// Serve off stops the path at once (ops.ts). Each change of the path asks
// applyPanelIpAccess again (settings/ip-access.ts) and raises or resolves the
// tailnet-stopped alert.
//
// Serve is pinned to the tailnet it was turned on for (tailscaleServeTailnet).
// A report from another tailnet never works and stops the path at once: the
// panel node's desired state drops tailnet.panel (index.ts), so the agent
// removes the entry, the listener answers nothing (facts.ts tailnetIdentity)
// and the tailnet-moved alert names both tailnets. Only the owner turning
// Serve on again for the new tailnet serves the panel there.

import type { NodeFacts } from "@seylo/proto";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { getSetting, setSetting } from "../../settings";
import { applyPanelIpAccess, readIpAccessApplied } from "../settings/ip-access";
import type { PrivatePathState } from "../settings/private-paths";
import { type IpAccessNote, movedAlert, pathAlert, stateAlerts } from "./alerts";
import {
  agentReadsTailscale,
  dnsNameOf,
  keyExpiryMs,
  onOtherTailnet,
  panelNodeId,
  servedTailnetMoved,
  serveStateOf,
  tailnetLabel,
} from "./facts";
import { readSeen, readServeTailnet, readServeWanted, type ServeTailnet, type TailscaleSeen } from "./keys";
import { forgetSignInLink } from "./sign-in";

/** How long reports that do not work must last before the tailnet path counts as down. */
export const tailnetDownMs = 5 * 60_000;

export const checkJobType = "tailscale.check";

/** The ops whose answers follow tailscaleSeen. */
export const tailscaleViews = ["tailscale.get", "settings.panelAccess"];

export function invalidateTailscale(deps: Pick<Deps, "live">): void {
  deps.live.publish("panel", { type: "invalidate", ops: tailscaleViews });
}

/** The last report came from another tailnet than the one Serve was turned on for (false while Serve is off). */
export function seenOnOtherTailnet(deps: Pick<Deps, "db">, seen: TailscaleSeen = readSeen(deps.db)): boolean {
  return servedTailnetMoved(deps.db, seen.tailnet, seen.dnsName);
}

/** The tailnet path's state for the private-path registry, with the debounce applied at read time. */
export function tailnetPathState(deps: Pick<Deps, "db" | "agents">, now = Date.now()): PrivatePathState {
  if (!readServeWanted(deps.db)) return { url: null, working: false, since: null };
  const seen = readSeen(deps.db);
  const scheme = seen.https ? "https" : "http";
  if (seenOnOtherTailnet(deps, seen)) {
    // Not served on that tailnet, so no way in: the address is the one Serve was turned on for.
    const approved = readServeTailnet(deps.db)?.dnsName;
    return {
      url: approved ? `${scheme}://${approved}` : null,
      working: false,
      since: seen.stoppedAt === null ? null : new Date(seen.stoppedAt),
    };
  }
  const url = seen.url || (seen.dnsName ? `${scheme}://${seen.dnsName}` : null);
  if (seen.working && downLongEnough(deps, seen, now)) {
    return { url, working: false, since: new Date((seen.downSince as number) + tailnetDownMs) };
  }
  const since = seen.working ? seen.workingSince : seen.stoppedAt;
  return { url, working: seen.working, since: since === null ? null : new Date(since) };
}

/** The debounce ran out, judged only while the panel node's agent is online. */
function downLongEnough(deps: Pick<Deps, "db" | "agents">, seen: TailscaleSeen, now: number): boolean {
  if (seen.downSince === null || now - seen.downSince < tailnetDownMs) return false;
  const nodeId = panelNodeId(deps.db);
  return nodeId !== null && deps.agents.isOnline(nodeId);
}

function stop(seen: TailscaleSeen, now: number): void {
  seen.working = false;
  seen.workingSince = null;
  seen.stoppedAt = now;
  seen.downSince = null;
}

/** The debounce on one report: `seen` already holds the report's fields. `serves` is false when nothing is served. */
function debounce(seen: TailscaleSeen, serves: boolean, now: number): void {
  if (!serves) {
    // Turned off on purpose, or on another tailnet: no grace period.
    if (seen.working) stop(seen, now);
    seen.downSince = null;
    return;
  }
  if (seen.reported) {
    seen.downSince = null;
    if (!seen.working) {
      seen.working = true;
      seen.workingSince = now;
    }
    return;
  }
  if (!seen.working) {
    seen.downSince = null;
    return;
  }
  seen.downSince ??= now;
  if (now - seen.downSince >= tailnetDownMs) stop(seen, now);
}

/** The fields one report sets, before the debounce. */
function fromReport(before: TailscaleSeen, facts: NodeFacts, wanted: boolean, approved: ServeTailnet | null, now: number): TailscaleSeen {
  const info = facts.tailscale;
  const serveState = serveStateOf(info);
  const panelAnswers = info?.serve?.panelAnswers ?? false;
  const dnsName = dnsNameOf(info);
  const tailnet = info?.tailnet ?? "";
  return {
    ...before,
    detected: !!info,
    state: info?.backendState ?? "",
    dnsName,
    tailnet,
    https: info?.https ?? false,
    serveState,
    url: serveState === "active" ? (info?.serve?.url ?? "") : "",
    panelAnswers,
    keyExpiry: keyExpiryMs(info),
    reported:
      wanted && !onOtherTailnet(approved, tailnet, dnsName) && info?.backendState === "Running" && serveState === "active" && panelAnswers,
    checkedAt: now,
  };
}

/** The fields people see, to skip invalidations when only checkedAt moved. */
const visible = (seen: TailscaleSeen) => JSON.stringify({ ...seen, checkedAt: 0 });

/**
 * Records a NodeFacts of the panel node. Reports from agents that do not
 * read Tailscale are ignored: they say nothing about tailscaled.
 */
export function recordReport(deps: Deps, facts: NodeFacts, now = Date.now()): void {
  if (!agentReadsTailscale(facts)) return;
  const wanted = readServeWanted(deps.db);
  if (wanted) pinFirstTailnet(deps, facts);
  const before = readSeen(deps.db);
  const next = fromReport(before, facts, wanted, readServeTailnet(deps.db), now);
  debounce(next, wanted && !seenOnOtherTailnet(deps, next), now);
  save(deps, before, next, wanted, now);
}

/** Serve turned on by an early 0.2.1 build that kept no tailnet: the first one the server reports is it. */
function pinFirstTailnet(deps: Deps, facts: NodeFacts): void {
  const info = facts.tailscale;
  if (readServeTailnet(deps.db) || info?.backendState !== "Running" || !info.tailnet) return;
  setSetting(deps.db, "tailscaleServeTailnet", { tailnet: info.tailnet, dnsName: dnsNameOf(info) });
}

/**
 * The 1-minute job: ends the debounce when no new report came (facts are
 * sent only when they change) and keeps the key expiry warning current.
 */
export function settle(deps: Deps, now = Date.now()): void {
  const before = readSeen(deps.db);
  const next = { ...before };
  if (next.working && downLongEnough(deps, next, now)) stop(next, now);
  save(deps, before, next, readServeWanted(deps.db), now);
}

/**
 * Saves the stop only when the 5 minutes ran out and no job saved it yet
 * (the private path's settle, which applyPanelIpAccess runs before it
 * decides). Otherwise nothing: no alerts, no writes.
 */
export function settleRunOut(deps: Deps, now = Date.now()): void {
  const seen = readSeen(deps.db);
  if (seen.working && downLongEnough(deps, seen, now)) settle(deps, now);
}

/** The panel node's agent disconnected: an agent restart must not count toward the 5 minutes. */
export function agentDisconnected(deps: Deps): void {
  const seen = getSetting(deps.db, "tailscaleSeen");
  if (seen?.downSince == null) return;
  setSetting(deps.db, "tailscaleSeen", { ...seen, downSince: null });
}

/** Serve was turned off by the owner: the path stops now. */
export function serveTurnedOff(deps: Deps, now = Date.now()): void {
  const before = readSeen(deps.db);
  const next = { ...before, reported: false };
  debounce(next, false, now);
  save(deps, before, next, false, now, { applyIpAccess: false });
}

function save(
  deps: Deps,
  before: TailscaleSeen,
  next: TailscaleSeen,
  wanted: boolean,
  now: number,
  options: { applyIpAccess?: boolean } = {},
): void {
  const changed = visible(before) !== visible(next);
  if (changed || before.checkedAt !== next.checkedAt) setSetting(deps.db, "tailscaleSeen", next);
  if (next.detected && next.state === "Running") forgetSignInLink(deps);
  const nodeId = panelNodeId(deps.db);
  const approved = readServeTailnet(deps.db);
  const moved = wanted && onOtherTailnet(approved, next.tailnet, next.dnsName);
  const wasMoved = wanted && onOtherTailnet(approved, before.tailnet, before.dnsName);
  stateAlerts(deps, next, wanted, nodeId, now);
  const ipAccess =
    before.working !== next.working ? pathChanged(deps, next.working, nodeId, now, options.applyIpAccess ?? true, moved) : null;
  const tailnets =
    moved && approved ? { from: tailnetLabel(approved.tailnet, approved.dnsName), to: tailnetLabel(next.tailnet, next.dnsName) } : null;
  movedAlert(deps, tailnets, nodeId, ipAccess, now);
  // The panel node's desired state drops tailnet.panel on another tailnet and brings it back on this one (index.ts).
  if (nodeId && moved !== wasMoved) deps.agents.desired.markDirty({ nodeId });
  if (changed) invalidateTailscale(deps);
}

/** Asks for IP access again and alerts; returns what happened to IP access when the path stopped. */
function pathChanged(
  deps: Deps,
  working: boolean,
  nodeId: string | null,
  now: number,
  applyIpAccess: boolean,
  moved: boolean,
): IpAccessNote | null {
  const closedBefore = readIpAccessApplied(deps).closed;
  const reason = working ? "the tailnet works" : moved ? "the panel server is on another tailnet" : "the tailnet stopped working";
  const after = applyIpAccess ? applyPanelIpAccess(deps, reason) : readIpAccessApplied(deps);
  if (!readServeWanted(deps.db)) return null;
  if (working) {
    pathAlert(deps, true, nodeId, "open", now);
    return null;
  }
  const ipAccess: IpAccessNote = closedBefore && !after.closed ? "reopened" : after.closed ? "staysClosed" : "open";
  // A move has its own alert, which says this as well.
  if (!moved) pathAlert(deps, false, nodeId, ipAccess, now);
  return ipAccess;
}

/** Wires the reports, the disconnects and the 1-minute job (the module's start()). */
export function watchTailscale(deps: Deps): void {
  deps.agents.state.onChange((nodeId, change) => {
    if (change.kind !== "facts" || nodeId !== panelNodeId(deps.db)) return;
    const facts = deps.agents.state.get(nodeId)?.facts;
    if (!facts) return;
    try {
      recordReport(deps, facts);
    } catch (error) {
      deps.logger.error({ err: error, nodeId }, "recording the panel node's Tailscale state failed");
    }
  });
  deps.agents.onConnection((nodeId, online) => {
    if (online || nodeId !== panelNodeId(deps.db)) return;
    agentDisconnected(deps);
    invalidateTailscale(deps);
  });
  deps.schedules.ensure({ key: checkJobType, jobType: checkJobType, intervalSeconds: 60, missedRun: "skip" });
}

export const checkJob = defineJob<Record<string, never>>({
  type: checkJobType,
  maxAttempts: 1,
  async run(_payload, ctx) {
    settle(ctx);
  },
});
