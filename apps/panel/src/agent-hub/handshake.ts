// Decides whether a connecting agent may in: a new node joining with a
// single-use token, or a known node resuming with its key. Pure database
// logic, so it is tested without sockets.

import { isIP } from "node:net";
import { toJson } from "@bufbuild/protobuf";
import { type ClientHello, HelloRejectReason, NodeFactsSchema } from "@seylo/proto";
import { and, eq, isNull } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { joinTokens, nodes } from "../db/schema";
import { blockedReason } from "../modules/uptime/targets";
import { hashToken } from "../security/tokens";
import { getSetting, setSetting } from "../settings";
import { helloSignedBytes, verifyEd25519 } from "./signature";

declare module "../settings" {
  interface SettingValues {
    /**
     * The public address each node last connected from, as the panel saw it
     * (behind the panel's Traefik, the forwarded one), by node id; none for
     * a node that connects over a private network or loopback. Unlike
     * public_ipv4/public_ipv6, which the agent's own facts fill first, an
     * agent cannot make it up, so git sources count it among a node's
     * trusted addresses (uptime/targets.ts NodeAddressScope).
     */
    nodeConnectAddresses: Record<string, string>;
  }
}

export type HelloDecision = { ok: true; nodeId: string; joined: boolean } | { ok: false; reason: HelloRejectReason; message: string };

const reject = (reason: HelloRejectReason, message: string): HelloDecision => ({ ok: false, reason, message });

export interface HelloOptions {
  /**
   * The address the agent connected from (behind the panel's Traefik, the
   * forwarded one). On clouds with 1:1 NAT (AWS, GCP, Azure, Oracle) the
   * node's interfaces only hold private addresses, so a public address seen
   * here stands in for the facts' empty publicIpv4/publicIpv6.
   */
  remoteIp?: string | null;
  /**
   * Only the installer's own join token (created by nobody) may make the
   * panel node: set when the panel runs as the installer's managed service,
   * so a remote node that happens to join first never becomes it.
   */
  panelNodeFromInstallerOnly?: boolean;
  now?: Date;
}

/** Keeps nodeConnectAddresses up to date: the node's public connect address, or none (null). */
export function rememberConnectAddress(db: PanelDb, nodeId: string, address: string | null): void {
  const all = getSetting(db, "nodeConnectAddresses") ?? {};
  if ((all[nodeId] ?? null) === address) return;
  const next = { ...all };
  if (address) next[nodeId] = address;
  else delete next[nodeId];
  setSetting(db, "nodeConnectAddresses", next);
}

/** A public address the agent connected from, by family; null when it is private or unknown. */
function publicRemote(remoteIp: string | null | undefined): { v4: string | null; v6: string | null } {
  if (!remoteIp || blockedReason(remoteIp) !== null) return { v4: null, v6: null };
  return isIP(remoteIp) === 4 ? { v4: remoteIp, v6: null } : { v4: null, v6: remoteIp };
}

export function decideHello(
  db: PanelDb,
  panelId: string,
  nonce: Uint8Array,
  hello: ClientHello,
  options: HelloOptions = {},
): HelloDecision {
  const now = options.now ?? new Date();
  const facts = hello.facts ? (toJson(NodeFactsSchema, hello.facts) as Record<string, unknown>) : null;
  const seen = publicRemote(options.remoteIp);
  const report = {
    facts,
    agentVersion: hello.agentVersion,
    lastSeenAt: now,
    publicIpv4: hello.facts?.publicIpv4 || seen.v4,
    publicIpv6: hello.facts?.publicIpv6 || seen.v6,
  };

  switch (hello.credential.case) {
    case "resume": {
      const { nodeId, signature } = hello.credential.value;
      const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
      if (!node) return reject(HelloRejectReason.UNKNOWN_NODE, "This node was removed from the panel. Join it again.");
      if (node.disabledAt) return reject(HelloRejectReason.NODE_DISABLED, "This node is disabled in the panel.");
      if (!verifyEd25519(node.publicKey, helloSignedBytes(panelId, nodeId, nonce), signature)) {
        return reject(HelloRejectReason.BAD_SIGNATURE, "The node's signature does not match its registered key.");
      }
      db.update(nodes).set(report).where(eq(nodes.id, nodeId)).run();
      rememberConnectAddress(db, nodeId, seen.v4 ?? seen.v6);
      return { ok: true, nodeId, joined: false };
    }

    case "join": {
      const { token, publicKey, signature, requestedName } = hello.credential.value;
      const row = db
        .select()
        .from(joinTokens)
        .where(eq(joinTokens.tokenHash, hashToken(token)))
        .get();
      if (!row || row.usedAt)
        return reject(HelloRejectReason.INVALID_TOKEN, "The join token is not valid. Create a new one with Add node.");
      if (row.expiresAt <= now) return reject(HelloRejectReason.TOKEN_EXPIRED, "The join token expired. Create a new one with Add node.");
      if (!verifyEd25519(publicKey, helloSignedBytes(panelId, "", nonce), signature)) {
        return reject(HelloRejectReason.BAD_SIGNATURE, "The join signature is not valid.");
      }

      const decision = db.transaction((tx): HelloDecision => {
        // Claim the token first; the usedAt condition makes a second use lose.
        const claimed = tx
          .update(joinTokens)
          .set({ usedAt: now })
          .where(and(eq(joinTokens.id, row.id), isNull(joinTokens.usedAt)))
          .returning({ id: joinTokens.id })
          .get();
        if (!claimed) return reject(HelloRejectReason.INVALID_TOKEN, "The join token was already used.");
        const known = tx
          .select({ id: nodes.id, disabledAt: nodes.disabledAt })
          .from(nodes)
          .where(eq(nodes.publicKey, Buffer.from(publicKey)))
          .get();
        if (known) {
          // A re-join of the same machine (install.sh --force keeps its key): the valid token
          // shows the owner wants it in, the key shows it is that node. It keeps its row.
          if (known.disabledAt) return reject(HelloRejectReason.NODE_DISABLED, "This node is disabled in the panel.");
          tx.update(nodes).set(report).where(eq(nodes.id, known.id)).run();
          tx.update(joinTokens).set({ nodeId: known.id }).where(eq(joinTokens.id, row.id)).run();
          return { ok: true as const, nodeId: known.id, joined: false };
        }

        const name = uniqueNodeName(tx, requestedName || hello.facts?.hostname || "node");
        // The installer's "panel + node here" joins the local node first with the token
        // it wrote (created by nobody), and that node becomes the panel node (it runs
        // the panel and the registry). A panel the installer manages accepts only that
        // token for it; a hand-run panel keeps "the first node".
        const noPanelNode = !tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get();
        const isPanelNode = noPanelNode && (!options.panelNodeFromInstallerOnly || row.createdBy === null);
        // A build node gets the source, git credentials and build secrets of whatever it builds, from any
        // project, and pushes the images other nodes run. Whoever made the join command chose that
        // ("Build images on this node" in Add node, on for the installer's panel node); the machine
        // that joins does not (`seylo join --can-build` is only reported in its facts). A re-join
        // above keeps the row's value. nodes.setCanBuild changes it later.
        const canBuild = row.canBuild;
        const node = tx
          .insert(nodes)
          .values({ name, publicKey: Buffer.from(publicKey), canBuild, isPanelNode, ...report })
          .returning({ id: nodes.id })
          .get();
        tx.update(joinTokens).set({ nodeId: node.id }).where(eq(joinTokens.id, row.id)).run();
        return { ok: true as const, nodeId: node.id, joined: true };
      });
      if (decision.ok) rememberConnectAddress(db, decision.nodeId, seen.v4 ?? seen.v6);
      return decision;
    }

    default:
      return reject(HelloRejectReason.INVALID_TOKEN, "The agent sent no credential.");
  }
}

/** "web", then "web-2", "web-3", ... so two hosts with the same hostname can join. */
function uniqueNodeName(db: Pick<PanelDb, "select">, wanted: string): string {
  const base = wanted.trim().slice(0, 60) || "node";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!db.select({ id: nodes.id }).from(nodes).where(eq(nodes.name, candidate)).get()) return candidate;
  }
}
