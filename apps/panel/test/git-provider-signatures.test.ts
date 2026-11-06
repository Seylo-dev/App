// Webhook checks for GitLab, Gitea/Forgejo and Bitbucket against recorded
// payloads, and what the panel reads from each payload.

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { normalizeEvent, type PushEvent } from "../src/modules/gitProviders/events";
import {
  deliveryIdOf,
  eventNameOf,
  safeEqual,
  verifyBitbucket,
  verifyDelivery,
  verifyGitea,
  verifyGitlab,
} from "../src/modules/gitProviders/signatures";
import { changesFromPushPayload } from "../src/modules/webhooks/changes";
import { payloadFixture } from "./git-provider-fakes";

const secret = "6f1c0d2e9a8b7c6d5e4f3a2b1c0d9e8f";
const headers = (h: Record<string, string>) => new Headers(h);
const hex = (body: string, key = secret) => createHmac("sha256", key).update(body).digest("hex");

describe("safeEqual", () => {
  test("equal strings only, whatever the lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("GitLab: X-Gitlab-Token", () => {
  test("the hook's own secret passes; another, an empty or a missing one does not", () => {
    expect(verifyGitlab(secret, headers({ "x-gitlab-token": secret }))).toBe(true);
    expect(verifyGitlab(secret, headers({ "x-gitlab-token": `${secret}x` }))).toBe(false);
    expect(verifyGitlab(secret, headers({ "x-gitlab-token": "" }))).toBe(false);
    expect(verifyGitlab(secret, headers({}))).toBe(false);
  });

  test("delivery id: Idempotency-Key first, else the event UUID; the event from X-Gitlab-Event", () => {
    expect(deliveryIdOf("gitlab", headers({ "x-gitlab-event-uuid": "e-1", "idempotency-key": "k-1" }))).toBe("k-1");
    expect(deliveryIdOf("gitlab", headers({ "x-gitlab-event-uuid": "e-1" }))).toBe("e-1");
    expect(deliveryIdOf("gitlab", headers({}))).toBe("");
    expect(eventNameOf("gitlab", headers({ "x-gitlab-event": "Push Hook" }))).toBe("Push Hook");
  });
});

describe("Gitea and Forgejo: HMAC-SHA256 of the body", () => {
  const body = JSON.stringify(payloadFixture("gitea-push"));

  test("X-Gitea-Signature or X-Forgejo-Signature over the exact body passes", () => {
    expect(verifyGitea(secret, body, headers({ "x-gitea-signature": hex(body) }))).toBe(true);
    expect(verifyGitea(secret, body, headers({ "x-forgejo-signature": hex(body) }))).toBe(true);
    expect(verifyGitea(secret, body, headers({ "x-forgejo-signature": "bad", "x-gitea-signature": hex(body) }))).toBe(true);
    expect(verifyGitea(secret, body, headers({ "x-gitea-signature": hex(body).toUpperCase() }))).toBe(true);
  });

  test("another body, another secret or no header fails", () => {
    expect(verifyGitea(secret, `${body} `, headers({ "x-gitea-signature": hex(body) }))).toBe(false);
    expect(verifyGitea(secret, body, headers({ "x-gitea-signature": hex(body, "other") }))).toBe(false);
    expect(verifyGitea(secret, body, headers({ "x-gitea-signature": `sha256=${hex(body)}` }))).toBe(false);
    expect(verifyGitea(secret, body, headers({}))).toBe(false);
  });

  test("delivery id and event, Forgejo's names first", () => {
    expect(deliveryIdOf("gitea", headers({ "x-gitea-delivery": "g-1" }))).toBe("g-1");
    expect(deliveryIdOf("gitea", headers({ "x-gitea-delivery": "g-1", "x-forgejo-delivery": "f-1" }))).toBe("f-1");
    expect(eventNameOf("gitea", headers({ "x-forgejo-event": "push" }))).toBe("push");
    expect(eventNameOf("gitea", headers({ "x-gitea-event": "pull_request" }))).toBe("pull_request");
  });
});

describe("Bitbucket: X-Hub-Signature sha256=", () => {
  const body = JSON.stringify(payloadFixture("bitbucket-push"));

  test("sha256=<hex HMAC> passes; bare hex, sha1 or a wrong one does not", () => {
    expect(verifyBitbucket(secret, body, headers({ "x-hub-signature": `sha256=${hex(body)}` }))).toBe(true);
    expect(verifyBitbucket(secret, body, headers({ "x-hub-signature": hex(body) }))).toBe(false);
    expect(verifyBitbucket(secret, body, headers({ "x-hub-signature": `sha1=${hex(body)}` }))).toBe(false);
    expect(verifyBitbucket(secret, body, headers({ "x-hub-signature": `sha256=${hex(body, "x")}` }))).toBe(false);
    expect(verifyBitbucket(secret, body, headers({}))).toBe(false);
  });

  test("X-Request-UUID is the delivery id, X-Event-Key the event", () => {
    expect(deliveryIdOf("bitbucket", headers({ "x-request-uuid": "b-1" }))).toBe("b-1");
    expect(eventNameOf("bitbucket", headers({ "x-event-key": "repo:push" }))).toBe("repo:push");
  });

  test("verifyDelivery picks the scheme of each provider", () => {
    expect(verifyDelivery("bitbucket", secret, body, headers({ "x-hub-signature": `sha256=${hex(body)}` }))).toBe(true);
    // A Gitea-style header means nothing to a Bitbucket hook.
    expect(verifyDelivery("bitbucket", secret, body, headers({ "x-gitea-signature": hex(body) }))).toBe(false);
    expect(verifyDelivery("gitlab", secret, body, headers({ "x-hub-signature": `sha256=${hex(body)}` }))).toBe(false);
  });
});

describe("reading payloads", () => {
  test("GitLab push: branch, commits' files (removed too), the head's full message, the pusher", () => {
    const [ev] = normalizeEvent("gitlab", "Push Hook", payloadFixture("gitlab-push")) as [PushEvent];
    expect(ev).toMatchObject({
      type: "push",
      repo: "acme/platform/shop",
      branch: "main",
      deleted: false,
      sender: "jdev",
      author: "Jane Dev",
    });
    expect(ev.after).toBe("da1560886d4f094c3e6c9ef40349f7d38b5d27d7");
    expect(ev.changes.before).toBe("95790bf891e76fee5e1747ab589903a6a1f80f22");
    expect(ev.changes.headMessage).toBe("Fix the checkout total\n\nRounds per line.\n");
    expect(ev.changes.truncated).toBe(false);
    expect(ev.changes.files?.sort()).toEqual(
      ["README.md", "apps/web/package.json", "apps/web/src/checkout/old-total.ts", "apps/web/src/checkout/total.ts"].sort(),
    );
  });

  test("GitLab push with more commits than listed is truncated; a deleted branch and a tag say so", () => {
    const payload = { ...payloadFixture("gitlab-push"), total_commits_count: 40 };
    expect((normalizeEvent("gitlab", "Push Hook", payload)[0] as PushEvent).changes.truncated).toBe(true);
    const deleted = { ...payloadFixture("gitlab-push"), after: "0".repeat(40), checkout_sha: null, commits: [] };
    expect(normalizeEvent("gitlab", "Push Hook", deleted)[0]).toMatchObject({ deleted: true });
    const tag = { ...payloadFixture("gitlab-push"), ref: "refs/tags/v1.0.0" };
    expect(normalizeEvent("gitlab", "Push Hook", tag)[0]).toMatchObject({ branch: null });
  });

  test("GitLab merge requests: update with new commits deploys, an edit does not", () => {
    const mr = payloadFixture("gitlab-merge-request");
    expect(normalizeEvent("gitlab", "Merge Request Hook", mr)[0]).toEqual({
      type: "mergeRequest",
      repo: "acme/platform/shop",
      number: 7,
      action: "update",
      event: "merge_request.update",
      sender: "jdev",
    });
    const edit = { ...mr, object_attributes: { ...mr.object_attributes, oldrev: undefined } };
    expect(normalizeEvent("gitlab", "Merge Request Hook", edit)[0]).toMatchObject({ action: "other" });
    for (const [action, mapped] of [
      ["open", "open"],
      ["reopen", "open"],
      ["merge", "close"],
      ["close", "close"],
      ["approved", "other"],
    ] as const) {
      const ev = normalizeEvent("gitlab", "Merge Request Hook", { ...mr, object_attributes: { ...mr.object_attributes, action } })[0];
      expect(ev).toMatchObject({ action: mapped });
    }
    expect(normalizeEvent("gitlab", "Tag Push Hook", {})[0]).toEqual({ type: "ignored", event: "Tag Push Hook" });
  });

  test("Gitea push and pull requests", () => {
    const [push] = normalizeEvent("gitea", "push", payloadFixture("gitea-push")) as [PushEvent];
    expect(push).toMatchObject({
      repo: "acme/shop",
      branch: "main",
      sender: "jdev",
      author: "jdev",
      after: "8d3f2e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e",
    });
    expect(push.changes.files?.sort()).toEqual(["apps/web/package.json", "apps/web/src/checkout/total.ts"]);
    expect(push.changes.truncated).toBe(false);
    const pr = payloadFixture("gitea-pull-request");
    expect(normalizeEvent("gitea", "pull_request", pr)[0]).toMatchObject({
      type: "mergeRequest",
      repo: "acme/shop",
      number: 3,
      action: "open",
    });
    expect(normalizeEvent("gitea", "pull_request", { ...pr, action: "synchronized" })[0]).toMatchObject({ action: "update" });
    expect(normalizeEvent("gitea", "pull_request", { ...pr, action: "closed" })[0]).toMatchObject({ action: "close" });
    expect(normalizeEvent("gitea", "pull_request", { ...pr, action: "label_updated" })[0]).toMatchObject({ action: "other" });
    expect(normalizeEvent("gitea", "create", {})[0]).toEqual({ type: "ignored", event: "create" });
  });

  test("Bitbucket push: one event per branch, no file list (diffstat later), before and after", () => {
    const [push] = normalizeEvent("bitbucket", "repo:push", payloadFixture("bitbucket-push")) as [PushEvent];
    expect(push).toMatchObject({ repo: "acme-ws/shop", branch: "main", deleted: false, sender: "jdev", author: "jdev" });
    expect(push.changes).toEqual({
      files: null,
      truncated: true,
      before: "1e5d8f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e",
      after: "9a6f3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a",
      headMessage: "Fix the checkout total\n",
    });
    const two = payloadFixture("bitbucket-push");
    const change = two.push.changes[0];
    two.push.changes.push({ ...change, new: { ...change.new, name: "dev" } }, { ...change, new: null });
    const events = normalizeEvent("bitbucket", "repo:push", two) as PushEvent[];
    expect(events.map((e) => [e.branch, e.deleted])).toEqual([
      ["main", false],
      ["dev", false],
      ["main", true],
    ]);
  });

  test("Bitbucket pull requests", () => {
    const pr = payloadFixture("bitbucket-pullrequest");
    expect(normalizeEvent("bitbucket", "pullrequest:created", pr)[0]).toMatchObject({ number: 5, action: "open", repo: "acme-ws/shop" });
    expect(normalizeEvent("bitbucket", "pullrequest:updated", pr)[0]).toMatchObject({ action: "update" });
    expect(normalizeEvent("bitbucket", "pullrequest:fulfilled", pr)[0]).toMatchObject({ action: "close" });
    expect(normalizeEvent("bitbucket", "pullrequest:rejected", pr)[0]).toMatchObject({ action: "close" });
    expect(normalizeEvent("bitbucket", "pullrequest:comment_created", pr)[0]).toMatchObject({ action: "other" });
  });
});

describe("push payloads at the deploy trigger URL", () => {
  test("GitHub, GitLab and Gitea shapes and an explicit changedFiles list", () => {
    expect(changesFromPushPayload(payloadFixture("gitea-push"))?.files?.length).toBe(2);
    expect(changesFromPushPayload({ changedFiles: ["a.ts", 3, "b.ts"] })).toEqual({
      files: ["a.ts", "b.ts"],
      truncated: false,
      before: null,
      after: null,
      headMessage: null,
    });
    const github = {
      before: "1".repeat(40),
      after: "2".repeat(40),
      head_commit: { id: "2".repeat(40), message: "Docs only [skip ci]" },
      commits: [{ id: "2".repeat(40), message: "Docs only [skip ci]", added: [], modified: ["docs/a.md"], removed: [] }],
    };
    expect(changesFromPushPayload(github)).toEqual({
      files: ["docs/a.md"],
      truncated: false,
      before: "1".repeat(40),
      after: "2".repeat(40),
      headMessage: "Docs only [skip ci]",
    });
  });

  test("commits without file lists and bodies that are no push", () => {
    expect(changesFromPushPayload({ commits: [{ id: "a".repeat(40), message: "x" }] })?.files).toBeNull();
    expect(changesFromPushPayload({ commits: [] })?.files).toBeNull();
    expect(changesFromPushPayload({ hello: "world" })).toBeNull();
    expect(changesFromPushPayload(["a"])).toBeNull();
    expect(changesFromPushPayload(null)).toBeNull();
  });
});
