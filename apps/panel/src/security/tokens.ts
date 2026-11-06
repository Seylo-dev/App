// Bearer tokens (sessions, API keys, join and setup tokens). Only their
// SHA-256 is stored: a database leak does not hand out working tokens, and
// lookups by hash need no constant-time comparison.

import { createHash, randomBytes } from "node:crypto";
import { slug } from "@seylo/brand";

/** 256 random bits, base64url. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A token with a recognisable prefix ("<slug>_key_..."), so secret
 * scanners and people can tell what leaked.
 */
export function prefixedToken(kind: "key" | "mcp" | "join" | "setup" | "invite"): string {
  return `${slug}_${kind}_${randomToken()}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
