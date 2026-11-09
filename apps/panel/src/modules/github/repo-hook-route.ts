// POST /api/hooks/github-repo/<webhook id>: deliveries from the repository
// webhooks the panel created with its connected GitHub account
// (repo-hooks.ts). The id names the service and the hook's own secret; the
// body is checked against it (X-Hub-Signature-256, constant time) before
// anything is parsed, needs GitHub's delivery id, and a signed body seen
// before by this hook under another delivery id is a replay. Checked
// deliveries are rate limited per hook like the provider hooks; past the
// limit a delivery is answered 200 and left to branch polling. A delivery
// deploys only the hook's own service.

import { readBodyText } from "@seylo/ops/elysia";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { githubRepoWebhooks, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { bodyRefused } from "../../http/body";
import { createRateLimiter, type RateLimiter } from "../../ops/rate-limit";
import { readSpec } from "../services/spec";
import { changesFromPushPayload } from "../webhooks/changes";
import { alreadyHandled, recordDelivery } from "../webhooks/deliveries";
import { recordRejected, replayedBody } from "../webhooks/replay";
import { verifySignature } from "./app";
import { handlePullRequest, handlePush } from "./push";
import { dropRepoHooks, repoHookPathPrefix } from "./repo-hooks";

const maxBody = 5 * 1024 * 1024;

/** Checked deliveries per hook that get handled, like the provider hooks: far above a busy repository. */
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

interface PushPayload {
  ref?: string;
  deleted?: boolean;
  after?: string;
  repository?: { full_name?: string };
  head_commit?: { id: string; message: string; author?: { name?: string; username?: string } } | null;
  sender?: { login: string };
}

interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    title: string;
    head: { ref: string; sha: string; repo: { full_name: string } | null };
    base: { ref: string; repo: { full_name: string } };
  };
  sender?: { login: string };
}

/** Handles one delivery to one repository webhook. Exported for tests. */
export async function handleRepoHookDelivery(deps: Deps, hookId: string, request: Request): Promise<Response> {
  const hook = deps.db.select().from(githubRepoWebhooks).where(eq(githubRepoWebhooks.id, hookId)).get();
  // Nothing is read for an unknown hook, and never more than maxBody.
  if (!hook) return json(404, { error: { code: "NOT_FOUND", message: "Unknown webhook." } });
  const secret = deps.secrets.open(hook.secretSealed, "git.webhook");
  if (secret === null) return json(500, { error: { code: "INTERNAL", message: "The webhook secret cannot be read." } });
  const read = await readBodyText(request, maxBody);
  if (!read.ok) return bodyRefused(read.reason);
  const raw = read.text;
  const event = (request.headers.get("x-github-event") ?? "unknown").slice(0, 64);
  if (!verifySignature(secret, raw, request.headers.get("x-hub-signature-256"))) {
    recordRejected(deps.db, { source: "github", event, serviceId: hook.serviceId, detail: "The signature did not match." });
    return json(401, { error: { code: "UNAUTHENTICATED", message: "The signature did not match." } });
  }
  const deliveryId = (request.headers.get("x-github-delivery") ?? "").slice(0, 64);
  if (!deliveryId) return json(400, { error: { code: "BAD_REQUEST", message: "X-GitHub-Delivery is missing." } });
  if (event === "ping") return json(200, { ok: true });
  if (limiterFor(deps).take(`github-repo-hook:${hook.id}`, "standard") > 0) {
    recordRejected(deps.db, {
      source: "github",
      event,
      serviceId: hook.serviceId,
      outcome: "ignored",
      detail: "Too many deliveries to this webhook: not handled; the branch is polled instead.",
    });
    return json(200, { ok: true, deferred: true });
  }
  if (replayedBody(deps.db, "github", deliveryId, raw, hook.id)) {
    recordRejected(deps.db, {
      source: "github",
      event,
      serviceId: hook.serviceId,
      detail: "The same signed body was already delivered under another id (replay).",
    });
    return json(200, { ok: true, duplicate: true });
  }
  if (alreadyHandled(deps.db, deliveryId, "github", hook.serviceId)) return json(200, { ok: true, duplicate: true });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: { code: "BAD_REQUEST", message: "The body is not JSON." } });
  }
  deps.db.update(githubRepoWebhooks).set({ lastDeliveryAt: new Date() }).where(eq(githubRepoWebhooks.id, hook.id)).run();

  const svc = deps.db.select().from(services).where(eq(services.id, hook.serviceId)).get();
  const source = svc ? readSpec(svc.spec).source : null;
  const record = (detail: string) =>
    recordDelivery(deps.db, { source: "github", deliveryId, event, serviceId: svc?.id ?? null, outcome: "ignored", detail });
  if (!svc || source?.type !== "github" || source.installationId || source.repo.toLowerCase() !== hook.repo.toLowerCase()) {
    // A leftover hook (the source changed while the removal waited): remove it now.
    if (svc) dropRepoHooks(deps, [svc.id]);
    record("The service no longer deploys this repository through the connected GitHub account.");
    return json(200, { ok: true, deployed: 0 });
  }

  const delivery = { id: deliveryId, event, source: "github" as const };
  try {
    if (event === "push") {
      const p = payload as PushPayload;
      if (!p.ref?.startsWith("refs/heads/") || p.deleted) {
        record(p.deleted ? "Branch deleted." : "Not a branch push.");
        return json(200, { ok: true, deployed: 0 });
      }
      const repo = p.repository?.full_name ?? "";
      if (repo.toLowerCase() !== hook.repo.toLowerCase()) {
        record(`The delivery is for ${repo || "another repository"}, not ${hook.repo}.`);
        return json(200, { ok: true, deployed: 0 });
      }
      const deployed = await handlePush(
        deps,
        {
          repo: hook.repo,
          branch: p.ref.slice("refs/heads/".length),
          sha: p.head_commit?.id ?? p.after ?? "",
          message: p.head_commit?.message.split("\n")[0] ?? null,
          author: p.head_commit?.author?.username ?? p.head_commit?.author?.name ?? null,
          sender: p.sender?.login ?? null,
          changes: changesFromPushPayload(payload),
        },
        delivery,
        { onlyServiceId: svc.id },
      );
      return json(200, { ok: true, deployed });
    }
    if (event === "pull_request") {
      const p = payload as PullRequestPayload;
      await handlePullRequest(
        deps,
        p.action,
        hook.repo,
        p.pull_request.base.ref,
        {
          number: p.number,
          title: p.pull_request.title,
          headBranch: p.pull_request.head.ref,
          headSha: p.pull_request.head.sha,
          headRepo: p.pull_request.head.repo?.full_name ?? "",
        },
        p.sender?.login ?? null,
        { id: deliveryId, event: `pull_request.${p.action}` },
        { onlyServiceId: svc.id },
      );
      return json(200, { ok: true });
    }
  } catch (error) {
    deps.logger.error({ err: error, event, serviceId: svc.id }, "a GitHub repository webhook failed");
    return json(500, { error: { code: "INTERNAL", message: "The webhook could not be handled." } });
  }
  record(`Event ${event} needs nothing.`);
  return json(200, { ok: true, ignored: event });
}

export function repoHookRoutes(deps: Deps) {
  return new Elysia().post(`${repoHookPathPrefix}/:hookId`, ({ params, request }) => handleRepoHookDelivery(deps, params.hookId, request), {
    parse: "none",
  });
}
