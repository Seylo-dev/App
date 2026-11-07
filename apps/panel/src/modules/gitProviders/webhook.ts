// POST /api/hooks/{gitlab,gitea,bitbucket}/<webhook id>: deliveries from
// the repository webhooks the panel created. The id names the service and
// the hook's own secret; the delivery is checked against it (constant time)
// before anything is parsed, needs the provider's delivery id, and a signed
// body seen before by this hook under another delivery id is a replay.
// Checked deliveries are rate limited per hook (a leaked GitLab token signs
// nothing, so it could otherwise post pushes in a loop); past the limit a
// delivery is answered 200 and left to branch polling. Each delivery is
// logged in the service's delivery list.

import { readBodyText } from "@seylo/ops/elysia";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { type GitProviderKind, gitProviderWebhooks, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { bodyRefused } from "../../http/body";
import { createRateLimiter, type RateLimiter } from "../../ops/rate-limit";
import { readSpec } from "../services/spec";
import { alreadyHandled, recordDelivery } from "../webhooks/deliveries";
import { recordRejected, replayedBody } from "../webhooks/replay";
import { clientFor } from "./client";
import { normalizeEvent } from "./events";
import { dropHook, hookPathPrefix } from "./hooks";
import { markPollDue } from "./poll";
import { deployProviderPush, handleProviderMergeRequest } from "./push";
import { loadProvider } from "./rows";
import { deliveryIdOf, eventNameOf, signsBody, verifyDelivery } from "./signatures";

const maxBody = 5 * 1024 * 1024;
const kinds: GitProviderKind[] = ["gitlab", "gitea", "bitbucket"];

/**
 * Checked deliveries per hook that get handled. The limit sits far above a
 * busy repository (a bot rebasing a hundred merge requests, pushes from a
 * whole team) and only stops a loop with a leaked GitLab token: each push
 * asks the provider for the head, and at most one push deploy waits behind
 * the running one however many arrive. Past it a delivery is not refused:
 * no provider retries one, and GitLab turns a hook off after 4 failures in
 * a row (a 429 counts), after which every push would be missed. It is
 * answered 200 and not handled, and the next poll reads the branch head
 * (markPollDue), so a push in it deploys about a minute late; a merge
 * request event in it is lost.
 */
const hookRules = { standard: { burst: 120, refillPerSecond: 1 }, strict: { burst: 120, refillPerSecond: 1 } };
const limiters = new WeakMap<object, RateLimiter>();

function limiterFor(deps: Pick<Deps, "db">): RateLimiter {
  let limiter = limiters.get(deps.db);
  if (!limiter) {
    limiter = createRateLimiter(hookRules);
    limiters.set(deps.db, limiter);
  }
  return limiter;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Handles one delivery to one hook. Exported for tests. */
export async function handleProviderDelivery(deps: Deps, kind: GitProviderKind, hookId: string, request: Request): Promise<Response> {
  const hook = deps.db.select().from(gitProviderWebhooks).where(eq(gitProviderWebhooks.id, hookId)).get();
  const provider = hook
    ? (() => {
        try {
          return loadProvider(deps.db, hook.providerId);
        } catch {
          return null;
        }
      })()
    : null;
  // Nothing is read for an unknown hook, and never more than maxBody.
  if (!hook || !provider || provider.kind !== kind) return json(404, { error: { code: "NOT_FOUND", message: "Unknown webhook." } });
  const secret = deps.secrets.open(hook.secretSealed, "git.webhook");
  if (secret === null) return json(500, { error: { code: "INTERNAL", message: "The webhook secret cannot be read." } });
  const read = await readBodyText(request, maxBody);
  if (!read.ok) return bodyRefused(read.reason);
  const raw = read.text;
  const event = eventNameOf(kind, request.headers);
  if (!verifyDelivery(kind, secret, raw, request.headers)) {
    recordRejected(deps.db, {
      source: kind,
      event,
      serviceId: hook.serviceId,
      detail: kind === "gitlab" ? "The secret token did not match." : "The signature did not match.",
    });
    return json(401, { error: { code: "UNAUTHENTICATED", message: "The signature did not match." } });
  }
  const deliveryId = deliveryIdOf(kind, request.headers);
  if (!deliveryId) return json(400, { error: { code: "BAD_REQUEST", message: "The delivery id header is missing." } });
  // Only checked deliveries count: someone who knows the address but not the secret cannot use up the hook's budget.
  if (limiterFor(deps).take(`hook:${hook.id}`, "standard") > 0) {
    markPollDue(deps, hook.serviceId);
    recordRejected(deps.db, {
      source: kind,
      event,
      serviceId: hook.serviceId,
      outcome: "ignored",
      detail: "Too many deliveries to this webhook: not handled; the branch head is read again within a minute.",
    });
    return json(200, { ok: true, deferred: true });
  }
  // A signed body under a new id is a replay; GitLab's token signs nothing, but a repeated body is still one.
  // Per hook: the provider posts the same body to the hook of every service of the repository.
  if (replayedBody(deps.db, kind, deliveryId, raw, hook.id)) {
    recordRejected(deps.db, {
      source: kind,
      event,
      serviceId: hook.serviceId,
      detail: "The same body was already delivered under another id (replay).",
    });
    return json(200, { ok: true, duplicate: true });
  }
  if (alreadyHandled(deps.db, deliveryId, kind, hook.serviceId)) return json(200, { ok: true, duplicate: true });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: { code: "BAD_REQUEST", message: "The body is not JSON." } });
  }
  deps.db.update(gitProviderWebhooks).set({ lastDeliveryAt: new Date() }).where(eq(gitProviderWebhooks.id, hook.id)).run();

  const svc = deps.db.select().from(services).where(eq(services.id, hook.serviceId)).get();
  const spec = svc ? readSpec(svc.spec) : null;
  const source = spec?.source;
  const record = (outcome: "ignored", detail: string, evName = event) =>
    recordDelivery(deps.db, { source: kind, deliveryId, event: evName, serviceId: svc?.id ?? null, outcome, detail });
  if (
    !svc ||
    source?.type !== "provider" ||
    source.providerId !== hook.providerId ||
    source.repo.toLowerCase() !== hook.repo.toLowerCase()
  ) {
    // A leftover hook (the source changed while the removal waited): remove it now.
    if (svc) dropHook(deps, svc.id);
    record("ignored", "The service no longer deploys this repository.");
    return json(200, { ok: true, deployed: 0 });
  }

  let deployed = 0;
  try {
    const client = clientFor(deps, provider);
    for (const ev of normalizeEvent(kind, event, payload)) {
      if (ev.type === "ping") continue;
      if (ev.type === "ignored") {
        record("ignored", `Event ${ev.event} needs nothing.`);
        continue;
      }
      if (ev.repo.toLowerCase() !== hook.repo.toLowerCase()) {
        record("ignored", `The delivery is for ${ev.repo || "another repository"}, not ${hook.repo}.`);
        continue;
      }
      const delivery = { source: kind, id: deliveryId, event: ev.type === "push" ? "push" : ev.event };
      if (ev.type === "push") {
        if (!ev.branch || ev.deleted) {
          record("ignored", ev.deleted ? "Branch deleted." : "Not a branch push.", "push");
          continue;
        }
        const outcome = await deployProviderPush(
          deps,
          svc,
          client,
          { branch: ev.branch, after: ev.after, changes: ev.changes, author: ev.author, sender: ev.sender, trusted: signsBody(kind) },
          delivery,
        );
        if (outcome === "deployed") deployed++;
      } else {
        const outcome = await handleProviderMergeRequest(deps, svc, client, ev, delivery);
        if (outcome === "deployed") deployed++;
      }
    }
  } catch (error) {
    deps.logger.error({ err: error, kind, serviceId: svc.id }, "a git provider webhook failed");
    return json(500, { error: { code: "INTERNAL", message: "The webhook could not be handled." } });
  }
  return json(200, { ok: true, deployed });
}

export function providerWebhookRoutes(deps: Deps) {
  let app = new Elysia();
  for (const kind of kinds) {
    app = app.post(
      `${hookPathPrefix}/${kind}/:hookId`,
      ({ params, request }) => handleProviderDelivery(deps, kind, params.hookId, request),
      {
        parse: "none",
      },
    ) as unknown as Elysia;
  }
  return app;
}
