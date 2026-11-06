// POST /api/hooks/github: GitHub's webhooks for the panel's App. The body
// is checked against the App's webhook secret (X-Hub-Signature-256) before
// anything is parsed; deliveries are logged and deduplicated by GUID.

import { createHash } from "node:crypto";
import { readBodyText } from "@seylo/ops/elysia";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { githubInstallations } from "../../db/schema";
import type { Deps } from "../../deps";
import { alreadyHandled, recordDelivery } from "../webhooks/deliveries";
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

/** Rejected deliveries recorded per hour at most: enough to see a wrong secret, not a disk filler. */
const rejectedPerHour = 20;
/** How long a signed body is remembered against replays (GitHub redelivers for 3 days). */
const replayWindowMs = 3 * 24 * 3600 * 1000;
const seenBodies = new WeakMap<object, Map<string, { deliveryId: string; at: number }>>();
const rejectedCount = new WeakMap<object, { hour: number; n: number }>();

function recordRejected(deps: Deps, deliveryId: string, event: string, detail: string): void {
  const hour = Math.floor(Date.now() / 3_600_000);
  const count = rejectedCount.get(deps.db);
  const current = count?.hour === hour ? count : { hour, n: 0 };
  current.n += 1;
  rejectedCount.set(deps.db, current);
  if (current.n > rejectedPerHour) return;
  recordDelivery(deps.db, { source: "github", deliveryId, event, serviceId: null, outcome: "rejected", detail });
}

/**
 * Whether this signed body was already handled under another delivery id. The
 * signature covers only the body, so a captured push re-sent with a fresh
 * X-GitHub-Delivery would otherwise deploy that old commit again. GitHub's own
 * redeliveries keep their id and pass.
 */
function replayed(deps: Deps, deliveryId: string, raw: string): boolean {
  let seen = seenBodies.get(deps.db);
  if (!seen) {
    seen = new Map();
    seenBodies.set(deps.db, seen);
  }
  const now = Date.now();
  for (const [hash, entry] of seen) {
    if (now - entry.at <= replayWindowMs && seen.size <= 10_000) break;
    seen.delete(hash);
  }
  const hash = createHash("sha256").update(raw).digest("hex");
  const before = seen.get(hash);
  if (before && before.deliveryId !== deliveryId) return true;
  seen.set(hash, { deliveryId, at: now });
  return false;
}

export function githubWebhookRoute(deps: Deps) {
  return new Elysia().post(
    githubWebhookPath,
    async ({ request }) => {
      // Nothing is read for a panel without an App, and never more than maxBody.
      const secret = webhookSecret(deps.db, deps.secrets);
      if (!secret) return json(404, { error: { code: "NOT_FOUND", message: "This panel has no GitHub App." } });
      const raw = await readBodyText(request, maxBody);
      if (raw === null) return json(413, { error: { code: "BAD_REQUEST", message: "Payload too large." } });
      const deliveryId = (request.headers.get("x-github-delivery") ?? "").slice(0, 64);
      const event = (request.headers.get("x-github-event") ?? "unknown").slice(0, 64);
      if (!verifySignature(secret, raw, request.headers.get("x-hub-signature-256"))) {
        recordRejected(deps, deliveryId || "missing", event, "The signature did not match.");
        return json(401, { error: { code: "UNAUTHENTICATED", message: "The signature did not match." } });
      }
      // GitHub always sends one; without it the dedupe below could not work.
      if (!deliveryId) return json(400, { error: { code: "BAD_REQUEST", message: "X-GitHub-Delivery is missing." } });
      if (event !== "ping" && replayed(deps, deliveryId, raw)) {
        recordRejected(deps, deliveryId, event, "The same signed body was already delivered under another id (replay).");
        return json(200, { ok: true, duplicate: true });
      }
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
