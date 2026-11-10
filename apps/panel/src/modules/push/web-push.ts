// Web Push without a library: the message encryption of RFC 8291
// (aes128gcm, RFC 8188) and the VAPID identification of RFC 8292 (an ES256
// JWT and the panel's public key). The push service (the browser maker's)
// only sees the encrypted record; the person's browser holds the private
// key that opens it. test/web-push.test.ts checks this against the RFC 8291
// example, byte for byte.

import { createCipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, type KeyObject, randomBytes, sign } from "node:crypto";

/** What a browser's PushSubscription hands over (subscription.toJSON()). */
export interface PushTarget {
  endpoint: string;
  /** The browser's P-256 public key, uncompressed (65 bytes), base64url. */
  p256dh: string;
  /** The browser's 16-byte authentication secret, base64url. */
  auth: string;
}

/** The panel's VAPID key pair: P-256, both halves base64url (the private one is the raw 32-byte scalar). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** The record size the header announces (RFC 8291 section 4). */
const recordSize = 4096;
/** The header before the record: salt 16, record size 4, key id length 1, key id 65. */
const headerSize = 16 + 4 + 1 + 65;
/** Push services take at most 4096 bytes of body (RFC 8030 section 7.2), header included. */
const maxBodyBytes = 4096;
/** The largest plaintext: the body less the header, the 0x02 delimiter and the 16-byte GCM tag (3993, RFC 8291 section 4). */
export const maxPushPayloadBytes = maxBodyBytes - headerSize - 1 - 16;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");

function hmac(key: Uint8Array, ...parts: Uint8Array[]): Buffer {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

/** HKDF (RFC 5869) with SHA-256, for outputs of up to 32 bytes: one expand block. */
function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, info, Uint8Array.of(1)).subarray(0, length);
}

/** A fresh P-256 key pair for the panel's VAPID identity. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
}

/**
 * Whether a subscription's keys are what RFC 8291 requires: an uncompressed
 * P-256 point that is on the curve (65 bytes) and a 16-byte secret.
 */
export function validTargetKeys(target: Pick<PushTarget, "p256dh" | "auth">): boolean {
  const key = unb64(target.p256dh);
  if (key.length !== 65 || key[0] !== 0x04 || unb64(target.auth).length !== 16) return false;
  try {
    // Importing checks the point lies on the curve.
    createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(key.subarray(1, 33)), y: b64(key.subarray(33, 65)) }, format: "jwk" });
    return true;
  } catch {
    return false;
  }
}

/** A Topic header value: 1 to 32 characters of the base64url alphabet (RFC 8030 section 5.4). */
export const validTopic = (topic: string) => /^[A-Za-z0-9_-]{1,32}$/.test(topic);

/**
 * Encrypts one push message for one browser (RFC 8291 section 3.4): the
 * aes128gcm body with its header (salt, record size, the sender's public
 * key). `fixed` sets the salt and the sender key, for the RFC's example in
 * tests; real messages get fresh ones each time.
 */
export function encryptPushPayload(
  plaintext: Uint8Array,
  target: Pick<PushTarget, "p256dh" | "auth">,
  fixed: { salt?: Uint8Array; senderPrivateKey?: Uint8Array } = {},
): Buffer {
  if (plaintext.length > maxPushPayloadBytes) throw new Error(`a push message holds at most ${maxPushPayloadBytes} bytes`);
  if (!validTargetKeys(target)) throw new Error("the subscription's keys are not a P-256 key and a 16-byte secret");
  const uaPublic = unb64(target.p256dh);
  const authSecret = unb64(target.auth);
  const salt = fixed.salt ?? randomBytes(16);
  const sender = createECDH("prime256v1");
  if (fixed.senderPrivateKey) sender.setPrivateKey(fixed.senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);

  // The shared secret mixed with the browser's auth secret, bound to both public keys.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12);

  // One record, the last: the plaintext and the 0x02 delimiter, no padding.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Uint8Array.of(2)])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(headerSize);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([header, sealed]);
}

/** The last key object built, so a fan-out does not rebuild it for every device. */
let signingKey: { publicKey: string; key: KeyObject } | null = null;

/** The panel's VAPID private key as a key object (from its raw scalar and public point). */
function vapidSigningKey(keys: VapidKeys): KeyObject {
  if (signingKey?.publicKey === keys.publicKey) return signingKey.key;
  const pub = unb64(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) },
    format: "jwk",
  });
  signingKey = { publicKey: keys.publicKey, key };
  return key;
}

/**
 * The Authorization header of RFC 8292: an ES256 JWT for the push
 * service's origin, valid for 12 hours (services refuse more than 24), and
 * the panel's public key. `subject` is how the push service can reach the
 * sender: the panel's own https URL, never a person's address.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: vapidSigningKey(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

export type PushUrgency = "very-low" | "low" | "normal" | "high";

/** The request that delivers one message to one browser (RFC 8030 section 5). */
export function pushRequest(
  target: PushTarget,
  payload: Uint8Array,
  options: { keys: VapidKeys; subject: string; ttlSeconds: number; urgency?: PushUrgency; topic?: string; now?: number },
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    authorization: vapidAuthorization(target.endpoint, options.keys, options.subject, options.now),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(Math.max(0, Math.floor(options.ttlSeconds))),
    urgency: options.urgency ?? "normal",
  };
  // A newer message with the same topic replaces one still waiting.
  if (options.topic) {
    if (!validTopic(options.topic)) throw new Error("a push topic is 1 to 32 base64url characters");
    headers.topic = options.topic;
  }
  return { url: target.endpoint, init: { method: "POST", headers, body: encryptPushPayload(payload, target), redirect: "error" } };
}
