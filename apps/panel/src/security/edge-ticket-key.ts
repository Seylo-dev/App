// The Ed25519 key pair that signs edge tickets (DB web UI, Box, status
// pages). Agents get the public key in HelloAccepted and verify tickets
// locally, without a round trip to the panel. The private key is sealed.

import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { PanelDb } from "../db/client";
import { getSetting, setSetting } from "../settings";
import type { SecretBox } from "./secret-box";

export interface EdgeTicketKey {
  /** Raw 32-byte public key, as sent to agents. */
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

export function ensureEdgeTicketKey(db: PanelDb, secrets: SecretBox): EdgeTicketKey {
  const stored = getSetting(db, "edgeTicketKey");
  if (stored) {
    const pem = secrets.open(stored.privateKeySealed, "edge.ticket-key");
    if (!pem) throw new Error("the edge ticket key cannot be opened with this master.key");
    return { publicKey: Buffer.from(stored.publicKey, "base64"), privateKey: createPrivateKey(pem) };
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  setSetting(db, "edgeTicketKey", { publicKey: raw.toString("base64"), privateKeySealed: secrets.seal(pem, "edge.ticket-key") });
  return { publicKey: raw, privateKey };
}
