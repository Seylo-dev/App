// POST /api/hooks/deploy/<token>: deploy trigger URLs for CI and git hosts
// other than GitHub. The token is the credential; only its hash is stored.
// A second call while a deploy of the service is still queued joins it
// instead of queueing another (taking over its commit when it names one),
// and each trigger is rate limited.

import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { deployments, deployTriggers } from "../../db/schema";
import type { Deps } from "../../deps";
import { createRateLimiter, type RateLimiter } from "../../ops/rate-limit";
import { hashToken } from "../../security/tokens";
import { queueDeploy } from "../deployments/queue";
import { recordDelivery } from "./deliveries";

export const deployTriggerPath = "/api/hooks/deploy";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Calls per trigger: a CI burst passes, a leaked URL in a loop does not queue a deploy per request. */
const triggerRules = { standard: { burst: 10, refillPerSecond: 1 / 6 }, strict: { burst: 10, refillPerSecond: 1 / 6 } };
const limiters = new WeakMap<object, RateLimiter>();

export function triggerRoute(deps: Deps) {
  return new Elysia().post(`${deployTriggerPath}/:token`, ({ params, request }) => {
    const trigger = deps.db
      .select()
      .from(deployTriggers)
      .where(eq(deployTriggers.tokenHash, hashToken(params.token)))
      .get();
    if (!trigger) return json(404, { error: { code: "NOT_FOUND", message: "Unknown deploy trigger." } });
    let limiter = limiters.get(deps.db);
    if (!limiter) {
      limiter = createRateLimiter(triggerRules);
      limiters.set(deps.db, limiter);
    }
    const wait = limiter.take(`trigger:${trigger.id}`, "standard");
    if (wait > 0) {
      return new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: `Too many calls. Try again in ${wait} seconds.` } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(wait) },
      });
    }
    const deliveryId = crypto.randomUUID();
    const url = new URL(request.url);
    const commit = url.searchParams.get("commit");
    const commitSha = commit && /^[0-9a-f]{7,64}$/.test(commit) ? commit : null;
    deps.db.update(deployTriggers).set({ lastUsedAt: new Date() }).where(eq(deployTriggers.id, trigger.id)).run();

    const waiting = deps.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.serviceId, trigger.serviceId), eq(deployments.status, "queued")))
      .get();
    if (waiting) {
      // Join the queued deploy; a newer commit replaces the one it would build.
      if (commitSha && waiting.trigger === "webhook" && waiting.commitSha !== commitSha) {
        deps.db.update(deployments).set({ commitSha }).where(eq(deployments.id, waiting.id)).run();
      }
      recordDelivery(deps.db, {
        source: "trigger",
        deliveryId,
        event: "trigger",
        serviceId: trigger.serviceId,
        outcome: "ignored",
        detail: commitSha ? "A deploy was already queued; it builds this commit now." : "A deploy was already queued.",
        deploymentId: waiting.id,
      });
      return json(200, { deploymentId: waiting.id, queued: false });
    }
    try {
      const d = queueDeploy(deps, { serviceId: trigger.serviceId, trigger: "webhook", actor: `Deploy URL …${trigger.hint}`, commitSha });
      recordDelivery(deps.db, {
        source: "trigger",
        deliveryId,
        event: "trigger",
        serviceId: trigger.serviceId,
        outcome: "deployed",
        detail: "Deploy queued.",
        deploymentId: d.id,
      });
      return json(200, { deploymentId: d.id, queued: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordDelivery(deps.db, {
        source: "trigger",
        deliveryId,
        event: "trigger",
        serviceId: trigger.serviceId,
        outcome: "failed",
        detail: message,
      });
      return json(409, { error: { code: "CONFLICT", message } });
    }
  });
}
