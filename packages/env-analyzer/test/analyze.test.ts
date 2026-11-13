import { describe, expect, test } from "bun:test";
import {
  type AnalyzeContext,
  analyzeEnv,
  appVariables,
  builtinVariablesFor,
  clickhouseVariables,
  databaseVariables,
  describeReference,
  parseEnv,
  referenceCompletions,
  resolveEnv,
} from "../src";

const fsn = { id: "n1", name: "de-fsn-1" };
const ash = { id: "n2", name: "us-ash-1" };

// The design's example: worker on us-ash-1, db exposed on de-fsn-1, redis internal-only on de-fsn-1.
const context: AnalyzeContext = {
  self: { serviceId: "worker", name: "worker", nodes: [ash] },
  targets: [
    {
      name: "db",
      kind: "service",
      serviceId: "dbid",
      serviceKind: "postgres",
      nodes: [fsn],
      internalHost: "db",
      exposed: true,
      variables: databaseVariables.map((v) => ({
        ...v,
        value: v.name === "EXPOSED_URL" ? "postgres://external:pw@db.example.com:5433/shop" : `v-${v.name}`,
      })),
    },
    {
      name: "redis",
      kind: "service",
      serviceId: "redisid",
      serviceKind: "redis",
      nodes: [fsn],
      internalHost: "redis",
      exposed: false,
      variables: [
        { name: "INTERNAL_URL", value: "redis://redis:6379", scope: "internal", sensitive: false, description: "" },
        { name: "EXPOSED_URL", value: "", scope: "public", sensitive: false, description: "" },
      ],
    },
    {
      name: "api",
      kind: "service",
      serviceId: "apiid",
      serviceKind: "app",
      nodes: [ash],
      internalHost: "api",
      exposed: true,
      variables: [
        { name: "URL", value: "https://api.de1.example.com", scope: "public", sensitive: false, description: "public URL" },
        { name: "INTERNAL_URL", value: "http://api:3000", scope: "internal", sensitive: false, description: "" },
      ],
    },
    {
      name: "project",
      kind: "shared",
      serviceId: null,
      serviceKind: null,
      nodes: [],
      internalHost: null,
      exposed: false,
      variables: [{ name: "SMTP_HOST", value: "smtp.example.com", scope: "plain", sensitive: false, description: "shared variable" }],
    },
  ],
};

const codes = (text: string) => analyzeEnv(text, context).diagnostics.map((d) => [d.code, d.range.startLine]);

describe("analyzeEnv", () => {
  test("clean file has no diagnostics", () => {
    const text =
      "NODE_ENV=production\nDATABASE_URL=${{db.EXPOSED_URL}}\nAPI_URL=${{api.URL}}\nAPI_INTERNAL=${{api.INTERNAL_URL}}\nSMTP=${{project.SMTP_HOST}}\n";
    expect(codes(text)).toEqual([]);
  });

  test("literal internal address of a service on another node", () => {
    const text = "# worker\nNODE_ENV=production\nQ=8\nDATABASE_URL=postgres://app:secret@db:5432/shop?sslmode=disable\n";
    const result = analyzeEnv(text, context);
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0];
    expect(d?.code).toBe("internal-address-other-node");
    expect(d?.message).toBe("db runs on another node");
    expect(d && text.slice(d.range.start, d.range.end)).toBe("db:5432");
    expect(d?.range.startLine).toBe(4);
    expect(d?.fixes.map((f) => f.title)).toEqual(["Use ${{db.EXPOSED_URL}}", "Move worker to de-fsn-1"]);
    const edit = d?.fixes[0];
    expect(edit?.kind === "edit" && edit.edits[0]?.text).toBe("${{db.EXPOSED_URL}}");
  });

  test("other literal address shapes", () => {
    expect(codes("A=db:5432\nB=http://db\nC=db\nD=database\nE=dbx:5432\nF=redis://redis:6379\nG=api:3000\n")).toEqual([
      ["internal-address-other-node", 1],
      ["internal-address-other-node", 2],
      ["internal-address-other-node", 3],
      ["service-not-exposed", 6],
    ]);
  });

  test("internal reference to a service on another node", () => {
    const result = analyzeEnv("REDIS_URL=${{redis.INTERNAL_URL}}\nDB=${{db.INTERNAL_URL}}\n", context);
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["service-not-exposed", "redis is internal-only on de-fsn-1"],
      ["internal-reference-other-node", "db runs on another node"],
    ]);
    expect(result.diagnostics[0]?.fixes.map((f) => f.kind)).toEqual(["moveService", "exposeService"]);
    expect(result.diagnostics[1]?.fixes[0]?.title).toBe("Use ${{db.EXPOSED_URL}}");
  });

  test("unknown targets and variables, self references, duplicates, empty values", () => {
    expect(codes("A=${{nope.URL}}\nB=${{db.NOPE}}\nC=${{worker.X}}\nA=again\nE=${{redis.EXPOSED_URL}}\n")).toEqual([
      ["unknown-service", 1],
      ["unknown-variable", 2],
      ["self-reference", 3],
      ["duplicate-key", 4],
      ["empty-reference", 5],
    ]);
  });

  test("a service placed on the same nodes is fine, an unplaced one is not checked", () => {
    const local: AnalyzeContext = { ...context, self: { ...context.self, nodes: [fsn] } };
    expect(analyzeEnv("A=db:5432\nB=${{redis.INTERNAL_URL}}\n", local).diagnostics).toEqual([]);
    const unplaced: AnalyzeContext = { ...context, self: { ...context.self, nodes: [] } };
    expect(analyzeEnv("A=db:5432\n", unplaced).diagnostics).toEqual([]);
  });

  test("syntax problems are included", () => {
    expect(codes('A="open\nB=${{db.URL\n')).toEqual([
      ["unterminated-quote", 1],
      ["unterminated-reference", 2],
    ]);
  });
});

describe("resolve", () => {
  test("resolveEnv substitutes values and lists what it could not", () => {
    const parsed = parseEnv("A=${{api.URL}}/v1\nB='${{api.URL}}'\nC=${{db.NOPE}}\n");
    expect(resolveEnv(parsed, context)).toEqual({
      values: { A: "https://api.de1.example.com/v1", B: "${{api.URL}}", C: "${{db.NOPE}}" },
      unresolved: [{ key: "C", target: "db", variable: "NOPE" }],
    });
  });

  test("hovers and completions know reachability", () => {
    const parsed = parseEnv("R=${{redis.INTERNAL_URL}}\n");
    const ref = parsed.entries[0]?.references[0];
    if (!ref) throw new Error("no reference");
    const hover = describeReference(ref, context);
    expect(hover.variable?.value).toBe("redis://redis:6379");
    expect(hover.reachable).toBe(false);
    const completions = referenceCompletions(context);
    expect(completions.find((c) => c.label === "db.EXPOSED_URL")?.reachable).toBe(true);
    expect(completions.find((c) => c.label === "db.INTERNAL_URL")?.reachable).toBe(false);
    expect(completions.find((c) => c.label === "api.INTERNAL_URL")?.insertText).toBe("${{api.INTERNAL_URL}}");
    expect(completions.at(-1)?.reachable).toBe(false);
  });
});

describe("database engine variables", () => {
  test("every engine is a database; ClickHouse adds its HTTP interface", () => {
    for (const kind of ["postgres", "mysql", "mariadb", "mongo", "redis", "valkey", "keydb", "dragonfly"]) {
      expect(builtinVariablesFor(kind)).toBe(databaseVariables);
    }
    expect(builtinVariablesFor("clickhouse")).toBe(clickhouseVariables);
    expect(clickhouseVariables.find((v) => v.name === "INTERNAL_HTTP_URL")).toMatchObject({ scope: "internal" });
    expect(builtinVariablesFor("app")).toBe(appVariables);
  });

  test("ClickHouse's HTTP URL on another node is an internal reference like INTERNAL_URL", () => {
    const ch: AnalyzeContext = {
      self: { serviceId: "worker", name: "worker", nodes: [ash] },
      targets: [
        {
          name: "events",
          kind: "service",
          serviceId: "chid",
          serviceKind: "clickhouse",
          nodes: [fsn],
          internalHost: "events",
          exposed: true,
          variables: clickhouseVariables.map((v) => ({ ...v, value: `v-${v.name}` })),
        },
      ],
    };
    const result = analyzeEnv("CH=${{events.INTERNAL_HTTP_URL}}\nOK=${{events.EXPOSED_URL}}\n", ch);
    expect(result.diagnostics.map((d) => [d.code, d.range.startLine])).toEqual([["internal-reference-other-node", 1]]);
  });
});

// n8n's N8N_HOST=${{automations.DOMAIN}}: a service's own built-ins depend on none of its variables.
describe("a service's own built-in values", () => {
  const own: AnalyzeContext = {
    ...context,
    self: {
      ...context.self,
      builtins: [
        { name: "DOMAIN", value: "worker.example.com", scope: "public", sensitive: false, description: "primary domain" },
        { name: "URL", value: "https://worker.example.com", scope: "public", sensitive: false, description: "public URL" },
      ],
    },
  };

  test("referencing them is fine; its own variables still are not", () => {
    expect(analyzeEnv("HOST=${{worker.DOMAIN}}\nHOOK=${{worker.URL}}/webhook\n", own).diagnostics).toEqual([]);
    const bad = analyzeEnv("A=1\nB=${{worker.A}}\n", own).diagnostics;
    expect(bad.map((d) => d.code)).toEqual(["self-reference"]);
    expect(bad[0]?.detail).toContain("its own DOMAIN, URL");
    // Without built-ins known (an older panel, a new service) it stays an error, as before.
    expect(analyzeEnv("HOST=${{worker.DOMAIN}}\n", context).diagnostics.map((d) => d.code)).toEqual(["self-reference"]);
  });

  test("they resolve, show in hovers and completions, and never form a cycle", () => {
    const parsed = parseEnv("HOST=${{worker.DOMAIN}}\nDOMAIN=${{worker.DOMAIN}}\n");
    expect(resolveEnv(parsed, own).values).toEqual({ HOST: "worker.example.com", DOMAIN: "worker.example.com" });
    expect(analyzeEnv(parsed.text, own).diagnostics).toEqual([]);
    const hover = describeReference(parsed.entries[0]?.references[0] as never, own);
    expect(hover.variable?.value).toBe("worker.example.com");
    expect(hover.reachable).toBe(true);
    const labels = referenceCompletions(own).map((c) => c.label);
    expect(labels).toContain("worker.DOMAIN");
    expect(labels).toContain("worker.URL");
  });

  // The References panel offers every one of them, its internal address too.
  test("its internal address works from its own node, and a database's set resolves", () => {
    const app: AnalyzeContext = {
      ...context,
      self: {
        ...context.self,
        builtins: appVariables.map((v) => ({ ...v, value: v.name === "INTERNAL_URL" ? "http://worker:3001" : `v-${v.name}` })),
      },
    };
    const text = "SELF=${{worker.INTERNAL_URL}}\nLISTEN=${{worker.INTERNAL_HOST}}:${{worker.INTERNAL_PORT}}\n";
    expect(analyzeEnv(text, app).diagnostics).toEqual([]);
    expect(resolveEnv(parseEnv(text), app).values).toEqual({ SELF: "http://worker:3001", LISTEN: "v-INTERNAL_HOST:v-INTERNAL_PORT" });

    const db: AnalyzeContext = {
      self: { serviceId: "dbid", name: "db", nodes: [fsn], builtins: databaseVariables.map((v) => ({ ...v, value: `v-${v.name}` })) },
      targets: [],
    };
    const dbText = databaseVariables.map((v) => `${v.name}_COPY=\${{db.${v.name}}}`).join("\n");
    expect(analyzeEnv(dbText, db).diagnostics).toEqual([]);
    expect(Object.values(resolveEnv(parseEnv(dbText), db).values)).toEqual(databaseVariables.map((v) => `v-${v.name}`));
  });
});
