// domains.retryCertificate: the "Regenerate certificate" action. The nodes
// the domain's DNS points at rename the route's Traefik routers
// (RetryCertificate), which makes Traefik run ACME again for it without a
// restart. Guarded so a retry has a chance: Let's Encrypt only validates a
// host whose record points at the node, and counts every failed
// validation against 5 per host name per hour, so retries are allowed
// once a minute per domain and refused while DNS points elsewhere.

import { domains as domainOps, OpError, type OpOutput } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { domains } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { checkHost, type DnsResult, dnsLookups } from "./dns";
import { invalidateService, type PlacedNode, serviceNodes } from "./lookup";
import { requireDomain } from "./ops";
import { toDomain } from "./rows";

/** One retry per domain per minute. */
export const certificateRetryWindowMs = 60_000;

const lastRetries = new WeakMap<object, Map<string, number>>();

function retriesOf(key: object): Map<string, number> {
  let map = lastRetries.get(key);
  if (!map) {
    map = new Map();
    lastRetries.set(key, map);
  }
  return map;
}

/** Seconds until the domain may be retried again, or 0. Forgets retries past the window. */
function waitSeconds(retries: Map<string, number>, domainId: string, now: number): number {
  for (const [id, at] of retries) if (now - at >= certificateRetryWindowMs) retries.delete(id);
  const last = retries.get(domainId);
  return last === undefined ? 0 : Math.ceil((certificateRetryWindowMs - (now - last)) / 1000);
}

/**
 * The placed nodes the domain's record points at: each runs its own
 * Traefik, and only the one the CA reaches can get the certificate. With a
 * proxied record (Cloudflare hides the origin) or an answer that could not
 * be classified, every placed node.
 */
function nodesInDns(nodes: PlacedNode[], dns: DnsResult): PlacedNode[] {
  if (dns.status !== "ok") return nodes;
  const found = new Set(dns.found.filter((r) => r.type !== "CNAME").map((r) => r.value.toLowerCase()));
  return nodes.filter((n) => [n.ipv4, n.ipv6, n.publicAddress].some((ip) => !!ip && found.has(ip.toLowerCase())));
}

export const retryCertificate = implement(domainOps.retryCertificate, async (input, ctx) => {
  const row = requireDomain(ctx.db, input.serviceId, input.domainId);
  if (row.https !== "acme") {
    throw new OpError(
      "CONFLICT",
      row.https === "custom"
        ? "This domain uses an uploaded certificate. Upload a new one to replace it."
        : "This domain is served over plain HTTP, so it has no certificate.",
      { reason: "notAcme" },
    );
  }
  if (row.certStatus === "valid") {
    throw new OpError("CONFLICT", "This domain already has a valid certificate. Let's Encrypt renews it on its own before it expires.", {
      reason: "certificateValid",
    });
  }
  const retries = retriesOf(ctx.db);
  const now = Date.now();
  const wait = waitSeconds(retries, row.id, now);
  if (wait > 0) {
    throw new OpError("RATE_LIMITED", `The certificate of ${row.host} was regenerated a moment ago. Try again in ${wait} seconds.`, {
      reason: "certificateRetry",
      retryAfter: String(wait),
    });
  }
  // Taken before the DNS check and the agent calls, so requests sent together
  // (a double submit, a script, an MCP client) cannot all pass the check
  // while the first one waits; given back when the retry fails (DNS, offline,
  // every node refused), so the minute starts only with a retry that happened.
  retries.set(row.id, now);
  try {
    return await retryOnNodes(ctx, row);
  } catch (error) {
    if (retries.get(row.id) === now) retries.delete(row.id);
    throw error;
  }
});

/** The DNS check and the agent calls of one retry; throws when no agent was asked or every one refused. */
async function retryOnNodes(ctx: OpContext, row: typeof domains.$inferSelect): Promise<OpOutput<typeof domainOps.retryCertificate>> {
  const nodes = serviceNodes(ctx.db, row.serviceId);
  if (nodes.length === 0) throw new OpError("CONFLICT", "The service is not on a node yet. Deploy it first.", { reason: "notPlaced" });
  const dns = await checkHost(row.host, nodes, dnsLookups());
  if (dns.status !== row.dnsStatus) {
    ctx.db.update(domains).set({ dnsStatus: dns.status, dnsCheckedAt: new Date() }).where(eq(domains.id, row.id)).run();
    invalidateService(ctx, row.serviceId, [domainOps.list.id]);
  }
  if (dns.status === "missing" || dns.status === "wrongTarget") {
    throw new OpError(
      "CONFLICT",
      `${dns.message} Let's Encrypt checks the domain through that record, so a new certificate cannot be issued until it points at the node.`,
      { reason: "dnsNotPointing", dnsStatus: dns.status },
    );
  }

  const targets = nodesInDns(nodes, dns).filter((n) => ctx.agents.isOnline(n.id));
  if (targets.length === 0) {
    throw new OpError("UNAVAILABLE", "The service's node is offline. Try again when it is back.", { reason: "offline" });
  }
  const old = targets.find((n) => !ctx.agents.supports(n.id, "retryCertificate"));
  if (old) {
    throw new OpError("CONFLICT", `The agent on ${old.name} cannot regenerate certificates yet. Update the node first.`, {
      reason: "agentTooOld",
      nodeId: old.id,
    });
  }

  // Every node routes the domain; the ones it points at get to ask the CA.
  const actor = userOf(ctx.principal)?.id ?? "";
  const results = await Promise.allSettled(
    targets.map((n) => ctx.agents.call(n.id, "retryCertificate", { serviceId: row.serviceId, routeId: row.id }, { metadata: { actor } })),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed && !results.some((r) => r.status === "fulfilled")) throw failed.reason;

  const updated = ctx.db.update(domains).set({ certStatus: "pending" }).where(eq(domains.id, row.id)).returning().get();
  invalidateService(ctx, row.serviceId, [domainOps.list.id]);
  return toDomain(updated);
}
