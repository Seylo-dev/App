import { describe, expect, test } from "bun:test";
import { type AnalyzeContext, analyzeEnv } from "@seylo/env-analyzer";
import { errorLines, fixTitle, markerSeverity, problemMessage, referenceRanges, secretChips, secretRanges, toMarkers } from "./env-model";

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

  // Fake keys, joined at runtime so secret scanners don't flag the fixture.
  const siteKey = ["0x4AAAAAAA", "Bc3dEf5gH7jK9mN1pQ"].join("");

  test("a framework-public or # @public value stays readable, a # @secret one is hidden", () => {
    const env = analyzeEnv(
      [
        `NEXT_PUBLIC_TURNSTILE_SITE_KEY=${siteKey}`,
        "# @public",
        "API_TOKEN=shown",
        "TITLE=Shop # @secret",
        "NEXT_PUBLIC_DB=postgres://u:pw@h/db",
      ].join("\n"),
      context,
    );
    expect(secretRanges(env.parsed)).toEqual([
      // "TITLE=" is 6 characters.
      { startLineNumber: 4, startColumn: 7, endLineNumber: 4, endColumn: 11 },
      // A password in a URL is still hidden: "NEXT_PUBLIC_DB=postgres://u:" is 28 characters.
      { startLineNumber: 5, startColumn: 29, endLineNumber: 5, endColumn: 31 },
    ]);
  });

  test("chips: Secret on what builds and crash reports treat as a secret, Public on a public name that looks secret", () => {
    const env = analyzeEnv(
      [
        "NODE_ENV=production",
        `NEXT_PUBLIC_TURNSTILE_SITE_KEY=${siteKey}`,
        "NEXT_PUBLIC_API_URL=https://api.example.com",
        "STRIPE_SECRET_KEY=sk_live_123",
        "DB=${{db.INTERNAL_URL}}",
        "# @secret",
        "NEXT_PUBLIC_PREVIEW=x",
        "",
      ].join("\n"),
      context,
    );
    const chips = secretChips(env.parsed, context, "worker");
    expect(chips.map((c) => [c.line, c.secret])).toEqual([
      [2, false],
      [4, true],
      // INTERNAL_URL is sensitive in the context: a reference to a secret.
      [5, true],
      [7, true],
    ]);
    expect(chips[0]?.keyRange).toEqual({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 31 });
    expect(chips[0]?.hover).toEqual([
      "**`NEXT_PUBLIC_TURNSTILE_SITE_KEY` is public** - the framework ships `NEXT_PUBLIC_` variables to every browser.",
      "Builds get it as a build arg too (`ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY`), and crash reports show its value.",
      "Put `# @secret` on the line above it to make it a secret.",
    ]);
    expect(chips[1]?.hover[0]).toBe("**`STRIPE_SECRET_KEY` is a secret** - its name has KEY, TOKEN, SECRET, PASS or the like in it.");
    expect(chips[1]?.hover[1]).toContain("(`RUN --mount=type=secret,id=STRIPE_SECRET_KEY`), not as `ARG STRIPE_SECRET_KEY`");
    expect(chips[1]?.hover[2]).toBe("Not a secret? Put `# @public` on the line above it.");
    expect(chips[2]?.hover[0]).toBe("**`DB` is a secret** - it uses `db.INTERNAL_URL`, which is a secret.");
    expect(chips[3]?.hover[0]).toBe("**`NEXT_PUBLIC_PREVIEW` is a secret** - the `# @secret` comment says so.");
    // The panel's own flag wins over sensitive: an INTERNAL_URL it says is not secret gets no chip.
    const flagged: AnalyzeContext = {
      ...context,
      targets: context.targets.map((target) => ({
        ...target,
        variables: target.variables.map((v) => (v.name === "INTERNAL_URL" ? { ...v, secret: false } : v)),
      })),
    };
    expect(secretChips(env.parsed, flagged, "worker").some((c) => c.line === 5)).toBe(false);
    // Without a context (the shared variables), names, values and comments still decide.
    expect(secretChips(env.parsed, null, "project").map((c) => c.line)).toEqual([2, 4, 7]);
  });
});
