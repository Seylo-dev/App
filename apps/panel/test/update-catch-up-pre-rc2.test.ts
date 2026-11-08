// Steps a panel before 0.2.0-rc.2 skipped because the node was offline
// ("it updates itself when it starts") have no retry after migration 0002,
// and their runs kept no manifest. Before, a node that was offline during
// such a run and only reconnected to the rc.2 panel got nothing. Now the
// panel's start makes the newest such step of a node wait (unless a later
// run included the node), and the catch-up installs the stored release
// when it is that version or newer.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updates } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { jobs, updateRuns, updateSteps } from "../src/db/schema";
import { adoptOldSkips, oldOfflineSkipMessage } from "../src/modules/updates/catch-up";
import { releaseSource } from "../src/modules/updates/manifest";
import { setSetting } from "../src/settings";
import type { FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";
import { serveReleases } from "./release-fakes";

const panels: TestPanel[] = [];
const agents: FakeAgent[] = [];
const dirs: string[] = [];
const original = { ...releaseSource };

afterEach(async () => {
  Object.assign(releaseSource, original);
  for (const agent of agents.splice(0)) await agent.close();
  for (const panel of panels.splice(0)) {
    await panel.app.stop(true);
    panel.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const masterKey = crypto.getRandomValues(new Uint8Array(32));

function start(panelPath: string) {
  const panel = testPanel({ panelPath, masterKey });
  panels.push(panel);
  return { panel, url: listen(panel) };
}

async function stop(panel: TestPanel) {
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
  panels.splice(panels.indexOf(panel), 1);
}

async function drain(panel: TestPanel) {
  for (let i = 0; i < 20; i++) if ((await panel.runner.runDue(panel.deps)) === 0) return;
}

async function connect(panel: TestPanel, url: string, version: string, node?: FakeAgent) {
  const agent = await joinAgent(panel, url, {
    ...(node ? { nodeId: node.nodeId, key: node.key } : {}),
    agentVersion: version,
    facts: { agentVersion: version },
  });
  agent.handle("UpdateAgent", () => ({}));
  agents.push(agent);
  return agent;
}

/** What a panel before rc.2 left: a finished run with no manifest, and this node's step skipped with the old message. */
function oldRun(panel: TestPanel, nodeId: string, targetVersion: string, minutesAgo: number, status: "skipped" | "failed" = "skipped") {
  const run = panel.deps.db
    .insert(updateRuns)
    .values({
      targetVersion,
      trigger: "manual",
      status: "succeeded",
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
      finishedAt: new Date(Date.now() - minutesAgo * 60_000),
    })
    .returning()
    .get();
  return panel.deps.db
    .insert(updateSteps)
    .values({
      runId: run.id,
      position: 0,
      target: "agent",
      nodeId,
      fromVersion: "0.8.0",
      toVersion: targetVersion,
      status,
      error: status === "skipped" ? oldOfflineSkipMessage : null,
      finishedAt: new Date(),
    })
    .returning()
    .get();
}

const step = (panel: TestPanel, id: string) => panel.deps.db.select().from(updateSteps).where(eq(updateSteps.id, id)).get();

test("a node a panel before rc.2 skipped as offline catches up to the newer stored release after the upgrade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-catch-up-"));
  dirs.push(dir);
  const panelPath = join(dir, "panel.db");

  // The rc.1 panel: a run to 0.9.0 skipped `lagging` (offline) and `later`,
  // which a later run included; `current` was skipped too but runs 0.9.0 now.
  const before = start(panelPath);
  const owner = await createUser(before.panel, "owner");
  const lagging = await connect(before.panel, before.url, "0.8.0");
  const later = await connect(before.panel, before.url, "0.8.0");
  const current = await connect(before.panel, before.url, "0.9.0");
  const laggingStep = oldRun(before.panel, lagging.nodeId, "0.9.0", 30);
  const laterStep = oldRun(before.panel, later.nodeId, "0.9.0", 30);
  const laterRunStep = oldRun(before.panel, later.nodeId, "0.9.0", 20, "failed");
  const currentStep = oldRun(before.panel, current.nodeId, "0.9.0", 30);
  // The upgrade's release check: 0.9.1 is the stored release.
  serveReleases([{ tag: "v0.9.1" }, { tag: "v0.9.0" }]);
  expect((await callOp(before.panel, updates.check, {}, { cookie: owner.cookie })).status).toBe(200);
  await stop(before.panel);

  // The rc.2 panel starts on the same panel.db. Before: every retry stayed null.
  const after = start(panelPath);
  expect(step(after.panel, laggingStep.id)?.retry).toBe("waiting");
  expect(step(after.panel, currentStep.id)?.retry).toBe("waiting");
  expect(step(after.panel, laterStep.id)?.retry).toBeNull();
  expect(step(after.panel, laterRunStep.id)?.retry).toBeNull();
  // Once only: a second sweep changes nothing.
  expect(adoptOldSkips(after.panel.deps.db)).toBe(0);

  // The node only reconnects (no restart). Before: no UpdateAgent and no job.
  const back = await connect(after.panel, after.url, "0.8.0", lagging);
  await drain(after.panel);
  const request = (await back.waitFor("UpdateAgent"))[0];
  expect(request).toMatchObject({ targetVersion: "0.9.1", automatic: true });
  expect(new TextDecoder().decode(request.manifest)).toContain('"0.9.1"');
  const retried = step(after.panel, laggingStep.id);
  expect(retried?.retry).toBe("retried");
  const run = after.panel.deps.db
    .select()
    .from(updateRuns)
    .where(eq(updateRuns.id, retried?.retryRunId ?? ""))
    .get();
  expect(run).toMatchObject({ trigger: "reconnect", targetVersion: "0.9.1", status: "running" });
  expect(
    after.panel.deps.db
      .select()
      .from(updateSteps)
      .where(eq(updateSteps.runId, run?.id ?? ""))
      .get(),
  ).toMatchObject({
    nodeId: lagging.nodeId,
    fromVersion: "0.8.0",
    toVersion: "0.9.1",
  });

  // The later run superseded `later`'s skip; `current` is up to date.
  const laterBack = await connect(after.panel, after.url, "0.8.0", later);
  const currentBack = await connect(after.panel, after.url, "0.9.0", current);
  await drain(after.panel);
  expect(laterBack.requests("UpdateAgent")).toHaveLength(0);
  expect(currentBack.requests("UpdateAgent")).toHaveLength(0);
  expect(step(after.panel, currentStep.id)?.retry).toBe("up_to_date");
  expect(step(after.panel, laterStep.id)?.retry).toBeNull();
});

test("a step from before rc.2 waits while the stored release is older than its version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-catch-up-"));
  dirs.push(dir);
  const { panel, url } = start(join(dir, "panel.db"));
  const owner = await createUser(panel, "owner");
  // Back on stable: the stored release is 0.8.5, the old run went to an RC.
  serveReleases([{ tag: "v0.9.0-rc.1" }, { tag: "v0.8.5" }]);
  expect((await callOp(panel, updates.check, {}, { cookie: owner.cookie })).status).toBe(200);
  const node = await connect(panel, url, "0.8.0");
  const old = oldRun(panel, node.nodeId, "0.9.0-rc.1", 30);
  expect(adoptOldSkips(panel.deps.db)).toBe(1);
  await node.close();
  for (let i = 0; i < 100 && panel.deps.agents.isOnline(node.nodeId); i++) await Bun.sleep(5);

  const back = await connect(panel, url, "0.8.0", node);
  await drain(panel);
  // Nothing older than the step's version is installed in its place.
  expect(back.requests("UpdateAgent")).toHaveLength(0);
  expect(step(panel, old.id)?.retry).toBe("waiting");
  expect(panel.deps.db.select().from(jobs).where(eq(jobs.type, "updates.catchUp")).all()).toHaveLength(1);
});

test("a node that rolled the newer stored release back is held, not sent it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seylo-catch-up-"));
  dirs.push(dir);
  const { panel, url } = start(join(dir, "panel.db"));
  const owner = await createUser(panel, "owner");
  serveReleases([{ tag: "v0.9.1" }, { tag: "v0.9.0" }]);
  expect((await callOp(panel, updates.check, {}, { cookie: owner.cookie })).status).toBe(200);
  const node = await connect(panel, url, "0.8.0");
  const old = oldRun(panel, node.nodeId, "0.9.0", 30);
  setSetting(panel.deps.db, "updateRollbacks", { [node.nodeId]: [{ version: "0.9.1", count: 1, at: new Date().toISOString() }] });
  expect(adoptOldSkips(panel.deps.db)).toBe(1);
  await node.close();
  for (let i = 0; i < 100 && panel.deps.agents.isOnline(node.nodeId); i++) await Bun.sleep(5);

  const back = await connect(panel, url, "0.8.0", node);
  await drain(panel);
  expect(back.requests("UpdateAgent")).toHaveLength(0);
  expect(step(panel, old.id)?.retry).toBe("held");
  expect(panel.deps.db.select().from(updateRuns).all()).toHaveLength(1);
});
