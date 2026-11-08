// Mutual TLS between nodes on the load balancer's entry point (5757). The
// panel keeps one LB certificate authority and gives every node its own
// certificate for one shared server name; the agent's Traefik then accepts
// only peers that present a certificate of this CA, and a balancing node
// checks the peer by that name. Certificates are made when a node connects
// and renewed by the (hourly) prune job when under 20 days are left; the
// desired state only reads them (contributors must not write). Nothing can
// revoke a certificate a node holds, so they live 30 days: a removed node's
// certificate stops opening the other nodes' LB entry point within that,
// and a panel that is down keeps load balancing working for 20 days. One
// issued for longer (365 days before 0.2.0-rc.2) is replaced at once. Agents turn load
// balancing to a node off while it has no certificate, so a node that
// cannot get one raises an alert, resolved once it has one
// (issueNodeCertificate).

import { createPrivateKey, createPublicKey } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { slug } from "@seylo/brand";
import { LoadBalancerTlsSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import type { DesiredContributor } from "../../desired";
import { issueCertificate, newKeyPair, toPem } from "../../security/x509";
import { getSetting, setSetting } from "../../settings";

export const lbServerName = `lb.${slug}.internal`;
const day = 86_400_000;
const nodeCertDays = 30;
const renewBeforeDays = 20;

interface StoredCert {
  certPem: string;
  keySealed: string;
  notAfter: number;
}

declare module "../../settings" {
  interface SettingValues {
    /** The LB certificate authority (10 years). */
    lbTlsCa: StoredCert;
    /** Each node's LB certificate, by node id. */
    lbTlsNodes: Record<string, StoredCert>;
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

/** Makes or renews a node's certificate; true when it changed (its desired state needs a resend). */
export function ensureNodeCertificate(deps: Pick<Deps, "db" | "secrets">, nodeId: string, now = Date.now()): boolean {
  const all = getSetting(deps.db, "lbTlsNodes") ?? {};
  const current = all[nodeId];
  const left = current ? current.notAfter - now : 0;
  if (current && left > renewBeforeDays * day && left <= nodeCertDays * day) return false;
  const ca = ensureCa(deps, now);
  const caKey = deps.secrets.open(ca.keySealed, "lb.key");
  if (!caKey) throw new Error("the load balancer CA key cannot be opened with this master.key");
  const keys = newKeyPair();
  const notAfter = now + nodeCertDays * day;
  const certPem = toPem(
    issueCertificate({
      commonName: lbServerName,
      publicKey: keys.publicKey,
      issuer: { commonName: `${slug} load balancer CA`, privateKey: createPrivateKey(caKey) },
      hosts: [lbServerName],
      usages: ["serverAuth", "clientAuth"],
      notAfter: new Date(notAfter),
    }),
  );
  all[nodeId] = {
    certPem,
    keySealed: deps.secrets.seal(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "lb.key"),
    notAfter,
  };
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

/** Drops a removed node's certificate. */
export function forgetNodeCertificate(deps: Pick<Deps, "db">, nodeId: string): void {
  const all = getSetting(deps.db, "lbTlsNodes");
  if (!all?.[nodeId]) return;
  delete all[nodeId];
  setSetting(deps.db, "lbTlsNodes", all);
}

export const lbTlsContributor: DesiredContributor = {
  name: "lb-tls",
  node({ db, secrets, nodeId, settings }) {
    const ca = getSetting(db, "lbTlsCa");
    const mine = getSetting(db, "lbTlsNodes")?.[nodeId];
    const key = mine ? secrets.open(mine.keySealed, "lb.key") : null;
    if (!ca || !mine || !key) return;
    settings.lbTls = create(LoadBalancerTlsSchema, { caPem: ca.certPem, certPem: mine.certPem, keyPem: key, serverName: lbServerName });
  },
};

/** For tests: the public key a stored node certificate was issued for. */
export function nodeCertificateKey(deps: Pick<Deps, "db">, nodeId: string) {
  const mine = getSetting(deps.db, "lbTlsNodes")?.[nodeId];
  return mine ? createPublicKey(mine.certPem) : null;
}
