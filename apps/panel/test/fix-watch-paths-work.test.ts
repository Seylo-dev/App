// Watch paths cannot stall the panel: one deploy trigger call with the
// most patterns and the largest body of long paths returns at once (the
// matcher stops at its work budget and the push deploys), and a CI body's
// changedFiles list is capped like the commits path.

import { expect, test } from "bun:test";
import { matchWatchPaths, maxChangedPathLength, maxWatchPathLength, maxWatchPaths } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { deploymentLogs, deployTriggers, services, webhookDeliveries } from "../src/db/schema";
import { readSpec } from "../src/modules/services/spec";
import { changesFromPushPayload } from "../src/modules/webhooks/changes";
import { hashToken } from "../src/security/tokens";
import { testPanel } from "./helpers";
import { seedProject, seedService, settleDeploys } from "./seed-helpers";

test("a trigger call with 50 star patterns and a 5 MiB list of long paths answers in well under a second and deploys", async () => {
  const panel = testPanel();
  try {
    const service = seedService(panel, { projectId: seedProject(panel).id, name: "api" });
    // 299 characters each: "a*" x 149 and a last letter no path has.
    const star = "a*".repeat(Math.floor((maxWatchPathLength - 1) / 2));
    const watchPaths = Array.from({ length: maxWatchPaths }, (_, i) => `${star}${String.fromCharCode(99 + (i % 20))}`);
    expect(watchPaths.every((p) => p.length <= maxWatchPathLength)).toBe(true);
    panel.deps.db
      .update(services)
      .set({ spec: { ...(service.spec as object), watchPaths } })
      .where(eq(services.id, service.id))
      .run();
    const token = "trigger-token-for-the-watch-paths-test";
    panel.deps.db
      .insert(deployTriggers)
      .values({ serviceId: service.id, tokenHash: hashToken(token), hint: "test" })
      .run();
    // About 1,280 paths of 4,096 characters: the largest body the trigger reads (5 MiB).
    const changedFiles = Array.from({ length: 1270 }, () => `${"a".repeat(maxChangedPathLength - 1)}b`);
    const body = JSON.stringify({ changedFiles });
    expect(body.length).toBeGreaterThan(5_000_000);

    const started = performance.now();
    const response = await panel.app.handle(
      new Request(`http://panel.test/api/hooks/deploy/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body }),
    );
    const took = performance.now() - started;
    // Before: the matcher walked every live state of every pattern for every file, about 570 s of blocked event loop.
    expect(took).toBeLessThan(1000);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { deploymentId: string; queued: boolean; skipped?: string };
    expect(answer.skipped).toBeUndefined();
    expect(readSpec(panel.deps.db.select().from(services).where(eq(services.id, service.id)).get()?.spec).watchPaths).toEqual(watchPaths);
    const log = panel.deps.db
      .select()
      .from(deploymentLogs)
      .where(eq(deploymentLogs.deploymentId, answer.deploymentId))
      .all()
      .map((l) => l.text);
    expect(log.join("\n")).toContain("Watch paths: too many changed files to match");
    const deliveries = panel.deps.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.serviceId, service.id)).all();
    expect(deliveries.every((d) => d.outcome !== "ignored")).toBe(true);
    await settleDeploys(panel);
  } finally {
    panel.close();
  }
});

test("a CI body lists at most 20,000 changed files; more makes the list truncated, which deploys", () => {
  const files = Array.from({ length: 20_001 }, (_, i) => `docs/page-${i}.md`);
  const changes = changesFromPushPayload({ changedFiles: files });
  expect(changes?.files).toHaveLength(20_000);
  expect(changes?.truncated).toBe(true);
  expect(changesFromPushPayload({ changedFiles: files.slice(0, 3) })).toMatchObject({ files: files.slice(0, 3), truncated: false });
  // None of the kept files match, but the cut list must not skip the push.
  const result = matchWatchPaths(["src/**"], changes?.files ?? null, !changes?.truncated);
  expect(result).toMatchObject({ deploy: true, reason: "incomplete" });
});
