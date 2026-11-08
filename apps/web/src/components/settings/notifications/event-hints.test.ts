import { expect, test } from "bun:test";
import { t } from "../../../i18n/t";

test("the Crash hint says what a crash alert carries", () => {
  // recordCrash (apps/panel/src/modules/alerts/events.ts) sends the exit code or "out of memory" and what the node
  // did next. The agent's last 100 lines are kept with the crash report, not sent with the alert.
  const hint = t("settingsNotifications.events.crash.hint");
  expect(hint).not.toMatch(/\d+ log lines/);
  expect(hint).toContain("out of memory");
  expect(hint).toContain("once per crash streak");
});

test("the Stopped after repeated crashes hint says it needs restarts on", () => {
  // crash_limit comes from CRASH_ACTION_GAVE_UP, which go/internal/crash/tracker.go reports only when restart on crash
  // is on and "Stop after crashes in a row" is reached; with restarts off the service is LEFT_STOPPED and no
  // crash_limit alert fires.
  const hint = t("settingsNotifications.events.crash_limit.hint");
  expect(hint).not.toMatch(/\boff\b/);
  expect(hint).toContain("Restarts are on");
  expect(hint).toContain(t("serviceAdvanced.crash.stopAfter"));
});
