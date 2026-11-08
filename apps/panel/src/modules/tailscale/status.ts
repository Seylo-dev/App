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

import type { NodeFacts } from "@seylo/proto";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { getSetting, setSetting } from "../../settings";
import { applyPanelIpAccess, readIpAccessApplied } from "../settings/ip-access";
import type { PrivatePathState } from "../settings/private-paths";
import { pathAlert, stateAlerts } from "./alerts";
import { agentReadsTailscale, dnsNameOf, keyExpiryMs, panelNodeId, serveStateOf } from "./facts";
import { readSeen, readServeWanted, type TailscaleSeen } from "./keys";
import { forgetSignInLink } from "./sign-in";

/** How long reports that do not work must last before the tailnet path counts as down. */
export const tailnetDownMs = 5 * 60_000;

export const checkJobType = "tailscale.check";

/** The ops whose answers follow tailscaleSeen. */
export const tailscaleViews = ["tailscale.get", "settings.panelAccess"];

export function invalidateTailscale(deps: Pick<Deps, "live">): void {
  deps.live.publish("panel", { type: "invalidate", ops: tailscaleViews });
}

/** The tailnet path's state for the private-path registry, with the debounce applied at read time. */
export function tailnetPathState(deps: Pick<Deps, "db" | "agents">, now = Date.now()): PrivatePathState {
  if (!readServeWanted(deps.db)) return { url: null, working: false, since: null };
  const seen = readSeen(deps.db);
  const url = seen.url || (seen.dnsName ? `${seen.https ? "https" : "http"}://${seen.dnsName}` : null);
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

/** The debounce on one report: `seen` already holds the report's fields. */
function debounce(seen: TailscaleSeen, wanted: boolean, now: number): void {
  if (!wanted) {
    // Turned off on purpose: no grace period.
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
function fromReport(before: TailscaleSeen, facts: NodeFacts, wanted: boolean, now: number): TailscaleSeen {
  const info = facts.tailscale;
  const serveState = serveStateOf(info);
  const panelAnswers = info?.serve?.panelAnswers ?? false;
  return {
    ...before,
    detected: !!info,
    state: info?.backendState ?? "",
    dnsName: dnsNameOf(info),
    tailnet: info?.tailnet ?? "",
    https: info?.https ?? false,
    serveState,
    url: serveState === "active" ? (info?.serve?.url ?? "") : "",
    panelAnswers,
    keyExpiry: keyExpiryMs(info),
    reported: wanted && info?.backendState === "Running" && serveState === "active" && panelAnswers,
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
  const before = readSeen(deps.db);
  const next = fromReport(before, facts, wanted, now);
  debounce(next, wanted, now);
  save(deps, before, next, wanted, now);
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
  stateAlerts(deps, next, wanted, nodeId, now);
  if (before.working !== next.working) pathChanged(deps, next.working, nodeId, now, options.applyIpAccess ?? true);
  if (changed) invalidateTailscale(deps);
}

function pathChanged(deps: Deps, working: boolean, nodeId: string | null, now: number, applyIpAccess: boolean): void {
  const closedBefore = readIpAccessApplied(deps).closed;
  const after = applyIpAccess
    ? applyPanelIpAccess(deps, working ? "the tailnet works" : "the tailnet stopped working")
    : readIpAccessApplied(deps);
  if (!readServeWanted(deps.db)) return;
  const ipAccess = closedBefore && !after.closed ? "reopened" : after.closed ? "staysClosed" : "open";
  pathAlert(deps, working, nodeId, working ? "open" : ipAccess, now);
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
