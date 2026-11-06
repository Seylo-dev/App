import { describe, expect, test } from "bun:test";
import { LogBuffer, visibleRange } from "./log-buffer";

function manual() {
  const queue: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => queue.push(fn),
    flush: () => {
      for (const fn of queue.splice(0)) fn();
    },
    queue,
  };
}

describe("LogBuffer", () => {
  test("keeps the newest lines when full", () => {
    const b = new LogBuffer(3, () => {});
    b.pushMany(["a", "b", "c", "d", "e"]);
    expect(b.length).toBe(3);
    expect(b.toArray().map((l) => l.text)).toEqual(["c", "d", "e"]);
    expect(b.firstSeq).toBe(2);
    expect(b.at(0)?.seq).toBe(2);
    expect(b.at(3)).toBeUndefined();
  });

  test("splits multi-line text and strips escapes for search", () => {
    const b = new LogBuffer(10, () => {});
    b.push({ text: "one\r\n\x1b[31mTwo\x1b[0m\n", source: "build" });
    expect(b.toArray().map((l) => [l.text, l.plain, l.source])).toEqual([
      ["one", "one", "build"],
      ["\x1b[31mTwo\x1b[0m", "Two", "build"],
    ]);
    expect(b.search("two")).toEqual([1]);
  });

  test("notifies once per frame however many pushes", () => {
    const m = manual();
    const b = new LogBuffer(100, m.schedule);
    let calls = 0;
    b.subscribe(() => calls++);
    for (let i = 0; i < 50; i++) b.push(`line ${i}`);
    expect(m.queue.length).toBe(1);
    m.flush();
    expect(calls).toBe(1);
    b.push("again");
    m.flush();
    expect(calls).toBe(2);
  });

  test("caches parsed segments and forgets dropped lines", () => {
    const b = new LogBuffer(1, () => {});
    b.push("\x1b[1mbold");
    const first = b.at(0);
    if (!first) throw new Error("missing line");
    expect(b.segments(first)).toBe(b.segments(first));
    b.push("next");
    expect(b.at(0)?.text).toBe("next");
  });

  test("clear empties the ring", () => {
    const b = new LogBuffer(5, () => {});
    b.pushMany(["a", "b"]);
    b.clear();
    expect(b.length).toBe(0);
    b.push("c");
    expect(b.toArray().map((l) => l.text)).toEqual(["c"]);
  });
});

describe("visibleRange", () => {
  test("window with overscan, clamped to the list", () => {
    expect(visibleRange({ scrollTop: 220, viewport: 110, rowHeight: 22, count: 1000, overscan: 2 })).toEqual([8, 17]);
    expect(visibleRange({ scrollTop: 0, viewport: 500, rowHeight: 22, count: 5 })).toEqual([0, 5]);
    expect(visibleRange({ scrollTop: 0, viewport: 500, rowHeight: 22, count: 0 })).toEqual([0, 0]);
  });
});
