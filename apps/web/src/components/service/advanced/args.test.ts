import { describe, expect, test } from "bun:test";
import { joinArgs, splitArgs } from "./args";

describe("command lines", () => {
  test("split like a shell for words and quotes", () => {
    expect(splitArgs("bun run start")).toEqual(["bun", "run", "start"]);
    expect(splitArgs(`sh -c "curl -f http://localhost:3000/health"`)).toEqual(["sh", "-c", "curl -f http://localhost:3000/health"]);
    expect(splitArgs("echo 'a b' \"\"")).toEqual(["echo", "a b", ""]);
    expect(splitArgs("  ")).toEqual([]);
  });
  test("join round-trips", () => {
    for (const args of [
      ["bun", "run", "start"],
      ["sh", "-c", "echo it's ok && exit 0"],
      ["a", ""],
    ]) {
      expect(splitArgs(joinArgs(args))).toEqual(args);
    }
  });
});
