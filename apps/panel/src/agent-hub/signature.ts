// The handshake signature (handshake.proto, ClientHello). The agent signs
//
//   "<slug>-agent-hello-v1" 0x00 panel_id 0x00 node_id 0x00 nonce
//
// with its Ed25519 key. node_id is empty when joining. The Go agent must
// build the same bytes from brand.Slug.

import { createPublicKey, verify } from "node:crypto";
import { slug } from "@seylo/brand";

export const helloContext = `${slug}-agent-hello-v1`;

export function helloSignedBytes(panelId: string, nodeId: string, nonce: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(`${helloContext}\0${panelId}\0${nodeId}\0`);
  const out = new Uint8Array(text.length + nonce.length);
  out.set(text);
  out.set(nonce, text.length);
  return out;
}

/** False for malformed keys or signatures as well as wrong ones. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") }, format: "jwk" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
