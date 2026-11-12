// "Back up now" at the top of the Backups tab (and on a database's
// Connection tab) ran only the first schedule: a service with two volume
// schedules got one backup. It now backs up every enabled schedule
// (backups.runAll) and says how many started; a database with no schedule
// still gets a one-off dump to the first destination.

import { expect, test } from "bun:test";
import { OpError } from "@seylo/ops";
import { backUpNowPlan, type RunAllResult, runAllToast, runNowRefusal } from "./back-up-now";

type Run = RunAllResult["runs"][number];

const run = (over: Partial<Run> = {}): Run => ({
  id: "r000000000000001",
  kind: "backup",
  serviceId: "s000000000000001",
  policyId: "b000000000000001",
  destinationId: "x000000000000001",
  target: "volume",
  volumeId: "v000000000000001",
  volumeName: "data",
  sourceRunId: null,
  sourceStartedAt: null,
  status: "running",
  objectKey: null,
  sizeBytes: null,
  error: null,
  deletedAt: null,
  startedAt: "2026-11-13T09:00:00.000Z",
  finishedAt: null,
  selection: null,
  scope: null,
  contents: null,
  warnings: [],
  ...over,
});

const policy = { id: "b000000000000001" } as never;
const choice = { id: "x000000000000001", name: "acme-backups", provider: "r2" as const, bucket: "acme-backups" };

test("with schedules it backs up all of them; a database without one dumps once to the first destination", () => {
  expect(backUpNowPlan({ kind: "app" }, [policy, policy], [choice])).toEqual({ kind: "schedules" });
  expect(backUpNowPlan({ kind: "postgres" }, [policy], [choice])).toEqual({ kind: "schedules" });
  expect(backUpNowPlan({ kind: "postgres" }, [], [choice])).toEqual({ kind: "oneOff", destinationId: choice.id });
  // Nothing to back up to, an app without a schedule, or schedules not loaded yet: the button is off.
  expect(backUpNowPlan({ kind: "postgres" }, [], [])).toBeNull();
  expect(backUpNowPlan({ kind: "app" }, [], [choice])).toBeNull();
  expect(backUpNowPlan({ kind: "postgres" }, undefined, [choice])).toBeNull();
});

test("the toast counts the backups it started and says why nothing started", () => {
  const two = { runs: [run(), run({ id: "r000000000000002", volumeName: "web-vault" })], skipped: [] };
  expect(runAllToast(two)).toEqual({ tone: "success", text: "Started 2 backups." });
  // A schedule that is off is left out quietly while others start.
  expect(runAllToast({ runs: [run()], skipped: [{ policyId: "b000000000000002", reason: "disabled" }] })).toEqual({
    tone: "success",
    text: "Started 1 backup.",
  });
  expect(runAllToast({ runs: [run()], skipped: [{ policyId: "b000000000000002", reason: "running" }] })).toEqual({
    tone: "success",
    text: "Started 1 backup. 1 was already running.",
  });
  expect(runAllToast({ runs: [], skipped: [{ policyId: "b000000000000002", reason: "disabled" }] })).toEqual({
    tone: "info",
    text: "Every schedule is off, so nothing was backed up. Turn one on, or start it from its own menu.",
  });
  expect(
    runAllToast({
      runs: [],
      skipped: [
        { policyId: "b000000000000001", reason: "running" },
        { policyId: "b000000000000002", reason: "disabled" },
      ],
    }),
  ).toEqual({ tone: "info", text: "Every schedule that is on is already backing up." });
  // One could not start (its node refused it): said, with the reason.
  expect(runAllToast({ runs: [run(), run({ status: "failed", error: "The node is offline." })], skipped: [] })).toEqual({
    tone: "warning",
    text: "Started 1 backup. 1 could not start: The node is offline.",
  });
  // One the panel refused before storing a run (its volume gone) counts too; before, the toast left it out.
  const refused = { policyId: "b000000000000002", reason: "error" as const, error: "That volume does not belong to this service." };
  expect(runAllToast({ runs: [run()], skipped: [refused] })).toEqual({
    tone: "warning",
    text: "Started 1 backup. 1 could not start: That volume does not belong to this service.",
  });
  expect(
    runAllToast({
      runs: [run(), run({ id: "r000000000000002", status: "failed", error: "The node is offline." })],
      skipped: [refused, { policyId: "b000000000000003", reason: "running" }],
    }),
  ).toEqual({ tone: "warning", text: "Started 1 backup. 1 was already running. 2 could not start: The node is offline." });
  // Nothing started and one refused: no "Started 0".
  expect(runAllToast({ runs: [], skipped: [refused, { policyId: "b000000000000003", reason: "disabled" }] })).toEqual({
    tone: "warning",
    text: "1 could not start: That volume does not belong to this service.",
  });
});

// Back up now on a schedule's own menu while that schedule still backs up is refused since 0.2.16
// (CONFLICT, reason running): the toast says so as news, not as a failure.
test("a schedule still backing up is news, other refusals stay errors", () => {
  const running = new OpError("CONFLICT", "A backup of this schedule is still running. Wait for it to finish, then back up again.", {
    reason: "running",
    runId: "r000000000000001",
  });
  expect(runNowRefusal(running)).toEqual({
    tone: "info",
    text: "This schedule is still backing up. Back it up again once that backup is done.",
  });
  const offline = new OpError("UNAVAILABLE", "The node is offline.");
  expect(runNowRefusal(offline)).toEqual({ tone: "error", text: "The node is offline." });
});
