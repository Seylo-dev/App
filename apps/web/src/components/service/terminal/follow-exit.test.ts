import { expect, test } from "bun:test";
import { OpError } from "@seylo/ops";
import {
  type ConsoleClose,
  type ConsoleRun,
  consoleMayAttach,
  consoleRun,
  consoleStep,
  nothingToAttach,
  retryFirstMs,
  retryStep,
  socketClose,
  ticketFailure,
  waitNote,
} from "./follow";

const live = { id: "d1", label: "3b8d2aa", createdAt: "2026-11-09T10:00:00Z" };

// After a restart the console used to stop at "exited · Reconnect"; then it followed the new process for two
// minutes only, and any other close ended at "Disconnected. Reconnect" while the app ran (owner, 2026-11-12).
test("a closed console connects again while its app runs or starts, with no time limit", () => {
  for (const run of ["running", "starting"] as const) {
    expect(consoleStep(run, "exited")).toBe("connect");
    // A network drop, the panel or the agent going away, a deploy that replaced the container.
    expect(consoleStep(run, "dropped")).toBe("connect");
  }
  // The waits: 1 s, doubling to 8 s, and 8 s from there on for as long as it runs.
  let delay = retryFirstMs;
  const waits: number[] = [];
  for (let i = 0; i < 40; i++) {
    const step = retryStep(delay);
    waits.push(step.wait);
    delay = step.nextDelay;
  }
  expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  expect(waits.every((w) => w <= 8000)).toBe(true);
  expect(waits.at(-1)).toBe(8000);
});

test("while nothing runs it waits for the app instead of showing Disconnected, and connects once it runs", () => {
  for (const run of ["stopped", "unknown"] as const)
    for (const close of ["exited", "dropped", "idle"] as const) {
      expect(consoleStep(run, close)).toBe("wait");
      expect(consoleStep(run, close, true)).toBe("wait");
    }
  // Entering the page, a status change, the tab shown again, the network back: it runs now, so connect.
  for (const close of ["exited", "dropped", "idle"] as const) expect(consoleStep("running", close, true)).toBe("connect");
  expect(waitNote("stopped", "exited")).toBe("serviceTerminal.waitNotRunning");
  expect(waitNote("unknown", "dropped")).toBe("serviceTerminal.waitUnknown");
  expect(waitNote("starting", "dropped")).toBe("serviceTerminal.waitStarting");
  expect(waitNote("running", "exited")).toBe("serviceTerminal.reconnecting");
  expect(waitNote("running", "dropped")).toBe("serviceTerminal.retrying");
});

test("a refusal that will not change by itself stops at Reconnect; an idle session waits for a nudge", () => {
  for (const run of ["running", "starting", "stopped", "unknown"] as const satisfies readonly ConsoleRun[]) {
    expect(consoleStep(run, "refused")).toBe("stop");
    expect(consoleStep(run, "refused", true)).toBe("stop");
  }
  // The panel ended it after 30 minutes without output: not again by itself, which would defeat the
  // timeout, but when the tab is looked at again or something changes.
  expect(consoleStep("running", "idle")).toBe("stop");
  expect(consoleStep("running", "idle", true)).toBe("connect");

  const refused = (code: ConstructorParameters<typeof OpError>[0]) => ticketFailure(new OpError(code, "no"));
  for (const code of ["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED", "BAD_REQUEST", "CONFLICT", "NOT_IMPLEMENTED"] as const)
    expect(refused(code), code).toBe("refused");
  // The panel or the node did not answer: that passes.
  for (const code of ["UNAVAILABLE", "INTERNAL", "RATE_LIMITED"] as const) expect(refused(code), code).toBe("dropped");
  expect(ticketFailure(new Error("bug"))).toBe("refused");
});

test("a socket's close says why it ended", () => {
  const closed = (code: number, reason: string, exited = false): ConsoleClose => socketClose({ code, reason }, exited);
  expect(closed(1000, "exited", true)).toBe("exited");
  expect(closed(1000, "idle")).toBe("idle");
  // The ticket was not taken: asking again gets the same answer.
  expect(closed(4401, "ticket not valid")).toBe("refused");
  // The agent stream failed, the session ended, the network dropped, the panel restarted.
  expect(closed(1011, "closed")).toBe("dropped");
  expect(closed(1000, "ended")).toBe("dropped");
  expect(closed(1006, "")).toBe("dropped");
  expect(closed(1001, "")).toBe("dropped");
});

test("what the console can attach to, from the service's live status", () => {
  const run = (status: Parameters<typeof consoleRun>[0]["status"], over: { stopped?: boolean; liveDeployment?: unknown } = {}) =>
    consoleRun({ status, stopped: false, liveDeployment: live, ...over });
  expect(run("running")).toBe("running");
  expect(run("unhealthy")).toBe("running");
  expect(run("deploying")).toBe("running");
  // Started a moment ago: a container may be on its way, so it tries.
  expect(run("starting")).toBe("starting");
  expect(run("unknown")).toBe("unknown");
  // Stopped, crashed and left by the crash policy, never deployed, a first deploy with nothing live.
  expect(run("stopped", { stopped: true })).toBe("stopped");
  expect(run("crashed")).toBe("stopped");
  expect(run("idle", { liveDeployment: null })).toBe("stopped");
  expect(run("deploying", { liveDeployment: null })).toBe("stopped");
  expect(run("starting", { stopped: true })).toBe("stopped");
  expect(["running", "starting", "unknown", "stopped"].filter((r) => consoleMayAttach(r as ConsoleRun))).toEqual(["running", "starting"]);
});

test("a starting app's ticket without a container opens no socket; a running app's always does", () => {
  expect(nothingToAttach("starting", null)).toBe(true);
  expect(nothingToAttach("starting", "c0ffee")).toBe(false);
  // The agent finds the container itself, and older ticket sources say nothing about one.
  expect(nothingToAttach("running", null)).toBe(false);
  expect(nothingToAttach("starting", undefined)).toBe(false);
  // A shell follows nothing.
  expect(nothingToAttach(undefined, null)).toBe(false);
});
