import { expect, test } from "bun:test";
import { createServerClock } from "./server-clock";

/** The Date header a panel whose clock is `skew` ms ahead sends at local time `at` (whole seconds, like HTTP dates). */
const dateAt = (at: number, skew: number) => new Date(Math.floor((at + skew) / 1000) * 1000).toUTCString();

test("a browser clock 30 s behind the panel's: the panel's time comes from the Date headers, within a second", () => {
  let local = Date.parse("2026-11-13T02:28:30.400Z");
  const clock = createServerClock(() => local);
  const skew = 30_000;
  for (let i = 0; i < 6; i++) {
    const sent = local;
    local += 80;
    clock.observe(dateAt(local - 40, skew), sent, local);
    local += 777;
  }
  expect(Math.abs(clock.offsetMs() - skew)).toBeLessThan(1000);
  // A deploy that started on the panel 7 s ago shows 0:07, not 0:37.
  const startedAt = local + skew - 7000;
  expect(Math.round((clock.now() - startedAt) / 1000)).toBe(7);
});

test("synced clocks: no offset, so nothing moves by the header's rounding", () => {
  let local = Date.parse("2026-11-13T02:28:30.900Z");
  const clock = createServerClock(() => local);
  for (let i = 0; i < 5; i++) {
    const sent = local;
    local += 30;
    clock.observe(dateAt(local - 15, 0), sent, local);
    local += 333;
  }
  expect(clock.offsetMs()).toBe(0);
  expect(clock.now()).toBe(local);
});

test("no header, or one that is not a date, changes nothing; a clock set since starts the estimate over", () => {
  let local = Date.parse("2026-11-13T02:00:00.000Z");
  const clock = createServerClock(() => local);
  clock.observe(null, local, local + 10);
  clock.observe("yesterday", local, local + 10);
  expect(clock.offsetMs()).toBe(0);
  clock.observe(dateAt(local + 5, -60_000), local, local + 10);
  expect(Math.abs(clock.offsetMs() + 60_000)).toBeLessThan(1000);
  // The browser's clock was corrected by a minute: the old windows no longer overlap the new one.
  local += 60_000;
  clock.observe(dateAt(local + 5, -120_000), local, local + 10);
  expect(Math.abs(clock.offsetMs() + 120_000)).toBeLessThan(1000);
});
