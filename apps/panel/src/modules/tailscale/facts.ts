// What the panel node's agent reports about the server's own tailscaled
// (NodeFacts.tailscale, tailnet.proto), read the same way everywhere: the
// live session's facts, else the last ones stored for the node.

import { fromJson } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { tailscale } from "@seylo/ops";
import { type NodeFacts, NodeFactsSchema, TailnetServeState, type TailscaleInfo } from "@seylo/proto";
import { eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import type { TailnetIdentity } from "../../http/tailnet-host";
import { readSeen, readServeTailnet, readServeWanted, type ServeTailnet } from "./keys";

/** Advertised by agents that report TailscaleInfo and keep the Serve entry (no methods). */
export const tailnetServeCapability = "tailnet.serve.v1";

export function panelNodeId(db: PanelDb): string | null {
  return db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get()?.id ?? null;
}

/** The panel node's facts from its live session, else the last ones stored; null before it ever connected. */
export function panelNodeFacts(deps: Pick<Deps, "db" | "agents">, nodeId: string | null = panelNodeId(deps.db)): NodeFacts | null {
  if (!nodeId) return null;
  const live = deps.agents.state.get(nodeId)?.facts;
  if (live) return live;
  const row = deps.db.select({ facts: nodes.facts }).from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!row?.facts) return null;
  try {
    return fromJson(NodeFactsSchema, row.facts as never, { ignoreUnknownFields: true });
  } catch {
    return null;
  }
}

/** The agent reads Tailscale: without it, a missing TailscaleInfo says nothing about tailscaled. */
export function agentReadsTailscale(facts: NodeFacts | null): boolean {
  return facts?.capabilities.includes(tailnetServeCapability) ?? false;
}

const serveStates: Record<TailnetServeState, tailscale.TailscaleServeState> = {
  [TailnetServeState.UNSPECIFIED]: "off",
  [TailnetServeState.OFF]: "off",
  [TailnetServeState.APPLYING]: "applying",
  [TailnetServeState.ACTIVE]: "active",
  [TailnetServeState.CONFLICT]: "conflict",
  [TailnetServeState.ERROR]: "error",
  [TailnetServeState.UNSUPPORTED]: "unsupported",
};

/** The Serve state as the ops name it; unknown values (a newer agent) read as off. */
export function serveStateOf(info: TailscaleInfo | undefined): tailscale.TailscaleServeState {
  return serveStates[info?.serve?.state ?? TailnetServeState.UNSPECIFIED] ?? "off";
}

/** tailscaled's MagicDNS name without the trailing dot, lower case; empty before sign-in. */
export function dnsNameOf(info: TailscaleInfo | undefined): string {
  return (info?.dnsName ?? "").trim().replace(/\.$/, "").toLowerCase();
}

export function keyExpiryMs(info: TailscaleInfo | undefined): number | null {
  return info?.keyExpiry ? timestampMs(info.keyExpiry) : null;
}

/**
 * x.y.z of a tailscaled version. Its long form ("1.104.5-t2c2ddf4b5-g8d5e2f9a3")
 * carries commit hashes after a hyphen, which are not a pre-release.
 */
function versionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** tailscaled is at least `min`; an unreadable version is not. */
export function versionAtLeast(version: string | null | undefined, min: string): boolean {
  const have = versionParts(version ?? "");
  const need = versionParts(min);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    const a = have[i] as number;
    const b = need[i] as number;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * BackendState values that mean the server still has to sign in. Not
 * "Stopped": that server is signed in, and only `tailscale up` on it starts
 * it again (the agent refuses a sign-in link then).
 */
export const signedOutStates = new Set(["", "NoState", "NeedsLogin"]);

/** "panel.tail1234.ts.net" -> "tail1234.ts.net"; empty for a name without a dot. */
export function magicDnsSuffix(dnsName: string): string {
  const name = dnsName.trim().replace(/\.$/, "").toLowerCase();
  const dot = name.indexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

/**
 * The server is signed in to another tailnet than `approved`, the one Serve
 * was turned on for. Compared by tailnet name, which stays when the tailnet's
 * DNS name is renamed, and by MagicDNS suffix only when a name is missing. A
 * server that names no tailnet (signed out) is on no other one.
 */
export function onOtherTailnet(approved: ServeTailnet | null, tailnet: string, dnsName: string): boolean {
  if (!approved) return false;
  if (approved.tailnet && tailnet) return approved.tailnet !== tailnet;
  const was = magicDnsSuffix(approved.dnsName);
  const now = magicDnsSuffix(dnsName);
  return was !== "" && now !== "" && was !== now;
}

/** Serve is on, and the server is signed in to another tailnet than the one it was turned on for. */
export function servedTailnetMoved(db: PanelDb, tailnet: string, dnsName: string): boolean {
  return readServeWanted(db) && onOtherTailnet(readServeTailnet(db), tailnet, dnsName);
}

/** How a tailnet is named in alerts and messages: its name, else its MagicDNS suffix. */
export function tailnetLabel(tailnet: string, dnsName: string): string {
  return tailnet || magicDnsSuffix(dnsName) || "an unknown tailnet";
}

/**
 * The name the tailnet listener serves (http/tailnet-host.ts), read on every
 * request there: the live report, else the last name the panel recorded.
 * On another tailnet than the one Serve was turned on for it serves nothing.
 */
export function tailnetIdentity(deps: Pick<Deps, "db" | "agents">): TailnetIdentity {
  const nodeId = panelNodeId(deps.db);
  const live = nodeId ? deps.agents.state.get(nodeId)?.facts : null;
  const info = live && agentReadsTailscale(live) ? live.tailscale : undefined;
  if (info && dnsNameOf(info)) {
    const dnsName = dnsNameOf(info);
    return { dnsName, addresses: info.addresses, otherTailnet: servedTailnetMoved(deps.db, info.tailnet, dnsName) };
  }
  const seen = readSeen(deps.db);
  return { dnsName: seen.dnsName || null, addresses: [], otherTailnet: servedTailnetMoved(deps.db, seen.tailnet, seen.dnsName) };
}
