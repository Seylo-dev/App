import { expect, test } from "bun:test";
import { t } from "../../i18n/t";
import { deploymentLook, hasRunningInstance, type ServiceStatus, serviceChipLook, serviceDot, serviceLook } from "./status";

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

test("a building deploy or service whose build waits for a slot says so instead of Building", () => {
  expect(t(serviceLook("building").label)).toBe("Building");
  expect(t(serviceLook("building", true).label)).toBe("Waiting for a build slot");
  expect(t(deploymentLook("building").label)).toBe("Building");
  expect(t(deploymentLook("building", true).label)).toBe("Waiting for a build slot");
  // It looks like a queued deploy: nothing runs for it yet.
  expect(deploymentLook("building", true)).toMatchObject({ tone: "gray", dot: "off" });
  // Only a building one: the flag means nothing for the other states.
  expect(t(serviceLook("running", true).label)).toBe("Running");
  expect(t(deploymentLook("deploying", true).label)).toBe("Deploying");
});

test("the header chip of a live service with a deploy going on: the deploy's words, the dot of what runs", () => {
  const waiting = serviceChipLook({ status: "building", buildWaiting: true, runtimeStatus: "running", liveDeployment: live });
  expect(t(waiting.label)).toBe("Waiting for a build slot");
  expect(waiting).toMatchObject({ tone: "gray", dot: "ok", pulse: false });
  const deploying = serviceChipLook({ status: "deploying", buildWaiting: false, runtimeStatus: "crashed", liveDeployment: live });
  expect(t(deploying.label)).toBe("Deploying");
  expect(deploying).toMatchObject({ tone: "amber", dot: "error", pulse: false });
  // A stack's member (ServiceDetail.members) reads the same fields.
  expect(serviceDot({ status: "building", buildWaiting: false, runtimeStatus: "starting", liveDeployment: live })).toEqual({
    dot: "busy",
    pulse: true,
  });
});

test("a first deploy's chip: busy while it builds or rolls out, a pending ring while its build waits", () => {
  const first = { liveDeployment: null, runtimeStatus: "idle" as const };
  expect(serviceChipLook({ ...first, status: "building", buildWaiting: true })).toMatchObject({ dot: "pending", pulse: true });
  expect(serviceChipLook({ ...first, status: "building", buildWaiting: false })).toMatchObject({ dot: "busy", pulse: true });
  expect(serviceChipLook({ ...first, status: "deploying", runtimeStatus: "starting" })).toMatchObject({ dot: "busy", pulse: true });
  // Without runtimeStatus (a panel before 0.2.17) waiting stays the gray dot of a queued deploy.
  expect(serviceChipLook({ status: "building", buildWaiting: true, liveDeployment: null })).toMatchObject({ dot: "off", pulse: true });
});
