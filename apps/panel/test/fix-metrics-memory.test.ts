// The metrics ingest forgets services and nodes that stopped reporting, so
// PR previews created and deleted for months do not creep memory.

import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { MetricsReportSchema } from "@seylo/proto";
import { MetricsIngest } from "../src/modules/metrics/ingest";
import { testPanel } from "./helpers";

test("stale live windows and counters are dropped on the hourly prune; deleted services at once", () => {
  const panel = testPanel({ modules: [] });
  const ingest = new MetricsIngest(panel.deps.metrics);
  const at = (ms: number, services: string[]) =>
    create(MetricsReportSchema, {
      time: timestampFromDate(new Date(ms)),
      services: services.map((serviceId) => ({ serviceId, cpuPercent: 1, memoryUsedBytes: 1n })),
    });
  const start = Date.UTC(2026, 10, 5, 10, 0, 0);
  ingest.record("node-a", at(start, ["old-preview", "kept"]));
  ingest.forgetService("kept");
  expect(ingest.latestService("kept").size).toBe(0);
  // Two hours later only "fresh" reports; the hourly prune forgets "old-preview".
  ingest.record("node-a", at(start + 2 * 3_600_000, ["fresh"]));
  expect(ingest.latestService("old-preview").size).toBe(0);
  expect(ingest.latestService("fresh").size).toBe(1);
  panel.close();
});
