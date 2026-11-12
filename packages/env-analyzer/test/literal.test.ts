import { describe, expect, test } from "bun:test";
import { type AnalyzeContext, analyzeEnv, appVariables, databaseVariables, parseEnv, type ReferenceVariable, resolveEnv } from "../src";

const fsn = { id: "n1", name: "de-fsn-1" };

const builtins = (values: Record<string, string>, list = appVariables): ReferenceVariable[] =>
  list.map((v) => ({ ...v, value: values[v.name] ?? "" }));

// web (the edited service), api with a domain and a variable of its own, a Postgres, and shared variables.
const context: AnalyzeContext = {
  self: {
    serviceId: "web",
    name: "web",
    nodes: [fsn],
    builtins: builtins({ URL: "https://shop.example.com", DOMAIN: "shop.example.com" }),
  },
  targets: [
    {
      name: "api",
      kind: "service",
      serviceId: "apiid",
      serviceKind: "app",
      nodes: [fsn],
      internalHost: "api",
      exposed: true,
      variables: [
        ...builtins({ URL: "https://api.example.com", DOMAIN: "api.example.com", INTERNAL_URL: "http://api:3000" }),
        { name: "LOG_LEVEL", value: "debug", scope: "plain", sensitive: false, description: "variable of this service" },
      ],
    },
    {
      name: "db",
      kind: "service",
      serviceId: "dbid",
      serviceKind: "postgres",
      nodes: [fsn],
      internalHost: "db",
      exposed: true,
      variables: builtins({ INTERNAL_HOST: "db", PASSWORD: "pw" }, databaseVariables),
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

const of = (code: string, text: string, ctx: AnalyzeContext = context) => analyzeEnv(text, ctx).diagnostics.filter((d) => d.code === code);

/** The text after applying the first fix of every diagnostic with that code. */
function fixed(code: string, text: string, ctx: AnalyzeContext = context): string {
  const edits = of(code, text, ctx).flatMap((d) => (d.fixes[0]?.kind === "edit" ? d.fixes[0].edits : []));
  const unique = [...new Map(edits.map((e) => [`${e.range.start}:${e.range.end}`, e])).values()];
  let out = text;
  for (const e of unique.sort((a, b) => b.range.start - a.range.start)) out = out.slice(0, e.range.start) + e.text + out.slice(e.range.end);
  return out;
}

const resolved = (text: string, key: string) => resolveEnv(parseEnv(text), context).values[key];

describe("single-quoted-reference", () => {
  test("a reference in single quotes is a warning on the reference, fixed by double quotes", () => {
    const text = "API='${{api.URL}}/v1'\n";
    const [d, ...rest] = of("single-quoted-reference", text);
    expect(rest).toEqual([]);
    expect(d?.severity).toBe("warning");
    expect(d && text.slice(d.range.start, d.range.end)).toBe("${{api.URL}}");
    expect(d?.message).toBe("Single quotes keep ${{api.URL}} as text: the app gets it literally");
    expect(d?.params).toEqual({ key: "API", reference: "${{api.URL}}", target: "api", variable: "URL" });
    expect(d?.fixes.map((f) => f.title)).toEqual(["Use double quotes"]);
    // As written, the app gets the text; fixed, the reference.
    expect(resolved(text, "API")).toBe("${{api.URL}}/v1");
    expect(fixed("single-quoted-reference", text)).toBe('API="${{api.URL}}/v1"\n');
    expect(resolved(fixed("single-quoted-reference", text), "API")).toBe("https://api.example.com/v1");
    expect(of("single-quoted-reference", fixed("single-quoted-reference", text))).toEqual([]);
  });

  test("the fix escapes what double quotes read differently, so the value stays the same text", () => {
    const literal = 'a\\b "q" $HOME\ttab ${{ api.DOMAIN }} $${{db.PASSWORD}}\nsecond line';
    const text = `export X='${literal}' # note\nNEXT=1\n`;
    const after = fixed("single-quoted-reference", text);
    expect(after).toBe('export X="a\\\\b \\"q\\" \\$HOME\\ttab ${{ api.DOMAIN }} \\$${{db.PASSWORD}}\\nsecond line" # note\nNEXT=1\n');
    expect(resolved(after, "X")).toBe(literal.replace("${{ api.DOMAIN }}", "api.example.com").replace("${{db.PASSWORD}}", "pw"));
    expect(analyzeEnv(after, context).diagnostics).toEqual([]);
    // The edits are the quotes and the escapes: none carries the value.
    const edits = of("single-quoted-reference", text)[0]?.fixes.flatMap((f) => (f.kind === "edit" ? f.edits.map((e) => e.text) : []));
    expect(edits).toEqual(['"', "\\\\", '\\"', '\\"', "\\$", "\\t", "\\$", "\\n", '"']);
  });

  test("every reference gets its warning; only this hint runs on the literal text", () => {
    const text = "X='${{nope.URL}} and ${{api.INTERNAL_URL}}'\n";
    const all = analyzeEnv(text, context).diagnostics;
    expect(all.map((d) => [d.code, text.slice(d.range.start, d.range.end)])).toEqual([
      ["single-quoted-reference", "${{nope.URL}}"],
      ["single-quoted-reference", "${{api.INTERNAL_URL}}"],
    ]);
    expect(all[0]?.fixes).toEqual(all[1]?.fixes ?? []);
  });

  test("no fix when double quotes cannot hold the same text", () => {
    // A broken ${{ next to the reference would become an error in double quotes.
    const [broken] = of("single-quoted-reference", "X='${{api.URL}} ${{oops'\n");
    expect(broken?.fixes).toEqual([]);
    // Double quotes turn a CRLF line break into LF.
    const [crlf] = of("single-quoted-reference", "X='${{api.URL}}\r\nb'\r\n");
    expect(crlf?.fixes).toEqual([]);
  });

  test("nothing for single quotes without a reference, a double-quoted reference or a broken quote", () => {
    expect(of("single-quoted-reference", "A='raw $x {{x}}'\nB='${{bad}}'\nC=\"${{api.URL}}\"\nD=${{api.URL}}\n")).toEqual([]);
    expect(of("single-quoted-reference", "A='${{api.URL}}\n")).toEqual([]);
  });

  test("names the reference, never the rest of the value", () => {
    const text = "SECRET_TOKEN='s3cr3t-value ${{api.URL}}'\n";
    expect(of("single-quoted-reference", text)).toHaveLength(1);
    expect(JSON.stringify(analyzeEnv(text, context).diagnostics)).not.toContain("s3cr3t");
  });
});

describe("bare-reference", () => {
  /** [token, reference, fix texts] per warning. */
  const found = (text: string, ctx: AnalyzeContext = context) =>
    of("bare-reference", text, ctx).map((d) => [
      text.slice(d.range.start, d.range.end),
      d.params.reference,
      d.fixes.map((f) => (f.kind === "edit" ? f.edits.map((e) => e.text).join("") : f.kind)),
    ]);

  test("an unknown name with a built-in variable: the owner's blabla.DOMAIN, a warning without a fix", () => {
    const [d, ...rest] = of("bare-reference", "X=blabla.DOMAIN\n");
    expect(rest).toEqual([]);
    expect(d?.severity).toBe("warning");
    expect(d?.message).toBe("Looks like a reference written without ${{ }}: the app gets the text blabla.DOMAIN");
    expect(d?.detail).toBe("There is no service named blabla in this project.");
    expect(d?.params).toMatchObject({
      key: "X",
      token: "blabla.DOMAIN",
      target: "blabla",
      variable: "DOMAIN",
      reason: "unknownService",
      reference: "",
    });
    expect(d?.fixes).toEqual([]);
  });

  test("a target and one of its variables: the fix wraps it, and the value resolves", () => {
    const text = "API_HOST=api.DOMAIN\n";
    expect(found(text)).toEqual([["api.DOMAIN", "${{api.DOMAIN}}", ["${{api.DOMAIN}}"]]]);
    const [d] = of("bare-reference", text);
    expect(d?.detail).toBe("Wrap it in ${{ }} to use api's DOMAIN: ${{api.DOMAIN}}.");
    expect(d?.fixes[0]?.title).toBe("Use ${{api.DOMAIN}}");
    expect(resolved(text, "API_HOST")).toBe("api.DOMAIN");
    const after = fixed("bare-reference", text);
    expect(after).toBe("API_HOST=${{api.DOMAIN}}\n");
    expect(resolved(after, "API_HOST")).toBe("api.example.com");
    expect(analyzeEnv(after, context).diagnostics).toEqual([]);
  });

  test("own variables of a target, shared variables, the service's own built-ins, and a name in other case", () => {
    expect(found("A=api.LOG_LEVEL\nB=project.SMTP_HOST\nC=web.URL\nD=API.URL\n")).toEqual([
      ["api.LOG_LEVEL", "${{api.LOG_LEVEL}}", ["${{api.LOG_LEVEL}}"]],
      ["project.SMTP_HOST", "${{project.SMTP_HOST}}", ["${{project.SMTP_HOST}}"]],
      ["web.URL", "${{web.URL}}", ["${{web.URL}}"]],
      ["API.URL", "${{api.URL}}", ["${{api.URL}}"]],
    ]);
  });

  test("a token inside a longer value, delimited by blanks, quotes, commas, slashes and the like", () => {
    const text = [
      'A="a,api.URL/b"',
      "B=--url api.URL",
      'C="first\\napi.DOMAIN"',
      "D=(api.URL)",
      "E=db.INTERNAL_HOST:5432",
      "F=/srv/api.URL;x",
      "",
    ].join("\n");
    expect(found(text).map(([token]) => token)).toEqual(["api.URL", "api.URL", "api.DOMAIN", "api.URL", "db.INTERNAL_HOST", "api.URL"]);
    expect(fixed("bare-reference", text).split("\n").slice(0, 2)).toEqual(['A="a,${{api.URL}}/b"', "B=--url ${{api.URL}}"]);
  });

  test("an unknown name a typo away from a target that has the variable: Did you mean, one fix per name", () => {
    const [d] = of("bare-reference", "X=apu.DOMAIN\n");
    expect(d?.message).toBe("Looks like a reference written without ${{ }}: the app gets the text apu.DOMAIN. Did you mean api?");
    expect(d?.params.suggestions).toBe("api");
    expect(found("X=apu.DOMAIN\n")).toEqual([["apu.DOMAIN", "", ["${{api.DOMAIN}}"]]]);
    // Only targets that have the variable: db has a PASSWORD, but no DOMAIN.
    expect(found("X=dbb.PASSWORD\n")).toEqual([["dbb.PASSWORD", "", ["${{db.PASSWORD}}"]]]);
    expect(found("X=dbb.DOMAIN\n")).toEqual([["dbb.DOMAIN", "", []]]);
    const two: AnalyzeContext = {
      ...context,
      targets: [...context.targets, { ...(context.targets[0] as AnalyzeContext["targets"][number]), name: "apx", serviceId: "apxid" }],
    };
    expect(found("X=apu.URL\n", two)).toEqual([["apu.URL", "", ["${{api.URL}}", "${{apx.URL}}"]]]);
    expect(of("bare-reference", "X=apu.URL\n", two)[0]?.message).toContain("Did you mean api, apx?");
  });

  test("a target without that built-in: a warning without a fix", () => {
    const [d] = of("bare-reference", "X=api.PASSWORD\n");
    expect(d?.params).toMatchObject({ reason: "noVariable", reference: "", wrapped: "${{api.PASSWORD}}" });
    expect(d?.detail).toBe("api has no PASSWORD, so ${{api.PASSWORD}} would not work either.");
    expect(d?.fixes).toEqual([]);
    const noShared: AnalyzeContext = { ...context, targets: context.targets.filter((t) => t.kind !== "shared") };
    expect(of("bare-reference", "X=project.URL\n", noShared)[0]?.detail).toBe(
      "This project has no shared variables, so ${{project.URL}} would not work either.",
    );
  });

  test("not a reference: lower case, numbers, longer names, hosts, references, comments, single quotes", () => {
    const text = [
      "A=example.com",
      "B=file.txt",
      "C=api.domain",
      "D=1.2",
      "E=api.DOMAIN.com",
      "F=https://api.DOMAIN",
      "G=//api.URL/x",
      "H=admin@api.DOMAIN",
      "I=${{api.URL}}",
      'J="${{ api.URL }}x"',
      "# K=api.URL",
      "L=1 # api.URL",
      "M='api.URL'",
      "N=blabla.FOO",
      "O=Blabla.URL",
      "P=api.URL=1",
      "Q=www.api.URL",
      "R=api.URL-old",
      "S=x.api.URL",
      "T=_.URL",
      "U=v1.2.URL",
      "",
    ].join("\n");
    expect(found(text)).toEqual([]);
  });

  test("long values take linear time", () => {
    // 256 KiB in one value, as env.set takes: without a dot, and full of dots and tokens.
    const started = performance.now();
    expect(of("bare-reference", `PAD=${"p".repeat(262_000)}\n`)).toEqual([]);
    expect(of("bare-reference", `PAD="${"p.".repeat(131_000)}"\n`)).toEqual([]);
    expect(of("bare-reference", `PAD=${"api.URL,".repeat(32_000)}\n`)).toHaveLength(32_000);
    expect(of("single-quoted-reference", `PAD='${"${{api.URL}}$".repeat(20_000)}'\n`)[0]?.fixes).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("names the token, never the rest of the value, and never blocks a save", () => {
    const text = "SECRET_TOKEN=s3cr3t-value api.URL\n";
    const all = analyzeEnv(text, context).diagnostics;
    expect(all.map((d) => [d.code, d.severity])).toEqual([["bare-reference", "warning"]]);
    expect(JSON.stringify(all)).not.toContain("s3cr3t");
  });
});
