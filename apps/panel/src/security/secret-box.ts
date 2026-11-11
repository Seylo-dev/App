// Seals small secrets at rest with AES-256-GCM. Each purpose gets its own
// key derived from the master key with HKDF, so a value sealed for one
// purpose cannot be opened as another (a TOTP seed never decrypts as an
// env file). Ported from an earlier in-house implementation by the same authors,
// with the key moved from an env var to master.key.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Every purpose in use. Adding one is fine (append a line, keep the list
 * sorted); renaming one breaks existing values. scripts/rotate-master-key.ts
 * tries each one to re-seal values it finds.
 */
export const sealPurposes = [
  "ai.anthropic-key",
  "approval.input",
  "auth.challenge",
  "backup.destination",
  "cloudflare.tunnel",
  "compose.file",
  "deployment.env",
  "domain.certificate",
  "edge.ticket-key",
  "git.credential",
  "git.provider",
  "git.webhook",
  "lb.key",
  "agent-tls.key",
  "github.account",
  "github.app",
  "notification.channel",
  "project.env",
  "push.subscription",
  "push.vapid-key",
  "registry.credential",
  "service.env",
  "service.export",
  "service.import",
  "service.secret",
  "totp.secret",
  "volume.file",
] as const;
export type SealPurpose = (typeof sealPurposes)[number];

const version = "v1";
// Fixed, not derived from the brand: renaming the product must not change keys.
const hkdfSalt = "secret-box-v1";

export interface SecretBox {
  /** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
  seal(plaintext: string, purpose: SealPurpose): string;
  /** The plaintext, or null when the value is malformed, tampered with or sealed for another purpose. */
  open(sealed: string, purpose: SealPurpose): string | null;
  /** Keyed hash for values that must not be guessable, such as signed links. */
  sign(value: string, purpose: string): string;
}

export function createSecretBox(masterKey: Uint8Array): SecretBox {
  const keys = new Map<string, Buffer>();
  const keyFor = (purpose: string) => {
    let key = keys.get(purpose);
    if (!key) {
      key = Buffer.from(hkdfSync("sha256", masterKey, hkdfSalt, purpose, 32));
      keys.set(purpose, key);
    }
    return key;
  };

  return {
    seal(plaintext, purpose) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyFor(purpose), iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [version, iv, cipher.getAuthTag(), encrypted]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },
    open(sealed, purpose) {
      const [v, iv, tag, encrypted, extra] = sealed.split(".");
      if (v !== version || !iv || !tag || encrypted === undefined || extra !== undefined) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose), Buffer.from(iv, "base64url"));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
    sign(value, purpose) {
      return createHmac("sha256", keyFor(`sign:${purpose}`))
        .update(value)
        .digest("base64url");
    },
  };
}
