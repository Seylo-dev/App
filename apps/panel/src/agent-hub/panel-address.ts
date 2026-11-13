// What the panel keeps per node about how its agent reaches the panel
// (added in 0.2.15), in panel.db settings so it holds while the node is
// offline and across panel restarts:
//
//   - Panel address: "follow" (the default) names the live panel domain in
//     HelloAccepted.panel_url (move-target.ts), "stay" never does, so the
//     node keeps the address it dials. The owner picks it in the node's
//     Settings (nodes.updateSettings panelAddressChoice); the node asks for
//     "stay" itself after `seylo set-panel` or a join with --pin at an IP
//     address while the panel has a domain (ClientHello.stay_on_address).
//     Without a choice, a node with an open PANEL_MOVE_FAILED alert about
//     an inspected certificate (a network that decrypts HTTPS re-signed the
//     domain's certificate) stays until the owner picks one: naming the
//     domain again only drops the node's session.
//   - The last refused hello of an offline node (AGENT_TOO_OLD with a valid
//     signature, BAD_SIGNATURE), which its row in the node list shows.
//   - The last time the node was away with a reason: the agent's
//     ClientHello.away (the last connect error it had), shown on the
//     node's page as "Was offline from ... to ...: <reason>".

import { type AwayReport, HelloRejectReason, NodeAlertKind } from "@seylo/proto";
import { and, isNull } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { alerts } from "../db/schema";
import { keyStartsWith } from "../modules/alerts/sink";
import { getSetting, setSetting } from "../settings";

export type PanelAddressChoice = "follow" | "stay";
/**
 * Who chose: "owner" in the node's settings, "node" after `seylo set-panel`,
 * "join" after a join with --pin at an IP address, "inspectedCertificate"
 * for an open move alert about one, "default" for nobody.
 */
export type PanelAddressChoiceBy = "owner" | "node" | "join" | "inspectedCertificate" | "default";

export interface StoredPanelAddress {
  choice: PanelAddressChoice;
  by: "owner" | "node" | "join";
  /** Epoch milliseconds. */
  at: number;
}

export interface StoredHelloRejection {
  /** HelloRejectReason name, for example "AGENT_TOO_OLD". */
  reason: string;
  message: string;
  at: number;
}

export interface StoredOfflineReport {
  /** When the agent lost its session (AwayReport.since), epoch milliseconds. */
  from: number;
  /** When it connected again. */
  to: number;
  reason: string;
  failedAttempts: number;
}

declare module "../settings" {
  interface SettingValues {
    /** Panel address choices by node id; a node without one follows the domain. */
    nodePanelAddress: Record<string, StoredPanelAddress>;
    /** The last hello the panel refused, by node id; dropped once the node connects. */
    nodeHelloRejections: Record<string, StoredHelloRejection>;
    /** The last reported time away, by node id. */
    nodeOfflineReports: Record<string, StoredOfflineReport>;
  }
}

/** Open PANEL_MOVE_FAILED alerts of a node start with this (modules/alerts/events.ts). */
export const moveFailedAlertPrefix = (nodeId: string) => `node-alert:${nodeId}:${NodeAlertKind.PANEL_MOVE_FAILED}:`;

/** The part of a PANEL_MOVE_FAILED key that marks an inspected certificate (NodeAlert.inspected_certificate). */
export const inspectedKeyMark = "inspected:";

/**
 * Text of a move alert from an agent before 0.2.15 that failed on an
 * inspected certificate: the agent's own sentence about TLS inspection, or
 * Go's error for an issuer it does not trust or a pin that does not match.
 */
const inspectedText = /TLS inspection|certificate signed by unknown authority|did not present the panel's pinned key/;

/**
 * Text of a move alert whose address answered with Traefik's own default
 * certificate (the agent's dial error says so, and quotes the issuer of
 * what came in place of a pin): the panel's proxy had no certificate for
 * the name for a while, no firewall re-signed it, so the text above does
 * not count.
 */
const traefikDefaultText = /answers with Traefik's own certificate|issued by "TRAEFIK DEFAULT CERT"/i;

/** When the node's open move alert about an inspected certificate was raised; null when it has none. */
export function inspectedMoveAlertAt(db: PanelDb, nodeId: string): Date | null {
  const prefix = moveFailedAlertPrefix(nodeId);
  const open = db
    .select({ key: alerts.eventKey, message: alerts.message, createdAt: alerts.createdAt })
    .from(alerts)
    .where(and(keyStartsWith(prefix), isNull(alerts.resolvedAt)))
    .all();
  const hit = open.find(
    (row) => row.key.startsWith(prefix + inspectedKeyMark) || (inspectedText.test(row.message) && !traefikDefaultText.test(row.message)),
  );
  return hit?.createdAt ?? null;
}

/** The node's Panel address and who chose it. */
export function panelAddressChoice(
  db: PanelDb,
  nodeId: string,
): { choice: PanelAddressChoice; by: PanelAddressChoiceBy; at: number | null } {
  const stored = getSetting(db, "nodePanelAddress")?.[nodeId];
  if (stored) return stored;
  const inspected = inspectedMoveAlertAt(db, nodeId);
  if (inspected) return { choice: "stay", by: "inspectedCertificate", at: inspected.getTime() };
  return { choice: "follow", by: "default", at: null };
}

/** Stores a choice; writes only when it changed. */
export function setPanelAddressChoice(
  db: PanelDb,
  nodeId: string,
  choice: PanelAddressChoice,
  by: StoredPanelAddress["by"],
  now = Date.now(),
): boolean {
  const all = getSetting(db, "nodePanelAddress") ?? {};
  const current = all[nodeId];
  if (current?.choice === choice && current.by === by) return false;
  setSetting(db, "nodePanelAddress", { ...all, [nodeId]: { choice, by, at: now } });
  return true;
}

/**
 * The node asked to stay on its address (ClientHello.stay_on_address):
 * after `seylo set-panel` always, after a join only while the panel has a
 * domain (the Add node dialog then offered the domain's command first, and
 * the owner took the IP and pin instead). Returns who chose, or null when
 * nothing was stored.
 */
export function recordStayRequest(db: PanelDb, nodeId: string, credential: "join" | "resume", now = Date.now()): "node" | "join" | null {
  if (credential === "join" && !getSetting(db, "panelDomain")?.trim()) return null;
  const by = credential === "join" ? "join" : "node";
  return setPanelAddressChoice(db, nodeId, "stay", by, now) ? by : null;
}

/** Refusals that say why a known node stays offline. */
const shownRejections = new Set([HelloRejectReason.AGENT_TOO_OLD, HelloRejectReason.BAD_SIGNATURE]);

/** Remembers a refused hello of a known node; the same reason again within a minute is not written. */
export function recordHelloRejection(db: PanelDb, nodeId: string, reason: HelloRejectReason, message: string, now = Date.now()): void {
  if (!shownRejections.has(reason)) return;
  const all = getSetting(db, "nodeHelloRejections") ?? {};
  const name = HelloRejectReason[reason] ?? String(reason);
  const last = all[nodeId];
  if (last?.reason === name && now - last.at < 60_000) return;
  setSetting(db, "nodeHelloRejections", { ...all, [nodeId]: { reason: name, message: message.slice(0, 300), at: now } });
}

/** The node's last refused hello after it was last seen, or null. */
export function lastHelloRejection(db: PanelDb, nodeId: string, lastSeenAt: Date | null): StoredHelloRejection | null {
  const last = getSetting(db, "nodeHelloRejections")?.[nodeId];
  if (!last || (lastSeenAt && last.at < lastSeenAt.getTime())) return null;
  return last;
}

/** Longest reason kept from an AwayReport. */
const reasonMax = 300;
/** A report older than this (a wrong clock) starts at the reconnect instead. */
const awayMaxMs = 90 * 86_400_000;

const ms = (t: { seconds: bigint; nanos: number } | undefined) => (t ? Number(t.seconds) * 1000 + Math.floor(t.nanos / 1e6) : null);

/** One line of printable text: the reason can quote a certificate's names, which whoever answered chose. */
function printable(text: string): string {
  // Line breaks become spaces; other control and format characters (a terminal escape's ESC) go.
  return text
    .replace(/\s+/g, " ")
    .replace(/\p{C}+/gu, "")
    .trim();
}

/** Keeps the agent's report of why it was away, and drops the node's refused hello: it is connected now. */
export function recordNodeConnected(db: PanelDb, nodeId: string, away: AwayReport | undefined, now = Date.now()): void {
  const rejections = getSetting(db, "nodeHelloRejections");
  if (rejections?.[nodeId]) {
    const { [nodeId]: _gone, ...rest } = rejections;
    setSetting(db, "nodeHelloRejections", rest);
  }
  const reason = printable(away?.lastError ?? "").slice(0, reasonMax);
  if (!reason) return;
  const since = ms(away?.since);
  const from = since !== null && since <= now && now - since <= awayMaxMs ? since : now;
  const report: StoredOfflineReport = { from, to: now, reason, failedAttempts: away?.failedAttempts ?? 0 };
  setSetting(db, "nodeOfflineReports", { ...(getSetting(db, "nodeOfflineReports") ?? {}), [nodeId]: report });
}

/** The node's last reported time away, or null. */
export function lastOfflineReport(db: PanelDb, nodeId: string): StoredOfflineReport | null {
  return getSetting(db, "nodeOfflineReports")?.[nodeId] ?? null;
}

/** A removed node's entries go. */
export function forgetNodeAddressState(db: PanelDb, nodeId: string): void {
  for (const key of ["nodePanelAddress", "nodeHelloRejections", "nodeOfflineReports"] as const) {
    const all = getSetting(db, key) as Record<string, unknown> | undefined;
    if (!all?.[nodeId]) continue;
    const { [nodeId]: _gone, ...rest } = all;
    setSetting(db, key, rest as never);
  }
}
