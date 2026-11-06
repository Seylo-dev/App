// deployments.tick and github.poll used to re-enqueue themselves with their
// own dedupe key while still running, which the queue drops: they ran once
// per process. Both are schedules now and keep running.

import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs } from "../src/db/schema";
import deploymentsModule from "../src/modules/deployments";
import githubModule from "../src/modules/github";
import { testPanel } from "./helpers";

test("the deployment tick and the GitHub poll run again on the next interval", async () => {
  const panel = testPanel({ modules: [deploymentsModule, githubModule] });
  const count = (type: string) => panel.deps.db.select().from(jobs).where(eq(jobs.type, type)).all().length;
  const start = Date.now();
  for (let i = 0; i < 3; i++) await panel.runner.runDue(panel.deps, new Date(start + i * 70_000));
  expect(count("deployments.tick")).toBe(3);
  expect(count("github.poll")).toBe(3);
  panel.close();
});
