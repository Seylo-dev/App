import { describe, expect, test } from "bun:test";
import { type AnalyzeContext, analyzeEnv } from "@seylo/env-analyzer";
import { errorLines, fixTitle, markerSeverity, problemMessage, referenceRanges, secretRanges, toMarkers } from "./env-model";

const de = { id: "n000000000000001", name: "de-fsn-1" };
const us = { id: "n000000000000002", name: "us-ash-1" };

const context: AnalyzeContext = {
  self: { serviceId: "s000000000000002", name: "worker", nodes: [us] },
  targets: [
    {
      name: "db",
      kind: "service",
      serviceId: "s000000000000003",
      serviceKind: "postgres",
      nodes: [de],
      internalHost: "db",
      exposed: true,
      variables: [
        {
          name: "EXPOSED_URL",
          value: "postgres://x@203.0.113.10:15432/shop",
          scope: "public",
          sensitive: true,
          description: "exposed URL",
        },
        { name: "INTERNAL_URL", value: "postgres://x@db:5432/shop", scope: "internal", sensitive: true, description: "internal URL" },
      ],
    },
  ],
};

const text = [
  "# worker",
  "DATABASE_URL=postgres://app:s3cr3t@db:5432/shop",
  "DB=${{db.INTERNAL_URL}}",
  "STRIPE_SECRET_KEY=sk_live_123",
  "LOG_LEVEL=info",
  "",
].join("\n");

describe("env editor model", () => {
  const { parsed, diagnostics } = analyzeEnv(text, context);

  test("cross-node problems become error markers on the right lines", () => {
    const markers = toMarkers(diagnostics, "worker");
    const lines = markers.filter((m) => m.severity === markerSeverity.error).map((m) => m.startLineNumber);
    expect(lines).toContain(2);
    expect(lines).toContain(3);
    expect(errorLines(diagnostics)).toEqual([2, 3]);
  });

  test("messages come from the catalog with the analyzer's params", () => {
    const d = diagnostics.find((x) => x.range.startLine === 2);
    expect(d && problemMessage(d)).toBe("db runs on another node");
  });

  test("fix titles", () => {
    const d = diagnostics.find((x) => x.range.startLine === 3);
    const titles = (d?.fixes ?? []).map((f) => fixTitle(f, "worker"));
    expect(titles).toContain("Use ${{db.EXPOSED_URL}}");
    expect(titles).toContain("Move worker to de-fsn-1");
  });

  test("references get pills", () => {
    expect(referenceRanges(parsed)).toEqual([{ startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 24 }]);
  });

  test("secrets: whole values of secret keys and URL passwords only", () => {
    const ranges = secretRanges(parsed);
    // s3cr3t in the URL on line 2: "DATABASE_URL=postgres://app:" is 28 characters.
    expect(ranges).toContainEqual({ startLineNumber: 2, startColumn: 29, endLineNumber: 2, endColumn: 35 });
    // sk_live_ stays readable; only 123 is masked.
    expect(ranges).toContainEqual({ startLineNumber: 4, startColumn: 27, endLineNumber: 4, endColumn: 30 });
    expect(ranges.some((r) => r.startLineNumber === 5)).toBe(false);
    expect(ranges.some((r) => r.startLineNumber === 3)).toBe(false);
  });

  test("secrets keep what identifies them: a DSN's host, nothing of a plain secret", () => {
    const env = analyzeEnv(
      ["SENTRY_DSN=https://abc123@o1.ingest.sentry.io/1", "SESSION_SECRET=hunter2", "PG_PASSWORD=postgres://u:pw@h/db"].join("\n"),
      context,
    );
    const r = secretRanges(env.parsed);
    // "SENTRY_DSN=https://" is 19 characters: abc123 is columns 20-26.
    expect(r).toContainEqual({ startLineNumber: 1, startColumn: 20, endLineNumber: 1, endColumn: 26 });
    expect(r).toContainEqual({ startLineNumber: 2, startColumn: 16, endLineNumber: 2, endColumn: 23 });
    // A URL in a secret key: only the password, "PG_PASSWORD=postgres://u:" is 25 characters.
    expect(r).toContainEqual({ startLineNumber: 3, startColumn: 26, endLineNumber: 3, endColumn: 28 });
    expect(r).toHaveLength(3);
  });
});
