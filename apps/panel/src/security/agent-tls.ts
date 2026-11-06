// The agents' TLS identity while the panel has no public domain: a
// self-signed certificate whose key stays in the data dir next to
// master.key. Agents do not check it against a CA; the join command pins
// its public key (--pin sha256:<SPKI>), so an on-path attacker can neither
// read the agent protocol (env values, registry logins) nor impersonate the
// panel to a node. The key is made once and kept, so the pin never changes.

import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slug } from "@seylo/brand";
import { issueCertificate, newKeyPair, spkiPin, toPem } from "./x509";

export interface AgentTls {
  port: number;
  /** "sha256:<64 hex>" of the certificate's public key, for --pin. */
  pin: string;
  certPem: string;
  keyPem: string;
}

export const agentTlsFiles = { key: "agent-tls.key", cert: "agent-tls.crt" };

/** Loads the agent TLS key and certificate from `dataDir`, making them on the first start. */
export function ensureAgentTls(dataDir: string, port: number, now = new Date()): AgentTls {
  const keyPath = join(dataDir, agentTlsFiles.key);
  const certPath = join(dataDir, agentTlsFiles.cert);
  if (!existsSync(keyPath)) {
    const keys = newKeyPair();
    writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }
  const keyPem = readFileSync(keyPath, "utf8");
  const privateKey = createPrivateKey(keyPem);
  const publicKey = createPublicKey(privateKey);
  // The certificate is only a wrapper for the pinned key: remade when missing.
  if (!existsSync(certPath)) {
    const name = `${slug} panel (agents)`;
    const der = issueCertificate({
      commonName: name,
      publicKey,
      issuer: { commonName: name, privateKey },
      notAfter: new Date(now.getTime() + 20 * 365 * 86_400_000),
    });
    writeFileSync(certPath, toPem(der), { mode: 0o644 });
  }
  return { port, pin: spkiPin(publicKey), certPem: readFileSync(certPath, "utf8"), keyPem };
}
