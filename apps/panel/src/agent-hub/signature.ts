// The handshake signatures (handshake.proto). The agent signs
//
//   "<slug>-agent-hello-v1" 0x00 panel_id 0x00 node_id 0x00 nonce
//
// with its Ed25519 key (ClientHello; node_id is empty when joining). The
// panel answers with HelloAccepted.panel_signature, made with its identity
// key (the edge ticket key, security/edge-ticket-key.ts) over
//
//   "<slug>-panel-accept-v1" 0x00 panel_id 0x00 node_id 0x00 session_id
//   0x00 nonce 0x00 client_signature 0x00 panel_url 0x00 panel_pin
//
// so a node knows it reached the panel it joined, not just a host with a
// certificate for its address. The Go agent builds the same bytes from
// brand.Slug (go/internal/rpc/handshake.go, accept_test.go has the vector).

import { createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { slug } from "@seylo/brand";

export const helloContext = `${slug}-agent-hello-v1`;
export const acceptContext = `${slug}-panel-accept-v1`;

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

export interface AcceptFields {
  panelId: string;
  nodeId: string;
  sessionId: string;
  /** The ServerHello nonce. */
  nonce: Uint8Array;
  /** The ClientHello's join or resume signature. */
  clientSignature: Uint8Array;
  panelUrl: string;
  panelPin: string;
}

/** What HelloAccepted.panel_signature signs. */
export function acceptSignedBytes(f: AcceptFields): Uint8Array {
  const enc = (text: string) => new TextEncoder().encode(text);
  const parts = [enc(f.panelId), enc(f.nodeId), enc(f.sessionId), f.nonce, f.clientSignature, enc(f.panelUrl), enc(f.panelPin)];
  const context = enc(acceptContext);
  const out = new Uint8Array(context.length + parts.reduce((n, p) => n + 1 + p.length, 0));
  out.set(context);
  let at = context.length;
  for (const part of parts) {
    out[at] = 0;
    out.set(part, at + 1);
    at += 1 + part.length;
  }
  return out;
}

/** HelloAccepted.panel_signature with the panel's identity key. */
export function signAccept(privateKey: KeyObject, fields: AcceptFields): Uint8Array {
  return new Uint8Array(sign(null, acceptSignedBytes(fields), privateKey));
}
