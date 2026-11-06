// Mutual TLS between nodes on the load balancer's entry point (5757). The
// panel keeps one LB certificate authority and gives every node its own
// certificate for one shared server name; the agent's Traefik then accepts
// only peers that present a certificate of this CA, and a balancing node
// checks the peer by that name. Certificates are made when a node connects
// and renewed by the daily prune job when under 30 days are left; the
// desired state only reads them (contributors must not write).

import { createPrivateKey, createPublicKey } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { slug } from "@seylo/brand";
import { LoadBalancerTlsSchema } from "@seylo/proto";
import type { Deps } from "../../deps";
import type { DesiredContributor } from "../../desired";
import { issueCertificate, newKeyPair, toPem } from "../../security/x509";
import { getSetting, setSetting } from "../../settings";

export const lbServerName = `lb.${slug}.internal`;
const day = 86_400_000;
const nodeCertDays = 365;
const renewBeforeDays = 30;

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
  if (current && current.notAfter - now > renewBeforeDays * day) return false;
  const ca = ensureCa(deps, now);
  const caKey = deps.secrets.open(ca.keySealed, "lb.key");
  if (!caKey) return false;
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
