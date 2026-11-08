// Mutual TLS between nodes on the load balancer's entry point (5757). The
// panel keeps one LB certificate authority. Each node certificate gets a
// one-off issuer of its own (a CA the LB CA signs, whose key is thrown away
// once it signed the node's certificate) and names the node: the shared
// lbServerName, which agents before 0.2 check, and the node's own
// <node id>.lb.<slug>.internal. Every node's settings list the current
// nodes (peers): the agent's Traefik accepts only a client certificate one
// of their issuers signed, so a removed node's certificate, or one the
// panel replaced and gave up, stops opening the other nodes' LB entry
// points as soon as they get their settings. A balancing node checks each
// peer by the name listed for it: the node's own name once its agent
// advertises lb.tls.peers.v1 and it holds a certificate for that name,
// else the shared one.
//
// Certificates are made when a node connects and renewed by the (hourly)
// prune job, for nodes that are connected, when under 20 days are left;
// they live 30 days, so a panel that is down keeps load balancing working
// for 20 days. A renewed node keeps its previous certificate until it
// expires and presents whichever one a peer asks for, and peers accept the
// previous one until the node confirmed the new one (it accepted a full
// SyncDesired carrying it) and confirmGraceMs passed, so a renewal never
// locks a node out of a peer that has not heard of it yet. Certificates
// from before 0.2 (no issuer of their own, 365 or 30 days) are replaced at
// once; while a node may still hold one (it has not confirmed its new
// certificate, or has not connected since), peers accept every
// certificate of the CA, as before. The desired state only reads these
// (contributors must not write). Agents turn load balancing to a node off
// while it has no certificate, so a node that cannot get one raises an
// alert, resolved once it has one (issueNodeCertificate).

import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { slug } from "@seylo/brand";
import { type LoadBalancerPeer, LoadBalancerPeerSchema, LoadBalancerTlsSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import type { AgentHub } from "../../agent-hub/hub";
import type { PanelDb } from "../../db/client";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import type { DesiredContributor } from "../../desired";
import { issueCertificate, newKeyPair, toPem } from "../../security/x509";
import { getSetting, setSetting } from "../../settings";

export const lbServerName = `lb.${slug}.internal`;
/** What agents that answer their own LB name and take peers advertise (go/internal/proxy LBPeersCapability). */
export const lbPeersCapability = "lb.tls.peers.v1";
const day = 86_400_000;
const nodeCertDays = 30;
const renewBeforeDays = 20;
/**
 * After a node confirmed its new certificate, peers keep accepting the one
 * before (and keep its shared name) this long, so its Traefik has loaded
 * the new one before theirs drops the old.
 */
export const confirmGraceMs = 2 * 60_000;

interface StoredCert {
  certPem: string;
  keySealed: string;
  notAfter: number;
}

/** A node's LB certificate (lbTlsNodes). */
interface StoredNodeCert extends StoredCert {
  /** The one-off CA that issued certPem. Absent: issued straight by the LB CA (before 0.2). */
  issuerPem?: string;
  /** The node's own LB name, which certPem carries next to lbServerName. Absent before 0.2. */
  serverName?: string;
  /** When the node accepted a full desired state carrying certPem. */
  confirmedAt?: number;
  /** When the node first confirmed a certificate for its own name (kept across renewals). */
  namedAt?: number;
  /** The certificate certPem replaced, until it expires. */
  previous?: StoredCert & { issuerPem?: string };
}

declare module "../../settings" {
  interface SettingValues {
    /** The LB certificate authority (10 years). */
    lbTlsCa: StoredCert;
    /** Each node's LB certificate, by node id. */
    lbTlsNodes: Record<string, StoredNodeCert>;
  }
}

function ensureCa(deps: Pick<Deps, "db" | "secrets">, now: number): StoredCert {
  const stored = getSetting(deps.db, "lbTlsCa");
  if (stored) return stored;
  const keys = newKeyPair();
  const notAfter = now + 3650 * day;
  const certPem = toPem(
    issueCertificate({
      commonName: `${slug} load balancer CA`,
      publicKey: keys.publicKey,
      issuer: { commonName: `${slug} load balancer CA`, privateKey: keys.privateKey },
      ca: true,
      notAfter: new Date(notAfter),
    }),
  );
  const ca = {
    certPem,
    keySealed: deps.secrets.seal(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "lb.key"),
    notAfter,
  };
  setSetting(deps.db, "lbTlsCa", ca);
  return ca;
}

/** A node's own LB name, or undefined when its id is no DNS label (it then goes by lbServerName only). */
export function nodeLbServerName(nodeId: string): string | undefined {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(nodeId) ? `${nodeId}.${lbServerName}` : undefined;
}

/** Whether a stored certificate is still to be presented or accepted. */
const live = (cert: { notAfter: number } | undefined, now: number) => !!cert && cert.notAfter > now;

/** Whether peers still accept the previous certificate: the node has not confirmed the current one long enough. */
const previousAccepted = (mine: StoredNodeCert, now: number) =>
  live(mine.previous, now) && (mine.confirmedAt === undefined || now < mine.confirmedAt + confirmGraceMs);

/** Makes or renews a node's certificate; true when it changed (its own and its peers' desired state need a resend). */
export function ensureNodeCertificate(deps: Pick<Deps, "db" | "secrets">, nodeId: string, now = Date.now()): boolean {
  const all = getSetting(deps.db, "lbTlsNodes") ?? {};
  const current = all[nodeId];
  const left = current ? current.notAfter - now : 0;
  const legacy = !!current && !current.issuerPem;
  if (current && !legacy && left > renewBeforeDays * day && left <= nodeCertDays * day) return false;
  const ca = ensureCa(deps, now);
  const caKey = deps.secrets.open(ca.keySealed, "lb.key");
  if (!caKey) throw new Error("the load balancer CA key cannot be opened with this master.key");
  const caName = `${slug} load balancer CA`;
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = now + nodeCertDays * day;
  // The issuer signs this one certificate; its key is not kept, so nothing else can ever chain to it.
  const issuerKeys = newKeyPair();
  const issuerName = `${slug} load balancer issuer ${nodeId} ${randomBytes(8).toString("hex")}`;
  const issuerPem = toPem(
    issueCertificate({
      commonName: issuerName,
      publicKey: issuerKeys.publicKey,
      issuer: { commonName: caName, privateKey: createPrivateKey(caKey) },
      ca: true,
      pathLen: 0,
      notBefore,
      notAfter: new Date(notAfter),
    }),
  );
  const own = nodeLbServerName(nodeId);
  const keys = newKeyPair();
  const certPem = toPem(
    issueCertificate({
      commonName: own ?? lbServerName,
      publicKey: keys.publicKey,
      issuer: { commonName: issuerName, privateKey: issuerKeys.privateKey },
      hosts: own ? [lbServerName, own] : [lbServerName],
      usages: ["serverAuth", "clientAuth"],
      notBefore,
      notAfter: new Date(notAfter),
    }),
  );
  // What the node is known to hold stays its previous certificate: the current one once it
  // confirmed it, else the previous one it still presents (a renewal it never got).
  const held = current?.confirmedAt !== undefined || !current?.previous ? current : current.previous;
  const next: StoredNodeCert = {
    certPem,
    keySealed: deps.secrets.seal(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "lb.key"),
    notAfter,
    issuerPem,
    ...(own ? { serverName: own } : {}),
    ...(current?.namedAt !== undefined ? { namedAt: current.namedAt } : {}),
  };
  if (held && live(held, now)) {
    next.previous = {
      certPem: held.certPem,
      keySealed: held.keySealed,
      notAfter: held.notAfter,
      ...(held.issuerPem ? { issuerPem: held.issuerPem } : {}),
    };
  }
  all[nodeId] = next;
  setSetting(deps.db, "lbTlsNodes", all);
  return true;
}

/**
 * The node accepted a full desired state whose LB certificate is certPem
 * (the chain the contributor sent). True when that confirms its current
 * certificate for the first time: peers drop its previous one, and take
 * its own name, confirmGraceMs later (refreshLbPeers).
 */
export function confirmNodeCertificate(deps: Pick<Deps, "db">, nodeId: string, certPem: string, now = Date.now()): boolean {
  const all = getSetting(deps.db, "lbTlsNodes");
  const mine = all?.[nodeId];
  if (!all || !mine || mine.confirmedAt !== undefined || !mine.issuerPem || certPem !== mine.certPem + mine.issuerPem) return false;
  mine.confirmedAt = now;
  if (mine.serverName && mine.namedAt === undefined) mine.namedAt = now;
  setSetting(deps.db, "lbTlsNodes", all);
  return true;
}

/** Whether the node has a certificate whose key opens, so the desired state can carry it. */
function hasUsableCertificate(deps: Pick<Deps, "db" | "secrets">, nodeId: string, now: number): boolean {
  const mine = getSetting(deps.db, "lbTlsNodes")?.[nodeId];
  return !!mine && mine.notAfter > now && deps.secrets.open(mine.keySealed, "lb.key") !== null;
}

const alertKey = (nodeId: string) => `lb-certificate:${nodeId}:`;

/**
 * ensureNodeCertificate for callers that run on their own (connect, the
 * prune job): a failure raises one alert per incident naming the reason,
 * and a usable certificate resolves it. True when the certificate changed.
 */
export function issueNodeCertificate(deps: Pick<Deps, "db" | "secrets" | "alerts" | "logger">, nodeId: string, now = Date.now()): boolean {
  let changed = false;
  let failure: string | null = null;
  try {
    changed = ensureNodeCertificate(deps, nodeId, now);
    if (!hasUsableCertificate(deps, nodeId, now)) failure = "its stored certificate's key cannot be opened with this master.key";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure === null) {
    deps.alerts.resolve(alertKey(nodeId));
    return changed;
  }
  deps.logger.error({ nodeId, reason: failure }, "issuing the node's load balancer certificate failed");
  if (!deps.alerts.isOpen(alertKey(nodeId))) {
    const name = deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? "A node";
    deps.alerts.raise({
      event: "node_health_check_failed",
      key: `${alertKey(nodeId)}${now}`,
      title: `${name} has no load balancer certificate`,
      message: `The panel could not issue the node's load balancer certificate: ${failure}. Other nodes do not balance traffic to it until it has one.`,
      severity: "error",
      nodeId,
    });
  }
  return changed;
}

/** Drops a removed node's certificate; call refreshLbPeers after it so the other nodes stop accepting it. */
export function forgetNodeCertificate(deps: Pick<Deps, "db">, nodeId: string): void {
  const all = getSetting(deps.db, "lbTlsNodes");
  if (!all?.[nodeId]) return;
  delete all[nodeId];
  setSetting(deps.db, "lbTlsNodes", all);
}

type Capabilities = Pick<AgentHub, "capabilities">;

/** Whether a node's agent answers its own LB name: what it advertised now, else its stored facts. */
function answersOwnName(db: PanelDb, agents: Capabilities | null, nodeId: string): boolean {
  const current = agents?.capabilities(nodeId);
  if (current) return current.has(lbPeersCapability);
  const facts = db.select({ facts: nodes.facts }).from(nodes).where(eq(nodes.id, nodeId)).get()?.facts as { capabilities?: unknown } | null;
  return Array.isArray(facts?.capabilities) && facts.capabilities.includes(lbPeersCapability);
}

/** Every node with a live certificate, as LoadBalancerTls.peers lists it at now. */
export function lbPeers(db: PanelDb, agents: Capabilities | null, now = Date.now()): LoadBalancerPeer[] {
  const all = getSetting(db, "lbTlsNodes") ?? {};
  const out: LoadBalancerPeer[] = [];
  for (const nodeId of Object.keys(all).sort()) {
    const mine = all[nodeId];
    if (!mine || !live(mine, now)) continue;
    const accepted = previousAccepted(mine, now) ? mine.previous : undefined;
    const issuerPems = [mine.issuerPem, accepted?.issuerPem].filter((p): p is string => !!p);
    const named =
      !!mine.serverName && mine.namedAt !== undefined && now >= mine.namedAt + confirmGraceMs && answersOwnName(db, agents, nodeId);
    out.push(
      create(LoadBalancerPeerSchema, {
        nodeId,
        serverName: named ? mine.serverName : lbServerName,
        issuerPems,
        legacy: !mine.issuerPem || (!!accepted && !accepted.issuerPem),
      }),
    );
  }
  return out;
}

/** The node settings' lb_tls: its certificate, the one before while it lives, and the peers. */
export function lbTlsContributor(agents: Capabilities | null): DesiredContributor {
  return {
    name: "lb-tls",
    node({ db, secrets, nodeId, settings }) {
      const now = Date.now();
      const ca = getSetting(db, "lbTlsCa");
      const mine = getSetting(db, "lbTlsNodes")?.[nodeId];
      const key = mine ? secrets.open(mine.keySealed, "lb.key") : null;
      if (!ca || !mine || !key) return;
      const previous = mine.previous?.issuerPem && live(mine.previous, now) ? mine.previous : undefined;
      const previousKey = previous ? secrets.open(previous.keySealed, "lb.key") : null;
      settings.lbTls = create(LoadBalancerTlsSchema, {
        caPem: ca.certPem,
        certPem: mine.certPem + (mine.issuerPem ?? ""),
        keyPem: key,
        serverName: lbServerName,
        nodeServerName: mine.serverName ?? "",
        previousCertPem: previous && previousKey ? previous.certPem + (previous.issuerPem ?? "") : "",
        previousKeyPem: previous && previousKey ? previousKey : "",
        peers: lbPeers(db, agents, now),
      });
    },
  };
}

/** The peers list each hub last sent its nodes, to resend only on a change. */
const sentPeers = new WeakMap<object, string>();

const peersKey = (peers: LoadBalancerPeer[]) => JSON.stringify(peers.map((p) => [p.nodeId, p.serverName, p.issuerPems, p.legacy]));

/**
 * Resends the node settings of every connected node (but except) when the
 * peers list changed since the last send: a certificate issued, renewed or
 * forgotten, a confirmation's grace over, a certificate expired, an agent
 * that now answers its own name. Nodes still waiting for their connect
 * sync are left to it. True when it resent.
 */
export function refreshLbPeers(deps: Pick<Deps, "db" | "agents">, options: { except?: string; now?: number } = {}): boolean {
  const key = peersKey(lbPeers(deps.db, deps.agents, options.now));
  if (sentPeers.get(deps.agents) === key) return false;
  sentPeers.set(deps.agents, key);
  for (const nodeId of deps.agents.onlineNodeIds()) {
    if (nodeId === options.except) continue;
    if (deps.agents.supports(nodeId, "getStateSnapshot") && !deps.agents.state.get(nodeId)?.synced) continue;
    deps.agents.desired.markDirty({ nodeId });
  }
  return true;
}

/** Records the peers list the nodes start with (nodes module start), so a reconnect without a change resends nothing. */
export function rememberLbPeers(deps: Pick<Deps, "db" | "agents">): void {
  sentPeers.set(deps.agents, peersKey(lbPeers(deps.db, null)));
}

/** For tests: the public key a stored node certificate was issued for. */
export function nodeCertificateKey(deps: Pick<Deps, "db">, nodeId: string) {
  const mine = getSetting(deps.db, "lbTlsNodes")?.[nodeId];
  return mine ? createPublicKey(mine.certPem) : null;
}
