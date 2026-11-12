// The certificate of a database's exposed port as databases.get shows it:
// its state, why it is self-signed (which clients that check certificates
// refuse) and that certificate's PEM, from what the node reports about the
// port (OpenPort.certificate_*, 0.2.13). The agent serves its self-signed
// fallback while the exposure has no TLS host name or the edge has no
// Let's Encrypt certificate for it; MariaDB always serves its own.

import type { databases as dbOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { type DatabaseInfo, exposureState } from "./info";

type Exposure = Static<typeof dbOps.DatabaseExposure>;

/** What the node reports about the certificate the exposed port serves. */
export interface ServedCertificate {
  /** Shown name of the issuer (issuerName), null until the node reports one. */
  issuer: string | null;
  expiresAt: Date | null;
  /** The agent's self-signed fallback (nodes from 0.2.13; false before). */
  selfSigned: boolean;
  /** The edge's last ACME error for the TLS host name, "" for none. */
  error: string;
  pem: string;
}

/** A whole PEM certificate, or null: the status caps could have cut one short, or a node sent something else. */
export function servedPem(raw: string): string | null {
  const pem = raw.trim();
  return /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/.test(pem) ? `${pem}\n` : null;
}

export function exposureCertificate(
  info: DatabaseInfo,
  seen: ServedCertificate,
  now: Date,
): Pick<Exposure, "certificate" | "selfSignedReason" | "certificateError" | "certificatePem"> {
  const none = { selfSignedReason: null, certificateError: null, certificatePem: null };
  if (info.exposure === null) return { certificate: "none", ...none };
  // Only an open port serves anything; a closed one (waiting for the node's update) keeps the state alone.
  const open = exposureState(info) === "open";
  if (info.row.engine === "mariadb") return { certificate: "selfSigned", ...none, ...(open ? { selfSignedReason: "engine" } : {}) };
  const pem = open && seen.selfSigned ? servedPem(seen.pem) : null;
  if (!info.row.tlsHostname)
    return { certificate: "selfSigned", ...none, ...(open ? { selfSignedReason: "noHostname", certificatePem: pem } : {}) };
  if (seen.selfSigned) {
    const error = seen.error.trim() || null;
    return {
      certificate: error ? "failed" : "pending",
      ...none,
      ...(open ? { selfSignedReason: "acmeMissing", certificateError: error, certificatePem: pem } : {}),
    };
  }
  const valid = seen.expiresAt !== null && seen.expiresAt.getTime() > now.getTime() && !seen.issuer?.includes("self");
  return { certificate: valid ? "valid" : "pending", ...none };
}
