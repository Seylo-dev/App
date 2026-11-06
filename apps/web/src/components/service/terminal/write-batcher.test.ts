import { describe, expect, test } from "bun:test";
import { WriteBatcher } from "./write-batcher";

function manual() {
  const pending: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => {
      pending.push(fn);
      return () => pending.splice(pending.indexOf(fn), 1);
    },
    run: () => {
      for (const fn of pending.splice(0)) fn();
    },
    get armed() {
      return pending.length;
    },
  };
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("WriteBatcher", () => {
  test("many pushes become one write per frame", () => {
    const clock = manual();
    const writes: string[] = [];
    const b = new WriteBatcher((c) => writes.push(text(c)), { schedule: clock.schedule });
    for (let i = 0; i < 10_000; i++) b.push("x");
    expect(clock.armed).toBe(1);
    clock.run();
    expect(writes).toEqual(["x".repeat(10_000)]);
  });

  test("paused output is held and written on resume", () => {
    const clock = manual();
    const writes: string[] = [];
    const b = new WriteBatcher((c) => writes.push(text(c)), { schedule: clock.schedule });
    b.setPaused(true);
    b.push("a");
    b.push(new TextEncoder().encode("b"));
    clock.run();
    expect(writes).toEqual([]);
    b.setPaused(false);
    clock.run();
    expect(writes).toEqual(["ab"]);
  });

  test("while paused, the oldest output is dropped past the cap", () => {
    const clock = manual();
    const writes: string[] = [];
    const b = new WriteBatcher((c) => writes.push(text(c)), { schedule: clock.schedule, maxHeldBytes: 4 });
    b.setPaused(true);
    for (const part of ["11", "22", "33"]) b.push(part);
    b.setPaused(false);
    clock.run();
    expect(writes).toEqual(["2233"]);
  });

  test("drop forgets queued output", () => {
    const clock = manual();
    const writes: string[] = [];
    const b = new WriteBatcher((c) => writes.push(text(c)), { schedule: clock.schedule });
    b.push("gone");
    b.drop();
    clock.run();
    expect(writes).toEqual([]);
  });
});
