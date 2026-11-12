// The origin check of custom domains. A domain behind Cloudflare's proxy
// resolves to Cloudflare's addresses, so the DNS check (dns.ts, "proxied")
// cannot tell whether the record in Cloudflare points at the service's
// node; when it does not, Let's Encrypt's HTTP-01 check never reaches the
// node and the certificate stays on Generating. The panel's own domain is
// proven through /api/health (settings/domain.ts); on a service's domain the
// app answers, so the node's agent answers a reserved path itself:
//
//   GET http://<host>/.well-known/<slug>-origin/<challenge>
//
// Every route file sends it to the agent's edge (go/internal/proxy,
// addOrigin), which answers with the node key's Ed25519 signature over
//
//   "<slug>-origin-v1" 0x00 host 0x00 challenge
//
// in base64url (go/internal/edge/origin.go, origin_test.go has the shared
// vector). The key is the one the node's handshake signs with, and the
// panel checks the answer against the public keys it stored when the
// service's nodes joined, so no secret is shared. The answer:
//
//   node       a node of the service signed the challenge for this host;
//   elsewhere  something answered without that proof, and every node of
//              the service would have given it (each advertised
//              routing.origin-proof.v1 and reported the domain's route);
//   unknown    no answer (timeout, network error, a 5xx such as
//              Cloudflare's 52x for an origin it cannot reach, a redirect
//              off the host or the path), no node with the capability, or
//              a node that may have answered without the proof (an older
//              agent, one without the route yet, one offline).
//
// When Cloudflare itself answered (its cf-ray or server header), the check
// also says why it did not reach the node (OriginReason): 525 and 526 are
// SSL/TLS Full (strict) refusing the node's temporary certificate (Traefik's
// default one, until Let's Encrypt issues the domain's: behind Always Use
// HTTPS the check, like Let's Encrypt, is redirected to https and
// Cloudflare connects to port 443), 521 and 522 are a node Cloudflare
// cannot connect to, and 404 is a server with nothing for the check. The
// reason is kept in memory with the domain's id (lastOriginReason): a hint
// for the Domains row, gone after a restart until the next check (the tab
// checks a waiting domain when it opens, recheck.ts the others).
//
// It runs for custom domains (not automatic, not redirect-only) whose DNS
// is ok or proxied: in domains.checkDns, a few seconds after domains.add as
// the domains.checkOrigin job once the nodes have the route, and before
// domains.retryCertificate. Requests go only to public addresses or a
// node's own (vettedFetch): a name that resolves into the panel's network
// gets no request and reads as unknown.

import { randomBytes } from "node:crypto";
import { slug } from "@seylo/brand";
import { domains as domainOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { verifyEd25519 } from "../../agent-hub/signature";
import { type DnsStatus, domains, nodes, type OriginStatus, servicePlacements } from "../../db/schema";
import type { Deps } from "../../deps";
import { pinRequest } from "../../http/pinned-fetch";
import { defineJob } from "../../jobs/queue";
import { nodeHasCapability } from "../databases/capability";
import { enqueueNext } from "../nodes/recurring";
import { blockedTarget, checkTarget } from "../uptime/targets";
import { settleHold } from "./acme-hold";
import { invalidateService } from "./lookup";
import type { DomainRow } from "./rows";

/** Advertised by agents whose edge answers the origin path (go/internal/edge OriginCapability). */
export const originCapability = "routing.origin-proof.v1";
export const originContext = `${slug}-origin-v1`;
/** go/internal/proxy OriginPath. */
export const originPath = `/.well-known/${slug}-origin/`;

/** What a proof signs; the Go agent builds the same bytes (edge.OriginSignedBytes). */
export function originSignedBytes(host: string, challenge: string): Uint8Array {
  return new TextEncoder().encode(`${originContext}\0${host}\0${challenge}`);
}

/** The custom domains the check is for, and the DNS states it runs in. */
export function originApplies(row: Pick<DomainRow, "auto" | "forward">, dnsStatus: DnsStatus): boolean {
  return !row.auto && !row.forward && (dnsStatus === "ok" || dnsStatus === "proxied");
}

/** The fetch the check goes through; tests swap in a fake. */
export type OriginFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> },
) => Promise<Response>;

let fetchOverride: OriginFetch | null = null;

export function setOriginFetch(next: OriginFetch | null): void {
  fetchOverride = next;
}

/**
 * The public network: a member adds the domain, so its name may resolve to
 * anything, the panel's own network included. Each request (redirect hops
 * too) goes only to a public address or a node's admin-set address, vetted
 * like an uptime target (uptime/targets.ts, the "allow internal targets"
 * setting does not apply) and pinned to that address, so DNS cannot answer
 * the check one thing and the request another.
 */
export function vettedFetch(deps: Pick<Deps, "db">): OriginFetch {
  return async (url, init) => {
    const target = await checkTarget(deps, url, { allowInternal: false });
    if (!target.ok || !target.address) throw new Error(`origin check refused: ${target.ok ? "unpinned" : blockedTarget(target)}`);
    const pinned = pinRequest(url, target.address);
    return fetch(pinned.url, { ...init, headers: { ...init.headers, ...pinned.headers }, ...(pinned.tls ? { tls: pinned.tls } : {}) });
  };
}

function originFetchFor(deps: Pick<Deps, "db">): OriginFetch {
  return fetchOverride ?? vettedFetch(deps);
}

/** The whole check, redirects included. Cloudflare answers an origin it cannot reach with a 52x well within it. */
export const originTimeoutMs = 6000;
/** http -> https (Always Use HTTPS) and a little more. */
const maxRedirects = 3;
/** A proof is 87 bytes; an app's page that answers instead is never read past this. */
const maxBodyBytes = 1024;

/** Why Cloudflare's proxy did not bring the check to the node (the contract's OriginReason). */
export type OriginReason = "cloudflareCertificate" | "cloudflareUnreachable" | "notFound";

export type OriginAnswer =
  | { kind: "proof"; nodeId: string }
  | { kind: "other"; reason?: OriginReason }
  | { kind: "none"; reason?: OriginReason };

/** The reason in an answer that Cloudflare gave itself (cf-ray, or server: cloudflare); undefined for any other. */
export function cloudflareReason(response: Pick<Response, "status" | "headers">): OriginReason | undefined {
  const headers = response.headers;
  if (!headers.has("cf-ray") && headers.get("server")?.toLowerCase() !== "cloudflare") return undefined;
  switch (response.status) {
    case 525:
    case 526:
      return "cloudflareCertificate";
    case 521:
    case 522:
      return "cloudflareUnreachable";
    case 404:
      return "notFound";
    default:
      return undefined;
  }
}

function withReason<T extends { kind: "other" | "none" }>(answer: T, reason: OriginReason | undefined): T & { reason?: OriginReason } {
  return reason ? { ...answer, reason } : answer;
}

/**
 * Fetches the origin path of host with a fresh challenge and checks the
 * answer against keys. A redirect is followed only to http(s) on the same
 * host and default port with the same path, so the request still asks the
 * domain itself.
 */
export async function probeOrigin(
  host: string,
  keys: readonly { id: string; publicKey: Uint8Array }[],
  fetcher: OriginFetch,
): Promise<OriginAnswer> {
  const challenge = randomBytes(24).toString("base64url");
  const path = `${originPath}${challenge}`;
  let url = `http://${host}${path}`;
  const signal = AbortSignal.timeout(originTimeoutMs);
  try {
    for (let hops = 0; ; hops++) {
      const response = await fetcher(url, { signal, redirect: "manual", headers: { accept: "text/plain" } });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        const next = new URL(location, url);
        const same =
          (next.protocol === "http:" || next.protocol === "https:") &&
          next.hostname.toLowerCase() === host &&
          next.port === "" &&
          next.username === "" &&
          next.password === "" &&
          next.pathname === path;
        if (!same || hops >= maxRedirects) return { kind: "none" };
        url = next.toString();
        continue;
      }
      const reason = cloudflareReason(response);
      if (response.status >= 500) {
        await response.body?.cancel();
        return withReason({ kind: "none" }, reason);
      }
      const body = (await readCapped(response, maxBodyBytes)).trim();
      if (!/^[A-Za-z0-9_-]{86}$/.test(body)) return withReason({ kind: "other" }, reason);
      const signature = Buffer.from(body, "base64url");
      const message = originSignedBytes(host, challenge);
      const signer = keys.find((key) => verifyEd25519(key.publicKey, message, signature));
      return signer ? { kind: "proof", nodeId: signer.id } : withReason({ kind: "other" }, reason);
    }
  } catch {
    return { kind: "none" };
  }
}

async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

export interface OriginCheck {
  origin: OriginStatus;
  /**
   * An online node with the capability has not reported the domain's route
   * yet (it was just added): the answer may change once it has.
   */
  waiting: boolean;
  /** Some node of the service answers the check, so it can prove the domain (acme-hold.ts). */
  provable: boolean;
  /** Why it did not reach the node, when Cloudflare said (origin unknown or elsewhere). */
  reason?: OriginReason;
}

/** Whether some node the service is placed on answers origin checks (the capability, live or as last advertised). */
export function originProvable(deps: Pick<Deps, "db" | "agents">, serviceId: string): boolean {
  return deps.db
    .select({ id: servicePlacements.nodeId })
    .from(servicePlacements)
    .where(eq(servicePlacements.serviceId, serviceId))
    .all()
    .some((n) => nodeHasCapability(deps.db, deps.agents, n.id, originCapability));
}

/** The domain's origin now, against the nodes the service is placed on. */
export async function checkOrigin(
  deps: Pick<Deps, "db" | "agents">,
  row: Pick<DomainRow, "id" | "serviceId" | "host">,
  fetcher: OriginFetch = originFetchFor(deps),
): Promise<OriginCheck> {
  const placed = deps.db
    .select({ id: nodes.id, publicKey: nodes.publicKey })
    .from(servicePlacements)
    .innerJoin(nodes, eq(nodes.id, servicePlacements.nodeId))
    .where(eq(servicePlacements.serviceId, row.serviceId))
    .all()
    .map((n) => {
      const view = deps.agents.state.get(n.id);
      const routed =
        deps.agents.isOnline(n.id) && !!view?.synced && !!view.services.get(row.serviceId)?.routes.some((r) => r.routeId === row.id);
      return { ...n, capable: nodeHasCapability(deps.db, deps.agents, n.id, originCapability), routed };
    });
  const waiting = placed.some((n) => n.capable && !n.routed && deps.agents.isOnline(n.id));
  if (!placed.some((n) => n.capable)) return { origin: "unknown", waiting: false, provable: false };
  const answer = await probeOrigin(row.host, placed, fetcher);
  if (answer.kind === "proof") return { origin: "node", waiting: false, provable: true };
  const reason = answer.reason ? { reason: answer.reason } : {};
  // Only a node that answers the check and has the route gives the proof for certain.
  if (answer.kind === "other" && placed.every((n) => n.capable && n.routed)) {
    return { origin: "elsewhere", waiting: false, provable: true, ...reason };
  }
  return { origin: "unknown", waiting, provable: true, ...reason };
}

/** The reason of each domain's last stored check, while it gives one (see the top of this file). */
const lastReasons = new Map<string, OriginReason>();

/** Why the domain's last origin check did not reach the node, when Cloudflare said; undefined after a restart until the next check. */
export function lastOriginReason(domainId: string): OriginReason | undefined {
  return lastReasons.get(domainId);
}

/**
 * Stores an origin (null clears it) and the check's reason; tells open
 * screens when either changed. Returns whether the origin did.
 */
export function saveOrigin(
  deps: Pick<Deps, "db" | "live">,
  row: Pick<DomainRow, "id" | "serviceId" | "originStatus">,
  origin: OriginStatus | null,
  at = new Date(),
  reason?: OriginReason,
): boolean {
  deps.db
    .update(domains)
    .set({ originStatus: origin, originCheckedAt: origin ? at : null })
    .where(eq(domains.id, row.id))
    .run();
  const before = lastReasons.get(row.id);
  const kept = origin && origin !== "node" ? reason : undefined;
  if (kept) lastReasons.set(row.id, kept);
  else lastReasons.delete(row.id);
  const changed = (row.originStatus ?? null) !== origin;
  if (changed || before !== kept) invalidateService(deps, row.serviceId, [domainOps.list.id]);
  return changed;
}

export const originCheckJobType = "domains.checkOrigin";

/** How long after domains.add the first check runs: the node writes the route in about a second, Traefik reads it in another. */
export const originCheckDelayMs = 5_000;
/** Checks while a node has not reported the route yet, 10 s apart. */
const originCheckTries = 4;

/** domains.add enqueues the first origin check of a domain whose DNS is ok or proxied. */
export function enqueueOriginCheck(deps: Pick<Deps, "jobs">, domainId: string, now = Date.now()): void {
  deps.jobs.enqueue(
    originCheckJobType,
    { domainId, tries: 1 },
    { runAt: new Date(now + originCheckDelayMs), dedupeKey: `${originCheckJobType}:${domainId}` },
  );
}

/**
 * The origin check after domains.add. While an online node has not
 * reported the route it runs again 10 s later (4 tries), since whatever
 * answers before the route is there (Traefik's 404, the app) is no proof
 * either way. A proof releases a domain whose certificate waits for it
 * (acme-hold.ts), so its node asks Let's Encrypt right away.
 */
export const originCheckJob = defineJob<{ domainId: string; tries?: number }>({
  type: originCheckJobType,
  maxAttempts: 1,
  async run(payload, ctx) {
    const row = ctx.db.select().from(domains).where(eq(domains.id, payload.domainId)).get();
    if (!row || !originApplies(row, row.dnsStatus)) return;
    const check = await checkOrigin(ctx, row);
    const tries = payload.tries ?? 1;
    if (check.waiting && tries < originCheckTries) {
      enqueueNext(ctx, originCheckJobType, new Date(Date.now() + 10_000), { domainId: row.id, tries: tries + 1 });
      return;
    }
    saveOrigin(ctx, row, check.origin, new Date(), check.reason);
    settleHold(ctx, row, { dnsStatus: row.dnsStatus, origin: check.origin, provable: check.provable });
  },
});
