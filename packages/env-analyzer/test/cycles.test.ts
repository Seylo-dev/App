import { describe, expect, test } from "bun:test";
import { type AnalyzeContext, analyzeEnv, type ReferenceTarget } from "../src";

const n1 = { id: "n1", name: "de-fsn-1" };
const n2 = { id: "n2", name: "us-ash-1" };

function app(name: string, variables: ReferenceTarget["variables"], nodes = [n1]): ReferenceTarget {
  return { name, kind: "service", serviceId: `${name}-id`, serviceKind: "app", nodes, internalHost: name, exposed: true, variables };
}

const plain = (name: string, value: string, dependsOn?: { target: string; variable: string }[]) => ({
  name,
  value,
  scope: "plain" as const,
  sensitive: false,
  description: "",
  ...(dependsOn ? { dependsOn } : {}),
});

describe("reference cycles", () => {
  test("a reference that comes straight back is a cycle with the reference's range", () => {
    const context: AnalyzeContext = {
      self: { serviceId: "web-id", name: "web", nodes: [n1] },
      targets: [app("api", [plain("TOKEN", "${{web.SECRET}}", [{ target: "web", variable: "SECRET" }])])],
    };
    const text = "SECRET=${{api.TOKEN}}\n";
    const { diagnostics } = analyzeEnv(text, context);
    expect(diagnostics).toHaveLength(1);
    const [d] = diagnostics;
    expect(d?.code).toBe("reference-cycle");
    expect(d?.params.chain).toBe("web.SECRET -> api.TOKEN -> web.SECRET");
    expect(d?.range).toMatchObject({ start: 7, end: 21, startLine: 1, startColumn: 8, endLine: 1, endColumn: 22 });
  });

  test("a loop through another key of this file is found", () => {
    const context: AnalyzeContext = {
      self: { serviceId: "web-id", name: "web", nodes: [n1] },
      targets: [app("api", [plain("B", "${{web.C}}", [{ target: "web", variable: "C" }])])],
    };
    // A -> api.B -> web.C -> api.B ... and web.C itself refers to api.B.
    const text = "A=${{api.B}}\nC=x-${{api.B}}\n";
    const { diagnostics } = analyzeEnv(text, context);
    expect(diagnostics.map((d) => [d.code, d.range.startLine])).toEqual([
      ["reference-cycle", 1],
      ["reference-cycle", 2],
    ]);
    expect(diagnostics[0]?.params.chain).toBe("web.A -> api.B -> web.C -> api.B");
    expect(diagnostics[1]?.params.chain).toBe("web.C -> api.B -> web.C");
  });

  test("a loop between two other services is reported where it is used", () => {
    const context: AnalyzeContext = {
      self: { serviceId: "web-id", name: "web", nodes: [n1] },
      targets: [
        app("a", [plain("X", "${{b.Y}}", [{ target: "b", variable: "Y" }])]),
        app("b", [plain("Y", "${{a.X}}", [{ target: "a", variable: "X" }])]),
      ],
    };
    const { diagnostics } = analyzeEnv("V=${{a.X}}", context);
    expect(diagnostics.map((d) => d.code)).toEqual(["reference-cycle"]);
    expect(diagnostics[0]?.params.chain).toBe("web.V -> a.X -> b.Y -> a.X");
  });

  test("long chains without a loop are fine", () => {
    const context: AnalyzeContext = {
      self: { serviceId: "web-id", name: "web", nodes: [n1] },
      targets: [
        app("a", [plain("X", "${{b.Y}}", [{ target: "b", variable: "Y" }])]),
        app("b", [plain("Y", "${{c.Z}}/v1", [{ target: "c", variable: "Z" }])]),
        app("c", [plain("Z", "https://c.example.com")]),
      ],
    };
    expect(analyzeEnv("V=${{a.X}}\nW=${{c.Z}}", context).diagnostics).toEqual([]);
  });
});

describe("typo suggestions", () => {
  const context: AnalyzeContext = {
    self: { serviceId: "web-id", name: "web", nodes: [n1] },
    targets: [
      app("postgres", [plain("DATABASE_URL", "postgres://x"), plain("PASSWORD", "pw")]),
      app("db", [plain("URL", "https://db")], [n2]),
    ],
  };

  test("an unknown variable close to a known one gets a quick fix with the variable's range", () => {
    const text = "DB=${{postgres.DATABSE_URL}}";
    const [d] = analyzeEnv(text, context).diagnostics;
    expect(d?.code).toBe("unknown-variable");
    expect(d?.range).toMatchObject({ start: 15, end: 26, startColumn: 16, endColumn: 27 });
    expect(d?.fixes).toEqual([{ kind: "edit", title: "Change to DATABASE_URL", edits: [{ range: d!.range, text: "DATABASE_URL" }] }]);
  });

  test("an unknown service close to a known one gets a quick fix; case slips too", () => {
    const [typo] = analyzeEnv("A=${{postgress.PASSWORD}}", context).diagnostics;
    expect(typo?.code).toBe("unknown-service");
    expect(typo?.fixes[0]).toMatchObject({ kind: "edit", title: "Change to postgres" });
    const [casing] = analyzeEnv("A=${{postgres.password}}", context).diagnostics;
    expect(casing?.fixes[0]).toMatchObject({ title: "Change to PASSWORD" });
  });

  test("short names are not guessed", () => {
    const [d] = analyzeEnv("A=${{dc.URL}}", context).diagnostics;
    expect(d?.code).toBe("unknown-service");
    expect(d?.fixes).toEqual([]);
  });
});
