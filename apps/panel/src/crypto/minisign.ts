// minisign signature checks, shared by the signed release manifest
// (modules/updates/manifest.ts) and the signed template catalog
// (modules/templates/remote.ts). Only verification: nothing in the panel
// holds a signing key.

import { createHash, createPublicKey, verify } from "node:crypto";

export class MinisignError extends Error {
  override name = "MinisignError";
}

/** A minisign public key ("RW..." base64: "Ed", 8-byte key id, 32-byte Ed25519 key) is well formed. */
export function isMinisignPublicKey(value: string): boolean {
  const pk = Buffer.from(value.trim(), "base64");
  return pk.length === 42 && pk.subarray(0, 2).toString() === "Ed" && pk.toString("base64") === value.trim();
}

/**
 * Verifies a minisign signature (legacy "Ed" or prehashed "ED") and its
 * trusted comment. Returns the trusted comment. `what` names the signed
 * thing in the messages ("release", "catalog").
 */
export function verifyMinisign(publicKeyBase64: string, message: Uint8Array, signatureFile: string, what = "release"): string {
  const pk = Buffer.from(publicKeyBase64.trim(), "base64");
  if (pk.length !== 42 || pk.subarray(0, 2).toString() !== "Ed") throw new MinisignError(`The ${what} signing key is malformed.`);
  const lines = signatureFile.trim().split(/\r?\n/);
  const sigLine = lines[1];
  const trustedLine = lines[2];
  const globalLine = lines[3];
  if (!sigLine || !trustedLine?.startsWith("trusted comment: ") || !globalLine)
    throw new MinisignError(`The ${what} signature is malformed.`);
  const sig = Buffer.from(sigLine, "base64");
  if (sig.length !== 74) throw new MinisignError(`The ${what} signature is malformed.`);
  const algorithm = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) throw new MinisignError(`The ${what} was signed with a different key.`);
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk.subarray(10).toString("base64url") }, format: "jwk" });
  const signed = algorithm === "ED" ? createHash("blake2b512").update(message).digest() : algorithm === "Ed" ? Buffer.from(message) : null;
  if (!signed) throw new MinisignError(`The ${what} signature uses an unknown algorithm.`);
  if (!verify(null, signed, key, sig.subarray(10))) throw new MinisignError(`The ${what} signature does not match.`);
  const trusted = trustedLine.slice("trusted comment: ".length);
  const global = Buffer.from(globalLine, "base64");
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), key, global)) {
    throw new MinisignError(`The ${what} signature's trusted comment does not match.`);
  }
  return trusted;
}
