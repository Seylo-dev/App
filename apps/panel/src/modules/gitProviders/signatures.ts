// Checking a webhook delivery before anything in it is read, and the
// headers each provider names its event and delivery in. All comparisons
// are constant time.
//
//   GitLab          X-Gitlab-Token: the hook's secret token itself
//   Gitea           X-Gitea-Signature: hex HMAC-SHA256 of the body
//   Forgejo         X-Forgejo-Signature (and X-Gitea-Signature): the same
//   Bitbucket Cloud X-Hub-Signature: "sha256=" + hex HMAC-SHA256 of the body

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { GitProviderKind } from "../../db/schema";

/** Equal strings, compared in constant time whatever their lengths (both are hashed first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function hmacHex(secret: string, raw: string | Uint8Array): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

type HeaderSource = Pick<Headers, "get">;

export function verifyGitlab(secret: string, headers: HeaderSource): boolean {
  const token = headers.get("x-gitlab-token");
  return token !== null && token !== "" && safeEqual(token, secret);
}

export function verifyGitea(secret: string, raw: string | Uint8Array, headers: HeaderSource): boolean {
  const expected = hmacHex(secret, raw);
  let ok = false;
  // Forgejo sends both names; either one being right is enough (neither can be made without the secret).
  for (const name of ["x-forgejo-signature", "x-gitea-signature"]) {
    const given = headers.get(name)?.trim().toLowerCase();
    if (given && safeEqual(given, expected)) ok = true;
  }
  return ok;
}

export function verifyBitbucket(secret: string, raw: string | Uint8Array, headers: HeaderSource): boolean {
  const given = headers.get("x-hub-signature")?.trim();
  if (!given?.startsWith("sha256=")) return false;
  return safeEqual(given.slice("sha256=".length).toLowerCase(), hmacHex(secret, raw));
}

export function verifyDelivery(kind: GitProviderKind, secret: string, raw: string | Uint8Array, headers: HeaderSource): boolean {
  switch (kind) {
    case "gitlab":
      return verifyGitlab(secret, headers);
    case "gitea":
      return verifyGitea(secret, raw, headers);
    case "bitbucket":
      return verifyBitbucket(secret, raw, headers);
  }
}

/** Only the body of Gitea and Bitbucket deliveries is signed; GitLab's token says nothing about the body. */
export function signsBody(kind: GitProviderKind): boolean {
  return kind !== "gitlab";
}

/** The provider's id for this delivery (kept across its own retries), or "" when it sent none. */
export function deliveryIdOf(kind: GitProviderKind, headers: HeaderSource): string {
  const pick = (...names: string[]) => {
    for (const name of names) {
      const value = headers.get(name)?.trim();
      if (value) return value.slice(0, 64);
    }
    return "";
  };
  switch (kind) {
    case "gitlab":
      return pick("idempotency-key", "x-gitlab-event-uuid");
    case "gitea":
      return pick("x-forgejo-delivery", "x-gitea-delivery");
    case "bitbucket":
      return pick("x-request-uuid");
  }
}

/** The event name: "Push Hook", "push", "repo:push", ... */
export function eventNameOf(kind: GitProviderKind, headers: HeaderSource): string {
  const value =
    kind === "gitlab"
      ? headers.get("x-gitlab-event")
      : kind === "gitea"
        ? (headers.get("x-forgejo-event") ?? headers.get("x-gitea-event"))
        : headers.get("x-event-key");
  return (value ?? "unknown").trim().slice(0, 64);
}
