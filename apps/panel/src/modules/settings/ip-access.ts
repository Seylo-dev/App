// IP access (added in 0.2.1): whether the panel port and the agents' TLS
// port answer from outside the server, or only on 127.0.0.1 while a private
// path (private-paths.ts) keeps the panel reachable. applyPanelIpAccess is
// the one place that decides it and rolls the panel when the answer
// changes; everything that changes an input calls it (a switch, the
// domain, a private path's state, the 1-minute job).
//
// Not built yet (WP-F2b): until then nothing can turn a switch off
// (settings.updatePanelAccess answers NOT_IMPLEMENTED), so the answer is
// always the 0.2.0 baseline, open, and applyPanelIpAccess changes nothing.

import type { settings as settingOps } from "@seylo/ops";
import type { Deps } from "../../deps";
import { getSetting } from "../../settings";

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
  }
}

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

/**
 * Decides IP access from the switches, the private paths and the panel
 * node's agent, and applies a change: a new panel generation, the panel
 * node marked dirty, panelIpAccessApplied saved, an audit row (actor
 * "system" for automatic changes) and a security_change alert. Safe to call
 * often: nothing happens while the answer stays the same. `reason` names
 * the trigger, for example "the panel domain stopped working". Returns what
 * is applied afterwards.
 *
 * Stub (WP-F2b fills it in): returns what is applied, which stays open.
 */
export function applyPanelIpAccess(deps: Deps, _reason: string): PanelIpAccessApplied {
  return readIpAccessApplied(deps);
}
