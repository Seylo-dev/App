import { expect, test } from "bun:test";
import { followExitForMs, followStep } from "./use-terminal-session";

// After a restart the console used to stop at "exited · Reconnect"; it follows the new process now.
test("following an exit: 1 s, then doubling to 8 s, for two minutes, never without a window", () => {
  const start = 1_000_000;
  const until = start + followExitForMs;
  let delay = 1000;
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    const step = followStep({ until, delay }, start);
    expect(step).not.toBeNull();
    waits.push(step?.wait ?? 0);
    delay = step?.nextDelay ?? delay;
  }
  expect(waits).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  // Past the two minutes, or no exit to follow: stop and show Reconnect.
  expect(followStep({ until, delay: 1000 }, until)).toBeNull();
  expect(followStep({ until: 0, delay: 1000 }, start)).toBeNull();
});
