import { expect, test } from "bun:test";
import { OpError, type OpOutput, type panelMove } from "@seylo/ops";
import { followMovePoll, lostMove, lostPollMs, lostRetryMs, movedLinks } from "./panel-move";

type MoveStatus = OpOutput<typeof panelMove.status>;

const running = (over: Partial<MoveStatus> = {}): MoveStatus => ({
  state: "running",
  side: null,
  moveId: "move000000000001",
  targetNodeId: "newnode000000002",
  targetNodeName: "de-fsn-2",
  targetAddress: "203.0.113.20",
  newUrl: "http://203.0.113.20:3000",
  step: "switching",
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: "2026-11-11T10:00:00.000Z",
  error: null,
  leftBehind: [],
  doneAt: null,
  fromNodeId: "oldnode000000001",
  fromNodeName: "de-fsn-1",
  oldCopyRemoved: false,
  domain: null,
  canCancel: false,
  waitingSince: null,
  canForceCancel: false,
  oldPanelRunning: false,
  ...over,
});

const unreachable = new OpError("UNAVAILABLE", "The panel could not be reached.");

test("a move past the switch whose panel stopped answering shows as moved, with the last status's new address", () => {
  const lost = lostMove({ data: running(), error: unreachable });
  expect(lost?.moved).toBe(true);
  expect(lost?.status.state).toBe("done");
  expect(lost?.status.side).toBe("old");
  expect(lost?.status.newUrl).toBe("http://203.0.113.20:3000");
  expect(lost?.status.targetNodeName).toBe("de-fsn-2");
  expect(lost?.status.canCancel).toBe(false);
  // A proxy in front of the stopped panel: its 502 or 404 page.
  expect(lostMove({ data: running(), error: new OpError("UNAVAILABLE", "Unexpected response (HTTP 502).") })?.moved).toBe(true);
  expect(lostMove({ data: running(), error: new OpError("INTERNAL", "Unexpected response (HTTP 404).") })?.moved).toBe(true);
  expect(lostMove({ data: running(), error: new TypeError("Failed to fetch") })?.moved).toBe(true);
});

test("before the switch went ahead a panel that stopped answering is not called moved: the last status, as it was", () => {
  // Nothing is committed before the switch: an old panel that comes back fails the move (recover.ts).
  for (const step of ["pausing", "registry", "snapshot", "shipping", "starting", "staging"] as const) {
    const last = running({ step, canCancel: true });
    const lost = lostMove({ data: last, error: unreachable });
    expect(lost?.moved).toBe(false);
    expect(lost?.status).toBe(last);
    expect(lost?.status.newUrl).toBe("http://203.0.113.20:3000");
  }
  // The target keeps the switch waiting: it may never take it.
  const waiting = running({ waitingSince: "2026-11-11T10:00:00.000Z" });
  expect(lostMove({ data: waiting, error: unreachable })).toEqual({ status: waiting, moved: false });
  expect(lostMove({ data: running({ step: null }), error: unreachable })?.moved).toBe(false);
});

test("not without a failure, not for the panel's own refusals, not for a move that does not run", () => {
  expect(lostMove({ data: running(), error: null })).toBeNull();
  expect(lostMove({ data: running({ step: "shipping" }), error: null })).toBeNull();
  expect(lostMove({ data: undefined, error: unreachable })).toBeNull();
  expect(lostMove({ data: running(), error: new OpError("UNAUTHENTICATED", "Sign in again.") })).toBeNull();
  expect(lostMove({ data: running({ step: "shipping" }), error: new OpError("FORBIDDEN", "No.") })).toBeNull();
  expect(lostMove({ data: running({ state: "failed" }), error: unreachable })).toBeNull();
});

test("the status polls while a move runs and stops asking a panel that stopped answering after the switch", () => {
  const now = 10_000_000;
  const poll = followMovePoll(2000, () => now);
  expect(poll({ state: { data: running({ step: "shipping" }), error: null, dataUpdatedAt: now - 1000 } })).toBe(2000);
  expect(poll({ state: { data: running({ state: "done", side: "old" }), error: null, dataUpdatedAt: now } })).toBe(false);
  expect(poll({ state: { data: undefined, error: null, dataUpdatedAt: 0 } })).toBe(false);
  // Gone a short while: it may be back (a restart), keep asking.
  expect(poll({ state: { data: running(), error: unreachable, dataUpdatedAt: now - 30_000 } })).toBe(2000);
  // Gone for good: no more requests to the dead address.
  expect(poll({ state: { data: running(), error: unreachable, dataUpdatedAt: now - lostPollMs - 1 } })).toBe(false);
  // A panel that answers keeps being followed however long the switch waits.
  expect(
    poll({ state: { data: running({ waitingSince: "2026-11-11T10:00:00.000Z" }), error: null, dataUpdatedAt: now - lostPollMs - 1 } }),
  ).toBe(2000);
});

test("before the switch a panel that stopped answering is asked less often, never given up on", () => {
  const now = 10_000_000;
  const poll = followMovePoll(2000, () => now);
  const banner = followMovePoll(5000, () => now);
  for (const step of ["shipping", "staging"] as const) {
    // A short while: as often as before.
    expect(poll({ state: { data: running({ step }), error: unreachable, dataUpdatedAt: now - 30_000 } })).toBe(2000);
    // Minutes: every 30 seconds, so a panel that comes back (and fails the move) is noticed.
    expect(poll({ state: { data: running({ step }), error: unreachable, dataUpdatedAt: now - lostPollMs - 1 } })).toBe(lostRetryMs);
    expect(banner({ state: { data: running({ step }), error: unreachable, dataUpdatedAt: now - lostPollMs - 1 } })).toBe(lostRetryMs);
  }
  const waiting = running({ waitingSince: "2026-11-11T10:00:00.000Z" });
  expect(poll({ state: { data: waiting, error: unreachable, dataUpdatedAt: now - lostPollMs - 1 } })).toBe(lostRetryMs);
});

test("the old copy links the new IP address first and the domain second", () => {
  expect(movedLinks({ newUrl: "http://203.0.113.20:3000", domain: "panel.acme.dev" })).toEqual({
    url: "http://203.0.113.20:3000",
    domainUrl: "https://panel.acme.dev",
  });
  expect(movedLinks({ newUrl: "http://203.0.113.20:3000", domain: null })).toEqual({ url: "http://203.0.113.20:3000", domainUrl: null });
  expect(movedLinks({ newUrl: null, domain: "panel.acme.dev" })).toEqual({ url: "https://panel.acme.dev", domainUrl: null });
  expect(movedLinks({ newUrl: null, domain: null })).toEqual({ url: null, domainUrl: null });
});
