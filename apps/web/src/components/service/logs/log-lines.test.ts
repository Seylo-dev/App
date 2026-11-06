import { describe, expect, test } from "bun:test";
import { entryToLine, GenerationTracker } from "./log-lines";

const at = "2026-11-05T10:00:00.000Z";

describe("log lines", () => {
  test("streams map to levels", () => {
    expect(entryToLine({ time: at, stream: "stderr", generation: 1, line: "boom" })).toEqual({
      text: "boom",
      ts: Date.parse(at),
      source: "stderr",
      level: "warn",
    });
    expect(entryToLine({ time: at, stream: "system", generation: 1, line: "deploy" }).level).toBe("system");
  });

  test("a marker line separates generations, not the first one", () => {
    const g = new GenerationTracker();
    const lines = [1, 1, 2, 2, 3].flatMap((generation) =>
      g.lines({ time: at, stream: "stdout", generation, line: `g${generation}` }, entryToLine),
    );
    expect(lines.map((l) => l.text)).toEqual(["g1", "g1", "Generation 2 started", "g2", "g2", "Generation 3 started", "g3"]);
  });
});
