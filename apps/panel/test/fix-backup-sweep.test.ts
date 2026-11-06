// A backup whose result never arrives (agent killed, node removed) is failed
// after 12 hours with an alert, instead of showing as running forever; a late
// success still counts.

import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { BackupResultSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { alerts, backupRuns } from "../src/db/schema";
import { backupDeadlineMs, recordBackupResult, sweepStaleBackups } from "../src/modules/backups/runs";
import { testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

test("stale running backups fail with an alert; a late success upgrades them", () => {
  const panel = testPanel({ modules: [] });
  const node = seedNode(panel);
  const service = seedService(panel, { projectId: seedProject(panel).id, name: "db", nodeIds: [node.id] });
  const now = new Date();
  const run = panel.deps.db
    .insert(backupRuns)
    .values({
      serviceId: service.id,
      nodeId: node.id,
      target: "database",
      status: "running",
      startedAt: new Date(now.getTime() - backupDeadlineMs - 1000),
    })
    .returning()
    .get();
  expect(sweepStaleBackups(panel.deps, now)).toBe(1);
  expect(panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, run.id)).get()?.status).toBe("failed");
  expect(
    panel.deps.db
      .select()
      .from(alerts)
      .all()
      .map((a) => a.event),
  ).toContain("backup_failed");
  const late = create(BackupResultSchema, { runId: run.id, success: true, objectKey: "k", sizeBytes: 10n });
  expect(recordBackupResult(panel.deps, node.id, late)).toBe(true);
  expect(panel.deps.db.select().from(backupRuns).where(eq(backupRuns.id, run.id)).get()?.status).toBe("succeeded");
  panel.close();
});
