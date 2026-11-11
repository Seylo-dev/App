// Tells this panel apart from any other server that answers /api/health.
// GET /api/health?proof=<nonce> answers "proof": an HMAC-SHA256 of the
// nonce under a key only this panel holds (made when the panel starts,
// never stored or logged), so nothing else can compute it: not another
// panel, not an old copy of this same install, not an app whose health
// route also says {"status":"ok"}, not a server that echoes the query back.
//
// The panel domain check (modules/settings/domain.ts) calls a domain active
// only when https://<domain>/api/health proves it is this panel. Before
// 0.2.8 any {"status":"ok"} passed, so a Cloudflare-proxied record still
// pointing at another server made IP:port redirect people there. The panel
// move (modules/panelMove/probe.ts) uses it the other way round: an answer
// that proves this panel is the old panel itself, never the moved one.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface HealthProof {
  /** What /api/health answers for this nonce; null for one that is not a nonce. */
  proofOf(nonce: string): string | null;
  /** True when `answer` (a health answer's "proof") came from this panel for `nonce`. */
  proves(nonce: string, answer: unknown): boolean;
}

const nonceShape = /^[A-Za-z0-9_-]{16,128}$/;

/** A fresh nonce for one check. */
export function newProofNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** One panel's proof, with its own key (deps.healthProof). */
export function createHealthProof(): HealthProof {
  const key = randomBytes(32);
  const proofOf = (nonce: string) => (nonceShape.test(nonce) ? createHmac("sha256", key).update(nonce).digest("base64url") : null);
  return {
    proofOf,
    proves(nonce, answer) {
      const want = proofOf(nonce);
      if (!want || typeof answer !== "string" || answer.length !== want.length) return false;
      return timingSafeEqual(Buffer.from(answer), Buffer.from(want));
    },
  };
}
