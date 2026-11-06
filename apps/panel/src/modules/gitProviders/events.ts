// Turns a verified delivery into the few things the panel acts on: a push
// to a branch, or a merge/pull request that opened, got new commits or
// closed. Only the repository, branch, numbers and changed files are read
// from the payload; titles, heads and fork checks of merge requests are
// read from the provider's API afterwards (gitProviders/push.ts).

import type { GitProviderKind } from "../../db/schema";
import { changesFromPushPayload, type PushChanges } from "../webhooks/changes";
import { isNullSha } from "./client";

export interface PushEvent {
  type: "push";
  repo: string;
  /** null for tag pushes. */
  branch: string | null;
  deleted: boolean;
  after: string | null;
  changes: PushChanges;
  author: string | null;
  sender: string | null;
}

export interface MergeRequestEvent {
  type: "mergeRequest";
  repo: string;
  number: number;
  /** open: opened or reopened; update: new commits; close: closed or merged; other: needs nothing. */
  action: "open" | "update" | "close" | "other";
  /** The provider's own word, for the delivery log ("merge_request.update"). */
  event: string;
  sender: string | null;
}

export type ProviderEvent = PushEvent | MergeRequestEvent | { type: "ping" } | { type: "ignored"; event: string };

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const branchOf = (ref: unknown): string | null => {
  const r = str(ref);
  return r?.startsWith("refs/heads/") ? r.slice("refs/heads/".length) : null;
};

function gitlab(event: string, p: Json): ProviderEvent[] {
  const repo = str(obj(p.project).path_with_namespace) ?? "";
  if (event === "Push Hook" || p.object_kind === "push") {
    const changes = changesFromPushPayload(p) ?? { files: null, truncated: false, before: null, after: null, headMessage: null };
    const after = str(p.after);
    const head = (Array.isArray(p.commits) ? (p.commits as Json[]) : []).find((c) => str(c.id) === after);
    return [
      {
        type: "push",
        repo,
        branch: branchOf(p.ref),
        deleted: isNullSha(after) || p.checkout_sha === null,
        after,
        changes,
        author: str(obj(head?.author).name),
        sender: str(p.user_username) ?? str(p.user_name),
      },
    ];
  }
  if (event === "Merge Request Hook" || p.object_kind === "merge_request") {
    const attrs = obj(p.object_attributes);
    const action = str(attrs.action) ?? "";
    // "update" also fires for title or label edits; only one with new commits (oldrev) needs a deploy.
    const mapped =
      action === "open" || action === "reopen"
        ? "open"
        : action === "update"
          ? attrs.oldrev
            ? "update"
            : "other"
          : action === "close" || action === "merge"
            ? "close"
            : "other";
    return [
      {
        type: "mergeRequest",
        repo,
        number: Number(attrs.iid),
        action: mapped,
        event: `merge_request.${action || "unknown"}`,
        sender: str(obj(p.user).username),
      },
    ];
  }
  return [{ type: "ignored", event }];
}

function gitea(event: string, p: Json): ProviderEvent[] {
  const repo = str(obj(p.repository).full_name) ?? "";
  if (event === "push") {
    const changes = changesFromPushPayload(p) ?? { files: null, truncated: false, before: null, after: null, headMessage: null };
    const head = obj(p.head_commit);
    return [
      {
        type: "push",
        repo,
        branch: branchOf(p.ref),
        deleted: isNullSha(str(p.after)),
        after: str(p.after),
        changes,
        author: str(obj(head.author).username) ?? str(obj(head.author).name),
        sender: str(obj(p.pusher).login) ?? str(obj(p.sender).login),
      },
    ];
  }
  if (event === "pull_request" || event === "pull_request_sync") {
    const action = str(p.action) ?? "";
    const mapped =
      action === "opened" || action === "reopened"
        ? "open"
        : action === "synchronized"
          ? "update"
          : action === "closed"
            ? "close"
            : "other";
    return [
      {
        type: "mergeRequest",
        repo,
        number: Number(p.number ?? obj(p.pull_request).number),
        action: mapped,
        event: `pull_request.${action || "unknown"}`,
        sender: str(obj(p.sender).login),
      },
    ];
  }
  return [{ type: "ignored", event }];
}

function bitbucket(event: string, p: Json): ProviderEvent[] {
  const repo = str(obj(p.repository).full_name) ?? "";
  const actor = obj(p.actor);
  const sender = str(actor.nickname) ?? str(actor.display_name);
  if (event === "repo:push") {
    const changes = Array.isArray(obj(p.push).changes) ? (obj(p.push).changes as Json[]) : [];
    const out: ProviderEvent[] = [];
    for (const change of changes) {
      const next = change.new ? obj(change.new) : null;
      const old = change.old ? obj(change.old) : null;
      const ref = next ?? old;
      const branch = ref && ref.type === "branch" ? str(ref.name) : null;
      const target = obj(next?.target);
      const author = obj(target.author);
      const after = str(target.hash);
      out.push({
        type: "push",
        repo,
        branch,
        deleted: next === null,
        after,
        // Bitbucket lists no files: they always come from the diffstat API.
        changes: { files: null, truncated: true, before: str(obj(old?.target).hash), after, headMessage: str(target.message) },
        author: str(obj(author.user).nickname) ?? str(author.raw)?.replace(/\s*<[^>]*>$/, "") ?? null,
        sender,
      });
    }
    return out.length > 0 ? out : [{ type: "ignored", event }];
  }
  if (event.startsWith("pullrequest:")) {
    const kind = event.slice("pullrequest:".length);
    const mapped =
      kind === "created" ? "open" : kind === "updated" ? "update" : kind === "fulfilled" || kind === "rejected" ? "close" : "other";
    return [{ type: "mergeRequest", repo, number: Number(obj(p.pullrequest).id), action: mapped, event: `pull_request.${kind}`, sender }];
  }
  return [{ type: "ignored", event }];
}

/** The events in one delivery (Bitbucket can carry several branches in one push). */
export function normalizeEvent(kind: GitProviderKind, event: string, payload: unknown): ProviderEvent[] {
  const p = obj(payload);
  switch (kind) {
    case "gitlab":
      return gitlab(event, p);
    case "gitea":
      return gitea(event, p);
    case "bitbucket":
      return bitbucket(event, p);
  }
}
