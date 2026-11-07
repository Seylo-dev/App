// POST /api/hooks/github: GitHub's webhooks for the panel's App. The body
// is checked against the App's webhook secret (X-Hub-Signature-256) before
// anything is parsed; deliveries are logged and deduplicated by GUID.

import { readBodyText } from "@seylo/ops/elysia";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { githubInstallations } from "../../db/schema";
import type { Deps } from "../../deps";
import { bodyRefused } from "../../http/body";
import { clientIp } from "../../http/client-ip";
import { addressKey } from "../../http/ip-ranges";
import { createRateLimiter, type RateLimiter } from "../../ops/rate-limit";
import { changesFromPushPayload } from "../webhooks/changes";
import { alreadyHandled, recordDelivery } from "../webhooks/deliveries";
import { recordRejected, replayedBody } from "../webhooks/replay";
import { appRow, forgetTokens, githubWebhookPath, verifySignature, webhookSecret } from "./app";
import { type GithubInstallationPayload, upsertInstallation } from "./ops";
import { handlePullRequest, handlePush } from "./push";

const maxBody = 5 * 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface PushPayload {
  ref: string;
  deleted?: boolean;
  before?: string;
  after: string;
  repository: { full_name: string };
  head_commit: { id: string; message: string; author?: { name?: string; username?: string } } | null;
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
  repository: { full_name: string };
  sender?: { login: string };
}

interface InstallationPayload {
  action: string;
  installation: GithubInstallationPayload;
}

/** Handles one verified delivery. Exported for tests. */
export async function handleGithubEvent(
  deps: Deps,
  event: string,
  deliveryId: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  if (event === "ping") return { status: 200, body: { ok: true } };
  if (alreadyHandled(deps.db, deliveryId)) return { status: 200, body: { ok: true, duplicate: true } };

  if (event === "installation" || event === "installation_repositories") {
    const p = payload as InstallationPayload;
    const app = appRow(deps.db);
    if (app && p.installation) {
      if (p.action === "deleted")
        deps.db.delete(githubInstallations).where(eq(githubInstallations.installationId, p.installation.id)).run();
      else
        upsertInstallation(deps.db, app.id, {
          ...p.installation,
          suspended_at: p.action === "suspend" ? new Date().toISOString() : p.action === "unsuspend" ? null : p.installation.suspended_at,
        });
      forgetTokens(deps.db);
      deps.live.publish("panel", { type: "invalidate", ops: ["github.installations"] });
    }
    return { status: 200, body: { ok: true } };
  }

  if (event === "push") {
    const p = payload as PushPayload;
    if (!p.ref?.startsWith("refs/heads/") || p.deleted) {
      recordDelivery(deps.db, {
        source: "github",
        deliveryId,
        event,
        serviceId: null,
        outcome: "ignored",
        detail: p.deleted ? "Branch deleted." : "Not a branch push.",
      });
      return { status: 200, body: { ok: true, deployed: 0 } };
    }
    const deployed = await handlePush(
      deps,
      {
        repo: p.repository.full_name,
        branch: p.ref.slice("refs/heads/".length),
        sha: p.head_commit?.id ?? p.after,
        message: p.head_commit?.message.split("\n")[0] ?? null,
        author: p.head_commit?.author?.username ?? p.head_commit?.author?.name ?? null,
        sender: p.sender?.login ?? null,
        changes: changesFromPushPayload(payload),
      },
      { id: deliveryId, event, source: "github" },
    );
    return { status: 200, body: { ok: true, deployed } };
  }

  if (event === "pull_request") {
    const p = payload as PullRequestPayload;
    await handlePullRequest(
      deps,
      p.action,
      p.pull_request.base.repo.full_name,
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
    );
    return { status: 200, body: { ok: true } };
  }

  return { status: 200, body: { ok: true, ignored: event } };
}

/**
 * Unverified deliveries per sending address. Anyone may post here and each
 * try costs reading up to 5 MiB and a hash of it, so a delivery takes a
 * token before its body is read, and one whose signature verifies gives it
 * back. Only deliveries being read and refused ones (bad signature, too
 * large, a replayed body) count: an address gets a burst of 60 of those,
 * then 1 per second. GitHub sends every delivery of every installation
 * from a few addresses and does not retry a refused one, so its signed
 * deliveries must never use the bucket up, however busy the organisation.
 * The bytes held by all body reads at once are capped by the shared body
 * budget (bodyBudget in @seylo/ops/elysia).
 */
const senderRules = { standard: { burst: 60, refillPerSecond: 1 }, strict: { burst: 60, refillPerSecond: 1 } };
const senderLimiters = new WeakMap<object, RateLimiter>();

function senderLimiter(deps: Pick<Deps, "db">): RateLimiter {
  let limiter = senderLimiters.get(deps.db);
  if (!limiter) {
    limiter = createRateLimiter(senderRules);
    senderLimiters.set(deps.db, limiter);
  }
  return limiter;
}

export function githubWebhookRoute(deps: Deps) {
  return new Elysia().post(
    githubWebhookPath,
    async ({ request, server }) => {
      // Nothing is read for a panel without an App, and never more than maxBody.
      const secret = webhookSecret(deps.db, deps.secrets);
      if (!secret) return json(404, { error: { code: "NOT_FOUND", message: "This panel has no GitHub App." } });
      const peer = server?.requestIP(request)?.address ?? null;
      const sender = `github-hook:${addressKey(clientIp(request, peer, deps.proxy.trusts(peer)))}`;
      const limiter = senderLimiter(deps);
      const wait = limiter.take(sender, "standard");
      if (wait > 0) {
        return new Response(
          JSON.stringify({ error: { code: "RATE_LIMITED", message: `Too many refused deliveries. Try again in ${wait} seconds.` } }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": String(wait) } },
        );
      }
      const read = await readBodyText(request, maxBody);
      if (!read.ok) {
        // "busy" is the panel's state, not something this sender did.
        if (read.reason === "busy") limiter.refund(sender, "standard");
        return bodyRefused(read.reason);
      }
      const raw = read.text;
      const deliveryId = (request.headers.get("x-github-delivery") ?? "").slice(0, 64);
      const event = (request.headers.get("x-github-event") ?? "unknown").slice(0, 64);
      if (!verifySignature(secret, raw, request.headers.get("x-hub-signature-256"))) {
        recordRejected(deps.db, { source: "github", event, serviceId: null, detail: "The signature did not match." });
        return json(401, { error: { code: "UNAUTHENTICATED", message: "The signature did not match." } });
      }
      // GitHub always sends one; without it the dedupe below could not work.
      if (!deliveryId) return json(400, { error: { code: "BAD_REQUEST", message: "X-GitHub-Delivery is missing." } });
      if (event !== "ping" && replayedBody(deps.db, "github", deliveryId, raw)) {
        recordRejected(deps.db, {
          source: "github",
          event,
          serviceId: null,
          detail: "The same signed body was already delivered under another id (replay).",
        });
        return json(200, { ok: true, duplicate: true });
      }
      // Signed by GitHub and new: it does not count against the sender.
      limiter.refund(sender, "standard");
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return json(400, { error: { code: "BAD_REQUEST", message: "The body is not JSON." } });
      }
      try {
        const result = await handleGithubEvent(deps, event, deliveryId, payload);
        return json(result.status, result.body);
      } catch (error) {
        deps.logger.error({ err: error, event }, "GitHub webhook failed");
        return json(500, { error: { code: "INTERNAL", message: "The webhook could not be handled." } });
      }
    },
    { parse: "none" },
  );
}
