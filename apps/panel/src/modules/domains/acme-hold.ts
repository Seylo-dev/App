// Let's Encrypt waits for DNS. A custom domain's route asks for its
// certificate only once the panel has seen that the domain reaches a node
// of the service; before that every attempt fails and counts against
// Let's Encrypt's 5 failed validations per host name per hour. While held,
// desired.ts sends the route with acme_hold: the node asks the CA nothing
// and serves plain HTTP without the redirect to HTTPS (there is no
// certificate to redirect to), and HTTPS with Traefik's default
// certificate, so the origin check reaches the node also when Cloudflare's
// proxy connects to it on 443 (Always Use HTTPS, SSL/TLS Full). An agent
// from before 0.2.8 ignores acme_hold and asks at once, as before the
// hold. domains.list marks the certificate waitingForDns, and route reports
// that say nothing about a certificate are not taken for one (tracking.ts).
//
// Held while the last check said the domain does not reach the node yet:
//
//   missing, wrongTarget   no record, or one pointing elsewhere;
//   proxied                behind Cloudflare's proxy, until the origin check
//                          (origin.ts) is answered by a node of the service
//                          (unknown and elsewhere hold);
//   ok                     only when the origin check found another server
//                          answering on the node's address (elsewhere).
//
// A DNS answer of unknown (the lookup failed, or the node's address is not
// known yet) says nothing about the record. It never starts a hold, so a
// domain whose lookups fail from the start cannot be kept off HTTPS: its
// route asks Let's Encrypt as it did before the hold. Nor does it end one
// (keepsLastAnswer): a held domain keeps the last answer that said
// something, and its origin, so a resolver timeout neither starts a
// certificate against a record still missing nor takes the domain off the
// re-check (recheck.ts picks only held domains); only dns_checked_at moves
// on, and the next lookup that answers decides.
//
// A check that proves the domain (DNS ok with the origin not elsewhere, or
// proxied with the origin check answered by a node) releases it for good
// (domains.acme_released_at), and so does a proxied one nothing can prove:
// a redirect-only domain, which gets no origin check, or one whose nodes
// all run agents that do not answer the check. A domain that has or had a
// certificate (valid, an expiry on record, or live) is never held either,
// and neither are automatic (wildcard) domains or HTTPS modes custom and
// off. When a check or a route report changes whether a domain is held,
// the service's desired state goes to its nodes again at once, so the
// certificate starts right away (or the failing attempts stop).
//
// The checks run in domains.add, domains.checkDns (Check again and the
// Domains tab's re-check of a waiting domain, once a minute while it is
// open), the origin check a few seconds after domains.add, the re-check
// of waiting domains with nobody looking (recheck.ts) and
// domains.retryCertificate.

import { domains as domainOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { type DnsStatus, domains, type OriginStatus } from "../../db/schema";
import type { Deps } from "../../deps";
import { invalidateService } from "./lookup";
import type { DomainRow } from "./rows";

type HoldFacts = Pick<
  DomainRow,
  "https" | "auto" | "forward" | "dnsStatus" | "originStatus" | "acmeReleasedAt" | "certStatus" | "certExpiresAt" | "liveAt"
>;

/** The domain had a certificate or a check released it: its route keeps asking Let's Encrypt whatever later checks say. */
function releasedForGood(row: Pick<HoldFacts, "acmeReleasedAt" | "certStatus" | "certExpiresAt" | "liveAt">): boolean {
  return !!row.acmeReleasedAt || row.certStatus === "valid" || !!row.certExpiresAt || !!row.liveAt;
}

/** Whether the domain's route waits for DNS before asking Let's Encrypt (see the top of this file). */
export function acmeHeld(row: HoldFacts): boolean {
  if (row.https !== "acme" || row.auto || releasedForGood(row)) return false;
  switch (row.dnsStatus) {
    case "missing":
    case "wrongTarget":
      return true;
    case "proxied":
      return !row.forward && row.originStatus !== "node";
    case "ok":
      return row.originStatus === "elsewhere";
    default:
      return false;
  }
}

/**
 * Whether the domain's route answers Let's Encrypt's HTTP-01 challenge on
 * HTTPS too (Route.acme_challenge_on_https, 0.2.13): unless its last DNS
 * check saw it point straight at the node. In front of the node, a redirect
 * to https that takes every path (a Cloudflare Redirect Rule or Page Rule;
 * Always Use HTTPS itself leaves the challenge path alone) sends the CA's
 * http:// request to https and, with SSL/TLS Full, to port 443, where only
 * the app answered, so neither the first certificate nor a renewal came.
 * Straight to the node it reaches port 80, where Traefik answers it, and
 * the app keeps /.well-known/acme-challenge/ over https (Traefik's handler
 * answers only its own tokens and never falls through). Automatic domains
 * are on the node's wildcard record, which is never checked: always.
 */
export function acmeChallengeOnHttps(row: Pick<DomainRow, "auto" | "dnsStatus">): boolean {
  return row.auto || row.dnsStatus !== "ok";
}

/** Whether a check's DNS answer leaves the row as it was: unknown for a held domain (see the top of this file). */
export function keepsLastAnswer(row: HoldFacts, dnsStatus: DnsStatus): boolean {
  return dnsStatus === "unknown" && acmeHeld(row);
}

export interface CheckAnswer {
  dnsStatus: DnsStatus;
  /** The origin check's answer; null when it did not run (DNS not ok or proxied, a redirect-only or automatic domain). */
  origin: OriginStatus | null;
  /** Some node of the service answers origin checks (origin.ts originProvable); false means no check can prove a proxied domain. */
  provable: boolean;
}

/** Whether a check's answer releases the domain for good. */
export function releases(row: Pick<DomainRow, "forward">, answer: CheckAnswer): boolean {
  if (answer.dnsStatus === "ok") return answer.origin !== "elsewhere";
  if (answer.dnsStatus === "proxied") return answer.origin === "node" || !!row.forward || !answer.provable;
  return false;
}

/**
 * After a check stored its DNS and origin answer on the row: releases the
 * domain when the answer proves it, and sends the service's desired state
 * again when that changed whether it is held, or for an ACME domain whether
 * its route answers the challenge on HTTPS (acmeChallengeOnHttps). `before`
 * is the row as it was before the check. Returns whether it is held now and
 * whether this check released it.
 */
export function settleHold(
  deps: Pick<Deps, "db" | "agents" | "live">,
  before: DomainRow,
  answer: CheckAnswer,
  at = new Date(),
): { held: boolean; released: boolean } {
  let row = deps.db.select().from(domains).where(eq(domains.id, before.id)).get();
  if (!row) return { held: false, released: false };
  if (!row.acmeReleasedAt && releases(row, answer)) {
    row = deps.db.update(domains).set({ acmeReleasedAt: at }).where(eq(domains.id, row.id)).returning().get();
  }
  const wasHeld = acmeHeld(before);
  const held = acmeHeld(row);
  if (held !== wasHeld) {
    deps.agents.desired.markDirty({ serviceId: row.serviceId });
    invalidateService(deps, row.serviceId, [domainOps.list.id]);
  } else if (row.https === "acme" && acmeChallengeOnHttps(before) !== acmeChallengeOnHttps(row)) {
    deps.agents.desired.markDirty({ serviceId: row.serviceId });
  }
  return { held, released: wasHeld && !held };
}
