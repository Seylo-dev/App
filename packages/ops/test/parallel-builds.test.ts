// "Builds at once" on Auto: one build per 4 cores and per 4 GiB of
// memory, whichever allows fewer, 1 to 16. The panel sends it to the agent
// and the web app shows it from this one function.

import { expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { autoParallelBuilds, maxParallelBuildsLimit, nodes } from "../src";

const gib = 1024 ** 3;

test("Auto is the smaller of cores / 4 and memory / 4 GiB, from 1 to 16", () => {
  const cases: [string, number, number | bigint, number][] = [
    ["4 cores, 8 GB", 4, 8 * gib, 1],
    // The owner's nodes on 2026-11-12: il-ra, il-tlv and start-app (the panel node).
    ["28 cores, 157 GiB", 28, 157 * gib, 7],
    ["32 cores, 121 GiB", 32, 121 * gib, 8],
    ["4 cores, 7.75 GiB", 4, 7.75 * gib, 1],
    ["128 cores, 512 GiB", 128, 512n * BigInt(gib), 16],
    ["64 cores, 8 GiB", 64, 8 * gib, 2],
    ["2 cores", 2, 4 * gib, 1],
    ["2 cores, a lot of memory", 2, 64 * gib, 1],
    ["memory under 4 GiB", 16, 3.9 * gib, 1],
  ];
  for (const [name, cpuCores, memoryTotalBytes, want] of cases) {
    expect([name, autoParallelBuilds({ cpuCores, memoryTotalBytes })]).toEqual([name, want]);
  }
});

test("no facts, or an agent that sends no cores or memory, is 1", () => {
  expect(autoParallelBuilds(null)).toBe(1);
  expect(autoParallelBuilds(undefined)).toBe(1);
  expect(autoParallelBuilds({ cpuCores: 0, memoryTotalBytes: 0 })).toBe(1);
  expect(autoParallelBuilds({ cpuCores: 32, memoryTotalBytes: 0n })).toBe(1);
  expect(autoParallelBuilds({ cpuCores: 0, memoryTotalBytes: 121 * gib })).toBe(1);
  expect(autoParallelBuilds({ cpuCores: Number.NaN, memoryTotalBytes: 121 * gib })).toBe(1);
});

test("the contracts: the view says Auto, updateSettings takes it, old calls stay valid", () => {
  expect(maxParallelBuildsLimit).toBe(16);
  expect(nodes.Node.required).toContain("parallelBuildsAuto");
  const input = nodes.updateSettings.input;
  expect(Value.Check(input, { nodeId: "node000000000001", parallelBuildsAuto: true })).toBe(true);
  expect(Value.Check(input, { nodeId: "node000000000001", parallelBuildsAuto: false, maxParallelBuilds: 4 })).toBe(true);
  // The 0.2.13 shape.
  expect(Value.Check(input, { nodeId: "node000000000001", maxParallelBuilds: 16 })).toBe(true);
  expect(Value.Check(input, { nodeId: "node000000000001", maxParallelBuilds: 17 })).toBe(false);
  // MCP callers read the description: it must explain Auto and its formula.
  expect(nodes.updateSettings.description).toContain("one build per 4 CPU cores and per 4 GiB of memory");
  expect(nodes.updateSettings.description).toContain("parallelBuildsAuto true together with maxParallelBuilds is BAD_REQUEST");
});
