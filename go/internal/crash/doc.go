// Package crash enforces CrashPolicy. Docker's own restart policy is off
// for every container, so each exit reaches the agent, which decides:
// restart after the fixed delay, leave stopped (restart off), or give up
// after stop_after_crashes in a row. Each crash produces a CrashReport with
// the exit code, OOM flag and the last 100 lines; the panel alerts once per
// streak. A streak is per service and ends once a container started after
// its latest crash has stayed up for five minutes; a replica that was up
// all along does not end it. Reconcile keeps the count in runtime.json and
// gives it back with Seed after an agent restart.
//
// Interfaces used by other packages:
//
//   - Tracker: reconcile feeds it container exits and acts on the Decision.
package crash
