// IP access (added in 0.2.1): whether the panel port and the agents' TLS
// port answer from outside the server, or only on 127.0.0.1 while a private
// path (private-paths.ts) keeps the panel reachable. applyPanelIpAccess is
// the one place that decides it and rolls the panel when the answer
// changes; everything that changes an input calls it (a switch, the
// domain, a private path's state, the panel node's agent connecting, a
// failed roll, the 1-minute job).
//
// The rule (decidePanelIpAccess):
//   closed = !serveOnIp && the panel node's agent can bind 127.0.0.1
//            && it dials no plain http:// address but loopback
//            && (a private path works || (stayClosed && already closed))
//   agentPortClosed = closed && !agentPortOpen
//            && every enabled node but the panel node dials https://<domain>
//            && the panel node dials loopback or https://<domain>
// It fails open: a missing capability, a panel not run by its agent, no
// working path (in "reopen" mode) and a failed roll all leave or put the
// port open. After an automatic reopen it closes again only once a path
// has worked for an hour (anti-flap). An offline or restarting agent
// flips nothing: nothing could apply the change, and its next connect
// runs this again. Nothing changes during an update run either: the
// panel step swaps the container itself.

import { slug } from "@seylo/brand";
import type { settings as settingOps } from "@seylo/ops";
import { DeployStage } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { type DialingNode, dialingNodes, dialsDomain, dialsLoopback, dialsPlainHttp, panelNodeDialing } from "../../agent-hub/dialed";
import { auditLog, nodes, servicePlacements, updateRuns } from "../../db/schema";
import type { Deps } from "../../deps";
import { getSetting, setSetting } from "../../settings";
import { bumpPanelGeneration, panelContainerPort, panelServiceId } from "../nodes/panel-service";
import { type PrivatePathState, privatePathSources } from "./private-paths";

/** What the panel node was last told to apply. Absent: open, as in 0.2.0. */
export interface PanelIpAccessApplied {
  /** The panel port is published on 127.0.0.1 only. */
  closed: boolean;
  /** The agents' TLS port is published on 127.0.0.1 only (only ever while closed). */
  agentPortClosed: boolean;
  /** Epoch milliseconds of the change. */
  at: number;
  /** Why, in words for the card and the audit row ("the panel domain stopped working"). */
  reason: string;
  /** "system" for automatic changes, else who made it (an email, "the server's command line"). */
  by?: string;
  /** The panel service generation sent with this change; the agent applied it once the panel runs it. */
  generation?: number;
  /** What was applied before this change: what the agent restores when the roll fails. */
  from?: { closed: boolean; agentPortClosed: boolean };
  /** Set by an automatic reopen (epoch ms): closing again waits until a path worked for an hour after it. */
  reopenedAt?: number;
  /** After a failed roll (epoch ms): no automatic change before then, so a broken roll is not retried every minute. */
  holdUntil?: number;
}

declare module "../../settings" {
  interface SettingValues {
    /** "Serve on IP address"; absent means true. */
    panelServeOnIp: boolean;
    /** "Agents' port"; absent means true. */
    panelAgentPortOpen: boolean;
    /** Absent means "reopen". */
    panelIpAccessOnFailure: settingOps.PanelAccessOnFailure;
    panelIpAccessApplied: PanelIpAccessApplied;
    /** Who last changed the switches and why: the reason of a change that follows them, also when it applies later (the agent was offline). */
    panelAccessChoice: PanelAccessChoice;
  }
}

export interface PanelAccessChoice {
  /** "turned off in Settings", "reopened from the server's command line (...)". */
  reason: string;
  /** An email, "the server's command line" or "system". */
  by: string;
  at: number;
}

/** Saves the switches someone chose, with who and why. */
export function writePanelAccessChoice(
  deps: Pick<Deps, "db">,
  wanted: Partial<ReturnType<typeof readPanelAccessWanted>>,
  choice: PanelAccessChoice,
): void {
  if (wanted.serveOnIp !== undefined) setSetting(deps.db, "panelServeOnIp", wanted.serveOnIp);
  if (wanted.agentPortOpen !== undefined) setSetting(deps.db, "panelAgentPortOpen", wanted.agentPortOpen);
  if (wanted.onFailure !== undefined) setSetting(deps.db, "panelIpAccessOnFailure", wanted.onFailure);
  setSetting(deps.db, "panelAccessChoice", choice);
}

/** Advertised by agents that publish the protected panel's ports on PublicPort.bind_address. */
export const panelPublishBindCapability = "panel.publish-bind.v1";
/** After an automatic reopen, a private path must work this long before IP access closes again. */
export const recloseAfterMs = 60 * 60 * 1000;
/** After a failed roll, how long nothing changes by itself. */
export const failedRollHoldMs = 15 * 60 * 1000;
export const ipAccessJobType = "settings.applyPanelIpAccess";
/** The command that reopens IP access on the panel's server (go/internal/cli/panel_ipaccess.go). */
export const ipAccessOnCommand = `sudo ${slug} panel ip-access on`;

const open: Pick<PanelIpAccessApplied, "closed" | "agentPortClosed"> = { closed: false, agentPortClosed: false };

/** The owner's three choices, with their defaults. */
export function readPanelAccessWanted(deps: Pick<Deps, "db">): {
  serveOnIp: boolean;
  agentPortOpen: boolean;
  onFailure: settingOps.PanelAccessOnFailure;
} {
  return {
    serveOnIp: getSetting(deps.db, "panelServeOnIp") ?? true,
    agentPortOpen: getSetting(deps.db, "panelAgentPortOpen") ?? true,
    onFailure: getSetting(deps.db, "panelIpAccessOnFailure") ?? "reopen",
  };
}

/** What the panel node applies now; open when nothing was ever applied. */
export function readIpAccessApplied(deps: Pick<Deps, "db">): PanelIpAccessApplied {
  return getSetting(deps.db, "panelIpAccessApplied") ?? { closed: false, agentPortClosed: false, at: 0, reason: "" };
}

export interface PanelNodeState {
  nodeId: string | null;
  online: boolean;
  /** The panel runs as the protected panel service on the panel node (an installed panel). */
  managed: boolean;
  /** Online and advertising panel.publish-bind.v1. */
  capable: boolean;
}

export function panelNodeState(deps: Pick<Deps, "db" | "agents">): PanelNodeState {
  const node = deps.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get();
  if (!node) return { nodeId: null, online: false, managed: false, capable: false };
  const managed =
    deps.db
      .select({ id: servicePlacements.serviceId })
      .from(servicePlacements)
      .where(and(eq(servicePlacements.serviceId, panelServiceId), eq(servicePlacements.nodeId, node.id)))
      .get() !== undefined;
  const online = deps.agents.isOnline(node.id);
  const capable = online && (deps.agents.capabilities(node.id)?.has(panelPublishBindCapability) ?? false);
  return { nodeId: node.id, online, managed, capable };
}

/** An update run swaps the panel container and restarts agents: IP access waits for it. */
export function updateRunning(deps: Pick<Deps, "db">): boolean {
  return deps.db.select({ id: updateRuns.id }).from(updateRuns).where(eq(updateRuns.status, "running")).get() !== undefined;
}

/** The panel's host port (the installer's --port). */
export function panelPortOf(deps: Pick<Deps, "db" | "config">): number {
  return getSetting(deps.db, "panelHostPort") ?? deps.config.hostPort ?? deps.config.port ?? panelContainerPort;
}

/** The agents' TLS port, or null when the panel has none. */
export function agentPortOf(deps: Pick<Deps, "db" | "agentTls">): number | null {
  return deps.agentTls?.port ?? getSetting(deps.db, "panelAgentTlsPort") ?? null;
}

/**
 * Enabled nodes that do not dial https://<panel domain>: closing the
 * agents' port would cut them off. The panel node counts only when it
 * dials neither loopback nor the domain (panelNodeOffDomain).
 */
export function nodesOffDomain(deps: Pick<Deps, "db" | "agents">): DialingNode[] {
  const domain = getSetting(deps.db, "panelDomain") ?? null;
  const panelNode = panelNodeOffDomain(deps);
  return [...dialingNodes(deps).filter((node) => !dialsDomain(node.url, domain)), ...(panelNode ? [panelNode] : [])];
}

/**
 * The panel node, when its own agent dials a plain http:// address that is
 * not loopback (it was joined again with an Add node command). With IP
 * access closed the panel port answers on 127.0.0.1 only, and Docker's
 * loopback publish does not take a dial to the server's own public
 * address, so the agent could not reach the panel and nothing could reopen
 * it from Settings. Null when it dials loopback or https://.
 */
export function panelNodeOnIp(deps: Pick<Deps, "db" | "agents">): DialingNode | null {
  const node = panelNodeDialing(deps);
  return node && dialsPlainHttp(node.url) && !dialsLoopback(node.url) ? node : null;
}

/** The panel node, when its own agent dials neither loopback nor https://<panel domain>: the agents' port must stay open for it. */
export function panelNodeOffDomain(deps: Pick<Deps, "db" | "agents">): DialingNode | null {
  const node = panelNodeDialing(deps);
  if (!node?.url || dialsLoopback(node.url)) return null;
  return dialsDomain(node.url, getSetting(deps.db, "panelDomain") ?? null) ? null : node;
}

/** The registered private paths with their state, in display order. */
function pathStates(deps: Pick<Deps, "db" | "agents">): (PrivatePathState & { kind: settingOps.PrivatePathKind })[] {
  return privatePathSources().map((source) => ({ kind: source.kind, ...source.state(deps) }));
}

const pathLabel = (path: { kind: settingOps.PrivatePathKind; url: string | null }) =>
  path.kind === "domain" ? `the panel domain${path.url ? ` ${new URL(path.url).host}` : ""}` : "the tailnet address";

export interface IpAccessDecision {
  closed: boolean;
  agentPortClosed: boolean;
  /** Why an automatic result is what it is, in words; null when it simply follows the switches. */
  why: string | null;
  /** While IP access waits to close again after an automatic reopen: when it will. */
  reclosesAt: number | null;
}

/** What IP access should be now. Call only while the panel node's agent is online (see applyPanelIpAccess). */
export function decidePanelIpAccess(deps: Pick<Deps, "db" | "agents" | "agentTls">, now = Date.now()): IpAccessDecision {
  const wanted = readPanelAccessWanted(deps);
  const applied = readIpAccessApplied(deps);
  const keep = { closed: applied.closed, agentPortClosed: applied.agentPortClosed, why: null, reclosesAt: null };
  if (applied.holdUntil !== undefined && now < applied.holdUntil) return keep;
  if (wanted.serveOnIp) return { ...open, why: null, reclosesAt: null };
  const panel = panelNodeState(deps);
  if (!panel.managed) return { ...open, why: "the panel does not run as a service of its node's agent", reclosesAt: null };
  if (!panel.capable) {
    return { ...open, why: "the panel node's agent cannot publish the panel port on 127.0.0.1 only (update it)", reclosesAt: null };
  }
  const onIp = panelNodeOnIp(deps);
  if (onIp) return { ...open, why: `the panel node's agent connects over ${onIp.url}, not over 127.0.0.1`, reclosesAt: null };
  const paths = pathStates(deps);
  const working = paths.filter((path) => path.working);
  let closed: boolean;
  let why: string | null = null;
  let reclosesAt: number | null = null;
  if (working.length === 0) {
    if (wanted.onFailure === "stayClosed" && applied.closed) {
      closed = true;
    } else {
      closed = false;
      const named = paths.filter((path) => path.url !== null);
      why = named.length
        ? `${named.map(pathLabel).join(" and ")} stopped working`
        : "the panel has no private path (no panel domain or tailnet address)";
    }
  } else if (!applied.closed && applied.reopenedAt !== undefined) {
    // A path counts from when it last started working, but never from before the reopen
    // (unknown starts count from the reopen too).
    const reopenedAt = applied.reopenedAt;
    const first = working
      .map((path) => ({ path, start: Math.max(reopenedAt, path.since?.getTime() ?? reopenedAt) }))
      .reduce((a, b) => (b.start < a.start ? b : a));
    const due = first.start + recloseAfterMs;
    closed = now >= due;
    if (closed) why = `${pathLabel(first.path)} has worked for an hour since IP access reopened`;
    else reclosesAt = due;
  } else {
    closed = true;
  }
  const agentPortClosed = closed && !wanted.agentPortOpen && agentPortOf(deps) !== null && nodesOffDomain(deps).length === 0;
  return { closed, agentPortClosed, why, reclosesAt };
}

export interface ApplyOptions {
  /** Who made the change, when a person (or the server's command line) did; absent for automatic changes ("system"). */
  by?: string;
  /** The owner chose again: forget the anti-flap wait and a failed roll's hold. */
  resetHold?: boolean;
  now?: number;
}

/**
 * Decides IP access from the switches, the private paths and the panel
 * node's agent, and applies a change: a new panel generation, the panel
 * node marked dirty, panelIpAccessApplied saved, an audit row (actor
 * "system" for automatic changes; a person's change is in their op's row)
 * and a security_change alert. Safe to call often: nothing happens while
 * the answer stays the same. `reason` names the trigger, for example "the
 * panel domain stopped working"; automatic changes record the decision's
 * own reason when it has one. Returns what is applied afterwards.
 */
export function applyPanelIpAccess(deps: Deps, reason: string, options: ApplyOptions = {}): PanelIpAccessApplied {
  const now = options.now ?? Date.now();
  let applied = readIpAccessApplied(deps);
  if (options.resetHold && (applied.reopenedAt !== undefined || applied.holdUntil !== undefined)) {
    const { reopenedAt: _reopenedAt, holdUntil: _holdUntil, ...rest } = applied;
    applied = rest;
    setSetting(deps.db, "panelIpAccessApplied", applied);
  }
  const panel = panelNodeState(deps);
  if (!panel.nodeId || !panel.online || updateRunning(deps)) return applied;
  const decision = decidePanelIpAccess(deps, now);
  if (decision.closed === applied.closed && decision.agentPortClosed === applied.agentPortClosed) return applied;

  const wanted = readPanelAccessWanted(deps);
  const automatic = options.by === undefined;
  // A change that only follows the switches is the doing of whoever set them, also when it applies later.
  const choice = automatic && decision.why === null ? getSetting(deps.db, "panelAccessChoice") : undefined;
  const next: PanelIpAccessApplied = {
    closed: decision.closed,
    agentPortClosed: decision.agentPortClosed,
    at: now,
    reason: automatic ? (decision.why ?? choice?.reason ?? reason) : reason,
    by: options.by ?? choice?.by ?? "system",
    from: { closed: applied.closed, agentPortClosed: applied.agentPortClosed },
  };
  const generation = bumpPanelGeneration(deps, new Date(now)) ?? applied.generation;
  if (generation !== undefined) next.generation = generation;
  // Open while the owner wants it closed: the anti-flap wait starts (or goes on, for an agents' port change).
  if (!decision.closed && !wanted.serveOnIp) next.reopenedAt = applied.closed ? now : (applied.reopenedAt ?? now);
  setSetting(deps.db, "panelIpAccessApplied", next);
  deps.agents.desired.markDirty({ nodeId: panel.nodeId });
  if (automatic) writeSystemAudit(deps, next);
  announce(deps, applied, next, automatic && !wanted.serveOnIp);
  deps.logger.info(
    { closed: next.closed, agentPortClosed: next.agentPortClosed, reason: next.reason, by: next.by, generation },
    "IP access changed",
  );
  return next;
}

/**
 * The agent could not start the panel with the new port bindings and put
 * the old container back (DEPLOY_STAGE_FAILED for the generation this
 * change sent). Records what runs again: the previous state. A close that
 * failed turns its switch back on, so the card shows the panel open and
 * the owner can try again; nothing changes by itself for 15 minutes, so a
 * broken roll is not retried every minute.
 */
export function recordFailedRoll(deps: Deps, generation: number, message: string, now = Date.now()): boolean {
  const applied = readIpAccessApplied(deps);
  if (applied.generation !== generation || !applied.from) return false;
  const restored = applied.from;
  if (restored.closed === applied.closed && restored.agentPortClosed === applied.agentPortClosed) return false;
  const triedToClose = (applied.closed && !restored.closed) || (applied.agentPortClosed && !restored.agentPortClosed);
  const detail = message.trim() ? `: ${message.trim()}` : "";
  const reason = triedToClose
    ? `the panel did not start with the port closed, so the agent put the open one back${detail}`
    : `the panel did not start with the port open, so the agent put the closed one back${detail}`;
  if (triedToClose) {
    writePanelAccessChoice(
      deps,
      {
        ...(applied.closed && !restored.closed ? { serveOnIp: true } : {}),
        ...(applied.agentPortClosed && !restored.agentPortClosed ? { agentPortOpen: true } : {}),
      },
      { reason, by: "system", at: now },
    );
  }
  const next: PanelIpAccessApplied = {
    closed: restored.closed,
    agentPortClosed: restored.agentPortClosed,
    at: now,
    reason,
    by: "system",
    from: { closed: applied.closed, agentPortClosed: applied.agentPortClosed },
    holdUntil: now + failedRollHoldMs,
  };
  // The next generation matches what runs, so the agent adopts it without another roll.
  const bumped = bumpPanelGeneration(deps, new Date(now));
  if (bumped !== null) next.generation = bumped;
  setSetting(deps.db, "panelIpAccessApplied", next);
  const panel = panelNodeState(deps);
  if (panel.nodeId) deps.agents.desired.markDirty({ nodeId: panel.nodeId });
  writeSystemAudit(deps, next);
  announce(deps, applied, next, false);
  deps.logger.warn({ generation, message }, "the panel did not start with the new IP access; the agent restored the old container");
  return true;
}

/** "open"/"closed" as the panel node runs it, or "unknown" while a change rolls out or the agent is offline. */
export function actualIpAccess(deps: Pick<Deps, "db" | "agents" | "agentTls">): Pick<settingOps.PanelAccess["actual"], "ip" | "agentPort"> {
  const applied = readIpAccessApplied(deps);
  const agentPort = agentPortOf(deps) === null ? ("off" as const) : null;
  // Nothing was ever changed: the 0.2.0 publish, open on every address.
  if (applied.generation === undefined) return { ip: applied.closed ? "unknown" : "open", agentPort: agentPort ?? "open" };
  const running = deps.agents.state
    .serviceStatuses(panelServiceId)
    .reduce((max, entry) => Math.max(max, Number(entry.status.generation)), 0);
  const applies = running >= applied.generation;
  return {
    ip: applies ? (applied.closed ? "closed" : "open") : "unknown",
    agentPort: agentPort ?? (applies ? (applied.agentPortClosed ? "closed" : "open") : "unknown"),
  };
}

/** One audit row for a change no op call made (op id "settings.ipAccessChanged"); `by` says whose switches it followed. */
function writeSystemAudit(deps: Pick<Deps, "db">, applied: PanelIpAccessApplied): void {
  deps.db
    .insert(auditLog)
    .values({
      at: new Date(applied.at),
      actorType: "system",
      actorId: null,
      credentialId: null,
      actorLabel: "system",
      opId: "settings.ipAccessChanged",
      targetType: null,
      targetId: null,
      targetLabel: null,
      projectId: null,
      transport: "http",
      input: { closed: applied.closed, agentPortClosed: applied.agentPortClosed, reason: applied.reason, by: applied.by ?? "system" },
      outcome: "ok",
      errorCode: null,
      durationMs: 0,
      ip: null,
      userAgent: null,
      approvalId: null,
    })
    .run();
}

const sentence = (text: string) => (text ? `${text[0]?.toUpperCase()}${text.slice(1)}.` : "");

/** The security_change alert and the live refresh for one change. */
function announce(deps: Deps, before: PanelIpAccessApplied, after: PanelIpAccessApplied, recloses: boolean): void {
  const port = panelPortOf(deps);
  const agentPort = agentPortOf(deps);
  const by = after.by && after.by !== "system" ? ` By ${after.by}.` : "";
  let title: string;
  let message: string;
  if (after.closed && !before.closed) {
    title = after.agentPortClosed ? "IP access and the agents' port closed" : "IP access closed";
    message = `${sentence(after.reason)}${by} The panel answers on 127.0.0.1:${port} on its server only${
      after.agentPortClosed && agentPort ? `, and so does the agents' port ${agentPort}` : ""
    }; its private path keeps working. If this was not you, run "${ipAccessOnCommand}" on the panel's server and change the password.`;
  } else if (!after.closed && before.closed) {
    title = "IP access reopened";
    message = `${sentence(after.reason)}${by} The panel answers on its IP address and port ${port} again${
      before.agentPortClosed && agentPort ? `, and agents reach it on port ${agentPort}` : ""
    }.${recloses ? " It closes again by itself once a private path has worked for an hour." : ""}`;
  } else if (after.agentPortClosed) {
    title = "Agents' port closed";
    message = `${sentence(after.reason)}${by} Port ${agentPort ?? ""} answers on 127.0.0.1 only; nodes reach the panel over its domain.`;
  } else {
    title = "Agents' port reopened";
    message = `${sentence(after.reason)}${by} Nodes can reach the panel on port ${agentPort ?? ""} again.`;
  }
  deps.alerts.raise({
    event: "security_change",
    key: `ip-access:${after.at}:${after.closed}:${after.agentPortClosed}`,
    title,
    message,
    link: "/settings/general",
  });
  deps.live.publish("panel", { type: "invalidate", ops: ["settings.panelAccess", "settings.general", "tailscale.get"] });
}

/**
 * Wires IP access to the agent hub: the panel node connecting (a change
 * may have waited for it, or its capabilities changed) and a failed roll
 * of the panel service. Call once from the settings module's start().
 */
export function watchPanelIpAccess(deps: Deps): void {
  const safely = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      deps.logger.error({ err: error }, what);
    }
  };
  deps.agents.onConnection((nodeId, online) => {
    // Node rows, blocked reasons and the nodes on the domain change with every connect; the cards refetch.
    deps.live.publish("panel", { type: "invalidate", ops: ["settings.panelAccess", "settings.general"] });
    if (!online || nodeId !== panelNodeState(deps).nodeId) return;
    safely("applying IP access after the panel node connected failed", () => applyPanelIpAccess(deps, "the panel node's agent connected"));
  });
  deps.agents.onEvent("deployProgress", (_nodeId, progress) => {
    if (progress.serviceId !== panelServiceId || progress.stage !== DeployStage.FAILED) return;
    safely("recording a failed panel roll failed", () => recordFailedRoll(deps, Number(progress.generation), progress.message));
  });
}
