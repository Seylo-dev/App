import { expect, test } from "bun:test";
import { hasRunningInstance, type ServiceStatus } from "./status";

const live = { id: "d1", label: "3b8d2aa", createdAt: "2026-11-09T10:00:00Z" };

test("a console can attach while a container runs, and not before", () => {
  const runs = (status: ServiceStatus, over: { stopped?: boolean; liveDeployment?: unknown } = {}) =>
    hasRunningInstance({ status, stopped: false, liveDeployment: live, ...over });
  expect(runs("running")).toBe(true);
  expect(runs("partial")).toBe(true);
  // Failing its health check still runs: the console is how you find out why.
  expect(runs("unhealthy")).toBe(true);
  // A deploy on top of a live version: the old container still runs.
  expect(runs("building")).toBe(true);
  expect(runs("deploying")).toBe(true);
  // The first deploy, or a stopped service mid-deploy: nothing runs yet.
  expect(runs("building", { liveDeployment: null })).toBe(false);
  expect(runs("deploying", { stopped: true })).toBe(false);
  for (const status of ["idle", "starting", "crashed", "stopped", "unknown"] as const) expect(runs(status)).toBe(false);
});
