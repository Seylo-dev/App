// Jobs that hold their slot for a long time (uptime probes, restores, moves)
// run in a small lane of their own, so they never starve alert delivery,
// backups and the sweeps.

import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs } from "../src/db/schema";
import { defineJob } from "../src/jobs/queue";
import { testPanel } from "./helpers";

test("slow jobs fill only their own lane; default jobs still run", async () => {
  const panel = testPanel({ modules: [] });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  panel.runner.register([
    defineJob({ type: "test.slow", lane: "slow", maxAttempts: 1, run: () => gate }),
    defineJob({ type: "test.fast", maxAttempts: 1, run: async () => {} }),
  ]);
  for (let i = 0; i < 6; i++) panel.runner.enqueue("test.slow", { i });
  panel.runner.enqueue("test.fast", {}, { runAt: new Date(Date.now() + 1) });
  const done = panel.runner.runDue(panel.deps, new Date(Date.now() + 1000));
  await Bun.sleep(20);
  const status = (type: string) =>
    panel.deps.db
      .select({ s: jobs.status })
      .from(jobs)
      .where(eq(jobs.type, type))
      .all()
      .map((r) => r.s);
  expect(status("test.fast")).toEqual(["succeeded"]);
  expect(status("test.slow").filter((s) => s === "running")).toHaveLength(2);
  release();
  await done;
  panel.close();
});
