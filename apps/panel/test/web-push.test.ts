// Web Push encryption and VAPID (modules/push/web-push.ts): the RFC 8291
// example byte for byte, a browser's side decrypting fresh messages, and
// the RFC 8292 JWT checked with the panel's public key.

import { expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import {
  encryptPushPayload,
  generateVapidKeys,
  maxPushPayloadBytes,
  pushRequest,
  validTargetKeys,
  validTopic,
  vapidAuthorization,
} from "../src/modules/push/web-push";

const b = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "base64url");

// RFC 8291 section 5 and appendix A.
const rfc = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

test("the RFC 8291 example encrypts to the RFC's body, byte for byte", () => {
  const body = encryptPushPayload(
    Buffer.from(rfc.plaintext),
    { p256dh: rfc.uaPublic, auth: rfc.authSecret },
    { salt: b(rfc.salt), senderPrivateKey: b(rfc.asPrivate) },
  );
  expect(body.toString("base64url")).toBe(rfc.body.replace(/\s+/g, ""));
});

/** What a browser does with a message (RFC 8291 section 3.4 from the receiving side). */
function decryptAsBrowser(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  expect(recordSize).toBe(4096);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const secret = ua.computeSecret(asPublic);
  const mac = (key: Buffer, ...parts: Buffer[]) => {
    const h = createHmac("sha256", key);
    for (const p of parts) h.update(p);
    return h.digest();
  };
  const expand = (salt: Buffer, ikm: Buffer, info: string | Buffer, n: number) =>
    mac(mac(salt, ikm), Buffer.isBuffer(info) ? info : Buffer.from(info, "latin1"), Buffer.of(1)).subarray(0, n);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), ua.getPublicKey(), asPublic]);
  const ikm = expand(authSecret, secret, keyInfo, 32);
  const cek = expand(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = expand(salt, ikm, "Content-Encoding: nonce\0", 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  expect(record.at(-1)).toBe(2);
  return record.subarray(0, -1).toString("utf8");
}

function browser() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  return {
    ua,
    auth,
    target: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: ua.getPublicKey("base64url"), auth: auth.toString("base64url") },
  };
}

test("a browser opens a fresh message; each message gets its own salt and sender key", () => {
  const { ua, auth, target } = browser();
  const text = JSON.stringify({ title: "api crashed", body: "exit code 137 (out of memory)", url: "/p/x/s/y" });
  const one = encryptPushPayload(Buffer.from(text), target);
  const two = encryptPushPayload(Buffer.from(text), target);
  expect(decryptAsBrowser(one, ua.getPrivateKey(), auth)).toBe(text);
  expect(decryptAsBrowser(two, ua.getPrivateKey(), auth)).toBe(text);
  expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
  expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false);
});

test("the largest message makes a 4096-byte body; more, and keys that are no P-256 point, are refused", () => {
  const { target } = browser();
  // RFC 8291 section 4: 4096 octets of body less the 86-octet header, 1 delimiter and 16 of GCM tag.
  expect(maxPushPayloadBytes).toBe(3993);
  expect(encryptPushPayload(Buffer.alloc(maxPushPayloadBytes), target).length).toBe(4096);
  expect(() => encryptPushPayload(Buffer.alloc(maxPushPayloadBytes + 1), target)).toThrow();
  // 65 bytes with the 0x04 prefix but not on the curve.
  const offCurve = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 7)]).toString("base64url");
  expect(validTargetKeys({ p256dh: offCurve, auth: target.auth })).toBe(false);
  expect(validTargetKeys(target)).toBe(true);
  expect(validTopic("crash-abc_123")).toBe(true);
  expect(validTopic("a".repeat(33))).toBe(false);
  expect(validTopic("has space")).toBe(false);
  expect(validTargetKeys({ p256dh: target.p256dh, auth: "AAAA" })).toBe(false);
  expect(validTargetKeys({ p256dh: Buffer.alloc(65).toString("base64url"), auth: target.auth })).toBe(false);
  expect(() => encryptPushPayload(Buffer.from("x"), { p256dh: "abc", auth: target.auth })).toThrow();
});

test("the VAPID header is an ES256 JWT for the push service's origin, signed by the panel's key", () => {
  const keys = generateVapidKeys();
  const now = Date.UTC(2026, 10, 10, 12);
  const header = vapidAuthorization("https://web.push.apple.com/QGuQyavXutnMH...", keys, "https://panel.example.com", now);
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  expect(match).not.toBeNull();
  const [, h, c, s, k] = match as unknown as string[];
  expect(k).toBe(keys.publicKey);
  expect(JSON.parse(b(h as string).toString())).toEqual({ typ: "JWT", alg: "ES256" });
  expect(JSON.parse(b(c as string).toString())).toEqual({
    aud: "https://web.push.apple.com",
    exp: now / 1000 + 12 * 3600,
    sub: "https://panel.example.com",
  });
  const pub = b(keys.publicKey);
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") },
    format: "jwk",
  });
  expect(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, b(s as string))).toBe(true);
});

test("the push request carries TTL, urgency, topic and the aes128gcm body", () => {
  const { ua, auth, target } = browser();
  const { url, init } = pushRequest(target, Buffer.from("hi"), {
    keys: generateVapidKeys(),
    subject: "https://panel.example.com",
    ttlSeconds: 3600,
    urgency: "high",
    topic: "crash-svc1",
  });
  expect(url).toBe(target.endpoint);
  const headers = init.headers as Record<string, string>;
  expect(headers).toMatchObject({ "content-encoding": "aes128gcm", ttl: "3600", urgency: "high", topic: "crash-svc1" });
  expect(headers.authorization).toStartWith("vapid t=");
  expect(decryptAsBrowser(init.body as Buffer, ua.getPrivateKey(), auth)).toBe("hi");
});
