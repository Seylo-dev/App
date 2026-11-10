// Scheduled and disk-triggered cleanup: the schedule ops (checks,
// permissions, audit), the NodeSettings.cleanup the agent gets, the
// CleanupRun reports agents send through their outbox (stored once, alerts
// cleanup_ran off by default and cleanup_failed), and manual runs in the
// same history.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { cleanup, type OpInput } from "@seylo/ops";
import { CleanupTrigger, ReportEventRequestSchema, ReportEventResponseSchema } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { alerts, auditLog, cleanupRuns } from "../src/db/schema";
import { formatSize } from "../src/modules/cleanup/runs";
import { readDefaults } from "../src/modules/notifications/rules";
import type { FakeAgent } from "./fake-agent";
import { callOp, createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
const agents: FakeAgent[] = [];

beforeEach(async () => {
  panel = testPanel();
  url = listen(panel);
  owner = await createUser(panel, "owner");
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

async function join(timeZone = "Europe/Berlin") {
  const agent = await joinAgent(panel, url, { facts: { hostname: "n1", timeZone, agentVersion: "dev" } });
  agents.push(agent);
  return agent;
}

const ok = async <T>(promise: Promise<{ status: number; body: T }>) => {
  const res = await promise;
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

const daily: OpInput<typeof cleanup.setSchedule>["schedule"] = {
  enabled: true,
  cron: "0 4 * * *",
  diskPercent: 80,
  kinds: { images: true, buildCache: true, stoppedContainers: true, unusedVolumes: false },
};

let outbox = 0n;
function report(agent: FakeAgent, run: Record<string, unknown>) {
  outbox += 1n;
  const now = timestampFromDate(new Date());
  return agent.callPanel("ReportEvent", ReportEventRequestSchema, ReportEventResponseSchema, {
    outboxId: outbox,
    event: { payload: { case: "cleanupRun", value: { startedAt: now, finishedAt: now, ...run } } },
  });
}

describe("cleanup schedule", () => {
  test("on by default: a node that never saved a schedule runs the default one; saved off, it stops", async () => {
    // Since 0.2.5 (before: off until turned on).
    const agent = await join();
    const before = await ok(callOp(panel, cleanup.getSchedule, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(before).toMatchObject({
      schedule: { enabled: true, cron: "0 4 * * *", diskPercent: 80, kinds: { unusedVolumes: false } },
      timeZone: "Europe/Berlin",
      supported: true,
    });
    // 04:00 in Berlin is 02:00 or 03:00 UTC.
    expect(before.nextRunAt).toMatch(/T0[23]:00:00\.000Z$/);
    await panel.deps.agents.desired.settled();
    const first = (await agent.waitFor("SyncDesired", 1)).at(-1).state.settings.cleanup;
    expect(first).toMatchObject({ enabled: true, cron: "0 4 * * *", diskPercent: 80, images: true, unusedVolumes: false });

    // Turned off: the setting is not sent at all, and it stays off.
    const syncs = agent.requests("SyncDesired").length;
    await ok(
      callOp(panel, cleanup.setSchedule, { nodeId: agent.nodeId, schedule: { ...daily, enabled: false } }, { cookie: owner.cookie }),
    );
    await panel.deps.agents.desired.settled();
    const off = (await agent.waitFor("SyncDesired", syncs + 1)).at(-1).state.settings;
    expect(off.cleanup).toBeUndefined();
    expect((await ok(callOp(panel, cleanup.getSchedule, { nodeId: agent.nodeId }, { cookie: owner.cookie }))).schedule.enabled).toBe(false);

    // Saved on again with another time: the agent gets it.
    const saved = await ok(
      callOp(panel, cleanup.setSchedule, { nodeId: agent.nodeId, schedule: { ...daily, cron: "30 3 * * *" } }, { cookie: owner.cookie }),
    );
    expect(saved.nextRunAt).toMatch(/T0[12]:30:00\.000Z$/);
    await panel.deps.agents.desired.settled();
    const on = (await agent.waitFor("SyncDesired", syncs + 2)).at(-1).state.settings.cleanup;
    expect(on).toMatchObject({ enabled: true, cron: "30 3 * * *" });

    const audits = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "cleanup.setSchedule")).all();
    expect(audits).toHaveLength(2);
  });

  test("schedules the node could not run are refused; Sunday as 7 is stored as 0", async () => {
    const agent = await join();
    const bad = async (schedule: typeof daily, field: string) => {
      const res = await callOp(panel, cleanup.setSchedule, { nodeId: agent.nodeId, schedule }, { cookie: owner.cookie });
      expect(res.status).toBe(400);
      expect(res.body.error.details?.field).toBe(field);
    };
    await bad({ ...daily, cron: "61 4 * * *" }, "schedule.cron");
    // croner reads L and #, the agent's parser does not.
    await bad({ ...daily, cron: "0 4 L * *" }, "schedule.cron");
    await bad({ ...daily, cron: "0 4 * * 1#2" }, "schedule.cron");
    await bad({ ...daily, cron: null, diskPercent: null }, "schedule");
    await bad({ ...daily, kinds: { images: false, buildCache: false, stoppedContainers: false, unusedVolumes: false } }, "schedule.kinds");
    // Sunday written as 7 (croner reads it, the node's parser does not) is stored as 0.
    await ok(
      callOp(panel, cleanup.setSchedule, { nodeId: agent.nodeId, schedule: { ...daily, cron: "0 4 * * 1-7" } }, { cookie: owner.cookie }),
    );
    const saved = await callOp(panel, cleanup.getSchedule, { nodeId: agent.nodeId }, { cookie: owner.cookie });
    expect(saved.body.schedule.cron).toBe("0 4 * * 1-6,0");
    // The disk line alone is fine, and so is a node that never reported a zone (UTC).
    await ok(callOp(panel, cleanup.setSchedule, { nodeId: agent.nodeId, schedule: { ...daily, cron: null } }, { cookie: owner.cookie }));
  });

  test("members cannot see or change it; read-only keys can read it; models need approval to change it", async () => {
    const agent = await join();
    const member = await createUser(panel, "member");
    expect((await callOp(panel, cleanup.getSchedule, { nodeId: agent.nodeId }, { cookie: member.cookie })).status).toBe(403);
    expect((await callOp(panel, cleanup.setSchedule, { nodeId: agent.nodeId, schedule: daily }, { cookie: member.cookie })).status).toBe(
      403,
    );
    const readOnly = createApiKey(panel, owner.user.id, { readOnly: true });
    expect((await callOp(panel, cleanup.getSchedule, { nodeId: agent.nodeId }, { bearer: readOnly })).status).toBe(200);
    expect((await callOp(panel, cleanup.setSchedule, { nodeId: agent.nodeId, schedule: daily }, { bearer: readOnly })).status).toBe(403);
    expect(cleanup.setSchedule.kind).toBe("destructive");
  });
});

test("alert sizes read like the web app's formatBytes", () => {
  expect(formatSize(3 * 1024 ** 3)).toBe("3 GB");
  expect(formatSize(1.5 * 1024 ** 3)).toBe("1.5 GB");
  expect(formatSize(190840832)).toBe("182 MB");
  expect(formatSize(12.4 * 1024 ** 2)).toBe("12 MB");
  expect(formatSize(0)).toBe("0 B");
});

describe("cleanup runs", () => {
  test("reported runs are stored once, listed newest first and alert as configured", async () => {
    const agent = await join();
    await report(agent, {
      runId: "cleanup-a",
      trigger: CleanupTrigger.DISK,
      reclaimedBytes: 3n << 30n,
      removed: ["image api:old (1.5 GiB): older than the newest 3", "image web:old (1.5 GiB): older than the newest 3"],
      removedCount: 2,
      diskPercent: 91,
    });
    // The outbox retries after a lost answer: still one row.
    await report(agent, { runId: "cleanup-a", trigger: CleanupTrigger.DISK, reclaimedBytes: 3n << 30n, removedCount: 2 });
    await Bun.sleep(20);
    await report(agent, { runId: "cleanup-b", trigger: CleanupTrigger.SCHEDULE, error: "docker: cannot connect to the daemon" });

    const listed = await ok(callOp(panel, cleanup.runs, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    expect(listed.runs.map((r: { trigger: string; status: string }) => [r.trigger, r.status])).toEqual([
      ["schedule", "failed"],
      ["disk", "succeeded"],
    ]);
    expect(listed.runs[1]).toMatchObject({ bytesFreed: 3 * 1024 ** 3, removedCount: 2, diskPercent: 91, startedBy: null });
    expect(listed.runs[1].lines).toHaveLength(2);
    expect(listed.bytesFreed30d).toBe(3 * 1024 ** 3);

    const ran = panel.deps.db.select().from(alerts).where(eq(alerts.event, "cleanup_ran")).all();
    expect(ran).toHaveLength(1);
    // The same number and unit as the Cleanup view (the web's formatBytes).
    expect(ran[0]?.title).toBe("Cleanup on n1 freed 3 GB");
    const failed = panel.deps.db.select().from(alerts).where(eq(alerts.event, "cleanup_failed")).all();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.message).toContain("cannot connect");

    // cleanup_ran only reaches the feed unless someone turns it on; cleanup_failed notifies.
    const rules = readDefaults(panel.deps.db);
    expect(rules.find((r) => r.event === "cleanup_ran")?.enabled).toBe(false);
    expect(rules.find((r) => r.event === "cleanup_failed")?.enabled).toBe(true);
  });

  test("a manual cleanup is in the same history with who ran it", async () => {
    const agent = await join();
    agent.handle("Prune", (req: { dryRun: boolean }) => ({
      reclaimedBytes: req.dryRun ? 0n : 4096n,
      removed: ["container old (4.0 KiB): old generation 3"],
    }));
    await ok(callOp(panel, cleanup.run, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    await ok(callOp(panel, cleanup.preview, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    const listed = await ok(callOp(panel, cleanup.runs, { nodeId: agent.nodeId }, { cookie: owner.cookie }));
    // The preview is not a run.
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]).toMatchObject({ trigger: "manual", status: "succeeded", bytesFreed: 4096, startedBy: "owner" });
    const rows = panel.deps.db
      .select()
      .from(cleanupRuns)
      .where(and(eq(cleanupRuns.nodeId, agent.nodeId), eq(cleanupRuns.trigger, "manual")))
      .all();
    expect(rows[0]?.startedBy).toBe(owner.user.id);
  });
});
