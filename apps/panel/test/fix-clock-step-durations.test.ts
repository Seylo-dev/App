// The wall clock can step back (NTP) between a deploy's start and its end.
// A deploy that changed no container finished 81ms "before" it started on
// an e2e VM, and its negative duration failed the deployments.list output
// schema: every list of that service answered 500.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { deployments as deploymentOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { deployments } from "../src/db/schema";
import { initialSteps, setStep } from "../src/modules/deployments/store";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { seedProject, seedService } from "./hub-helpers";

let panel: TestPanel;

beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

test("a step that ends after the clock stepped back lasts 0ms, not a negative time", () => {
  const started = setStep(initialSteps(false), "ship", "running", {}, 1_000_000);
  const ended = setStep(started, "ship", "ok", {}, 999_915);
  expect(ended.find((s) => s.key === "ship")?.durationMs).toBe(0);
});

test("deployments.list answers for a deploy that finished before it started", async () => {
  const fleet = new FakeFleet(panel);
  const nodeId = fleet.addNode("node-a");
  const { cookie } = await createUser(panel, "owner");
  const svc = seedService(panel, seedProject(panel).id, nodeId);
  const startedAt = new Date(1_794_153_266_266);
  // As stored before the clamp: the deploy's end 81ms before its start, and
  // a finished step whose duration went negative.
  const steps = initialSteps(false).map((s) => (s.key === "ship" ? { ...s, status: "ok" as const, durationMs: -85 } : s));
  const row = panel.deps.db
    .insert(deployments)
    .values({
      serviceId: svc.id,
      generation: 7,
      trigger: "manual",
      status: "live",
      actor: "test",
      startedAt,
      finishedAt: new Date(startedAt.getTime() - 81),
      steps,
    } as never)
    .returning()
    .get();

  const res = await callOp(panel, deploymentOps.list, { serviceId: svc.id }, { cookie });
  expect(res.status).toBe(200);
  const listed = (
    res.body.deployments as { id: string; durationMs: number | null; steps: { key: string; durationMs: number | null }[] }[]
  ).find((d) => d.id === row.id);
  expect(listed?.durationMs).toBe(0);
  expect(listed?.steps.find((s) => s.key === "ship")?.durationMs).toBe(0);
  expect(panel.deps.db.select().from(deployments).where(eq(deployments.id, row.id)).get()?.status).toBe("live");
});
