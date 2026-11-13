// DOMAINS, the list variable: every domain host of a service, primary
// first, comma separated, and ${{api.DOMAINS[n]}} for one of them
// (0-based). Parsing, resolution, the index errors and warnings, hovers,
// completions and the hints that write a reference.

import { describe, expect, test } from "bun:test";
import {
  type AnalyzeContext,
  analyzeEnv,
  appVariables,
  databaseVariables,
  describeReference,
  listItemName,
  listItems,
  listNames,
  parseEnv,
  type ReferenceVariable,
  referenceCompletions,
  referenceValue,
  resolveEnv,
  substituteReferences,
} from "../src";

const fsn = { id: "n1", name: "de-fsn-1" };

/** An app's built-ins as env.references fills them, DOMAINS from its hosts (the first one primary). */
function appBuiltins(name: string, hosts: string[]): ReferenceVariable[] {
  const values: Record<string, string> = {
    URL: hosts[0] ? `https://${hosts[0]}` : "",
    DOMAIN: hosts[0] ?? "",
    DOMAINS: hosts.join(","),
    INTERNAL_URL: `http://${name}:3000`,
    INTERNAL_HOST: name,
    INTERNAL_PORT: "3000",
  };
  return appVariables.map((v) => ({ ...v, value: values[v.name] ?? "" }));
}

const app = (name: string, hosts: string[]) => ({
  name,
  kind: "service" as const,
  serviceId: `${name}id`,
  serviceKind: "app",
  nodes: [fsn],
  internalHost: name,
  exposed: hosts.length > 0,
  variables: appBuiltins(name, hosts),
});

// web is edited and has two domains; api has two, admin three, solo one, worker none.
const context: AnalyzeContext = {
  self: { serviceId: "webid", name: "web", nodes: [fsn], builtins: appBuiltins("web", ["shop.example.com", "www.shop.example.com"]) },
  targets: [
    app("api", ["api.example.com", "api.example.org"]),
    app("admin", ["admin.example.com", "*.admin.example.com", "ops.example.com"]),
    app("solo", ["solo.example.com"]),
    app("worker", []),
    {
      name: "db",
      kind: "service",
      serviceId: "dbid",
      serviceKind: "postgres",
      nodes: [fsn],
      internalHost: "db",
      exposed: false,
      variables: databaseVariables.map((v) => ({ ...v, value: v.name === "INTERNAL_HOST" ? "db" : "x" })),
    },
    {
      name: "project",
      kind: "shared",
      serviceId: null,
      serviceKind: null,
      nodes: [],
      internalHost: null,
      exposed: false,
      variables: [
        { name: "HOSTS", value: "a.example.com,b.example.com", scope: "plain", sensitive: false, description: "shared variable" },
      ],
    },
  ],
};

const slice = (text: string, range: { start: number; end: number }) => text.slice(range.start, range.end);
const diagnostics = (text: string, ctx: AnalyzeContext = context) => analyzeEnv(text, ctx).diagnostics;
const codes = (text: string) => diagnostics(text).map((d) => [d.code, d.severity, d.range.startLine]);

describe("the DOMAINS built-in", () => {
  test("apps have it right after DOMAIN, flagged as the one list", () => {
    expect(appVariables.map((v) => v.name)).toEqual(["URL", "DOMAIN", "DOMAINS", "INTERNAL_URL", "INTERNAL_HOST", "INTERNAL_PORT"]);
    expect(appVariables.find((v) => v.name === "DOMAINS")).toMatchObject({
      scope: "public",
      sensitive: false,
      list: true,
      description: "all domain hosts, primary first, comma separated",
    });
    expect([...listNames]).toEqual(["DOMAINS"]);
    expect(databaseVariables.some((v) => v.list)).toBe(false);
    expect(listItemName("DOMAINS")).toBe("domain");
  });

  test("items and values: empty is no item, past the end is empty, an index on a plain variable resolves to nothing", () => {
    expect(listItems("")).toEqual([]);
    expect(listItems("a.com,b.com")).toEqual(["a.com", "b.com"]);
    const list = { value: "a.com,b.com", list: true };
    expect(referenceValue(list, null)).toBe("a.com,b.com");
    expect(referenceValue(list, 1)).toBe("b.com");
    expect(referenceValue(list, 2)).toBe("");
    expect(referenceValue({ value: "https://a.com" }, 0)).toBeNull();
    expect(referenceValue({ value: null, list: true }, 0)).toBeNull();
  });
});

describe("parsing an index", () => {
  test("VARIABLE[n] is one reference with its index, inside a longer value too", () => {
    const text = 'A=${{api.DOMAINS[1]}}\nB="https://${{ api.DOMAINS[0] }}/path"\nC=${{api.DOMAINS}}\n';
    const parsed = parseEnv(text);
    expect(parsed.problems).toEqual([]);
    const [a, b, c] = parsed.entries.map((e) => e.references[0]);
    expect(a && [a.raw, a.target, a.variable, a.index]).toEqual(["${{api.DOMAINS[1]}}", "api", "DOMAINS", 1]);
    expect(a && slice(text, a.variableRange)).toBe("DOMAINS");
    expect(a?.indexRange && slice(text, a.indexRange)).toBe("[1]");
    expect(b && [b.variable, b.index, slice(text, b.range)]).toEqual(["DOMAINS", 0, "${{ api.DOMAINS[0] }}"]);
    // Without [n] there is no index at all.
    expect(c && "index" in c).toBe(false);
    expect(c?.indexRange).toBeUndefined();
  });

  test("a malformed index is a syntax error on its brackets", () => {
    const text = [
      "A=${{api.DOMAINS[]}}",
      "B=${{api.DOMAINS[-1]}}",
      "C=${{api.DOMAINS[ 1 ]}}",
      "D=${{api.DOMAINS[x]}}",
      "E=${{api.DOMAINS[1.5]}}",
      "F=${{api.DOMAINS [1]}}",
      "G=${{api.DOMAINS[1}}",
      "",
    ].join("\n");
    const parsed = parseEnv(text);
    expect(parsed.entries.every((e) => e.references.length === 0)).toBe(true);
    expect(parsed.problems.map((p) => [p.code, p.severity, p.range.startLine, slice(text, p.range), p.params.index])).toEqual([
      ["malformed-reference", "error", 1, "[]", ""],
      ["malformed-reference", "error", 2, "[-1]", "-1"],
      ["malformed-reference", "error", 3, "[ 1 ]", " 1 "],
      ["malformed-reference", "error", 4, "[x]", "x"],
      ["malformed-reference", "error", 5, "[1.5]", "1.5"],
      ["malformed-reference", "error", 6, " [1]", "1"],
      ["malformed-reference", "error", 7, "[1", "1"],
    ]);
    expect(parsed.problems[0]).toMatchObject({
      message: "The index in DOMAINS[] must be a whole number",
      detail: "Write it in [ ] right after the name, with no spaces or sign: DOMAINS[0] is the first item, DOMAINS[1] the second.",
      params: { variable: "DOMAINS", index: "" },
    });
    // A broken reference around the brackets is still the plain malformed reference.
    expect(parseEnv("A=${{api.DOMAINS[1].x}}\n").problems.map((p) => [p.message, p.params])).toEqual([
      ["A reference looks like ${{service.VARIABLE}}", {}],
    ]);
  });

  test("substituteReferences hands the index to the lookup", () => {
    const seen: [string, string, number | null][] = [];
    const out = substituteReferences("https://${{api.DOMAINS[1]}}/x ${{api.URL}}", (target, variable, index) => {
      seen.push([target, variable, index]);
      return variable === "DOMAINS" ? `item${index}` : "u";
    });
    expect(out.value).toBe("https://item1/x u");
    expect(seen).toEqual([
      ["api", "DOMAINS", 1],
      ["api", "URL", null],
    ]);
  });
});

describe("resolving", () => {
  test("the whole list, one item, past the end, and an index on a variable that is no list", () => {
    const text = [
      "ALL=${{api.DOMAINS}}",
      "FIRST=${{api.DOMAINS[0]}}",
      "SECOND=https://${{api.DOMAINS[1]}}/path",
      "THIRD=${{api.DOMAINS[2]}}",
      "WILD=${{admin.DOMAINS[1]}}",
      "NONE=${{worker.DOMAINS}}",
      "OWN=${{web.DOMAINS[1]}}",
      "URL=${{api.URL[1]}}",
      "",
    ].join("\n");
    expect(resolveEnv(parseEnv(text), context)).toEqual({
      values: {
        ALL: "api.example.com,api.example.org",
        FIRST: "api.example.com",
        SECOND: "https://api.example.org/path",
        THIRD: "",
        WILD: "*.admin.example.com",
        NONE: "",
        OWN: "www.shop.example.com",
        // Not a list: the reference stays as written, like one to an unknown variable.
        URL: "${{api.URL[1]}}",
      },
      unresolved: [{ key: "URL", target: "api", variable: "URL" }],
    });
  });

  test("hovers show what the item becomes", () => {
    const text = "A=${{api.DOMAINS[1]}}\nB=${{api.DOMAINS}}\nC=${{api.DOMAINS[5]}}\nD=${{api.URL[0]}}\n";
    const refs = parseEnv(text).entries.map((e) => e.references[0]);
    const values = refs.map((ref) => (ref ? describeReference(ref, context).value : undefined));
    expect(values).toEqual(["api.example.org", "api.example.com,api.example.org", "", null]);
    const first = refs[0] && describeReference(refs[0], context);
    expect(first?.variable?.name).toBe("DOMAINS");
    expect(first?.target?.name).toBe("api");
  });

  test("completions list DOMAINS and each of its items when there are two or more, with their values", () => {
    const completions = referenceCompletions(context);
    const of = (prefix: string) =>
      completions.filter((c) => c.label.startsWith(`${prefix}.DOMAINS`)).map((c) => [c.label, c.insertText, c.value, c.index]);
    expect(of("api")).toEqual([
      ["api.DOMAINS", "${{api.DOMAINS}}", "api.example.com,api.example.org", undefined],
      ["api.DOMAINS[0]", "${{api.DOMAINS[0]}}", "api.example.com", 0],
      ["api.DOMAINS[1]", "${{api.DOMAINS[1]}}", "api.example.org", 1],
    ]);
    expect(of("admin").map(([label]) => label)).toEqual(["admin.DOMAINS", "admin.DOMAINS[0]", "admin.DOMAINS[1]", "admin.DOMAINS[2]"]);
    // The service itself too.
    expect(of("web").map(([label]) => label)).toEqual(["web.DOMAINS", "web.DOMAINS[0]", "web.DOMAINS[1]"]);
    // One domain: DOMAINS[0] would only repeat DOMAIN. None: nothing to pick.
    expect(of("solo").map(([label]) => label)).toEqual(["solo.DOMAINS"]);
    expect(of("worker").map(([label]) => label)).toEqual(["worker.DOMAINS"]);
  });
});

describe("index diagnostics", () => {
  test("a valid index has none, as a whole value or inside a longer one", () => {
    expect(diagnostics('A=${{api.DOMAINS}}\nB=${{api.DOMAINS[1]}}\nC="https://${{admin.DOMAINS[2]}}/x"\nD=${{web.DOMAINS[1]}}\n')).toEqual(
      [],
    );
  });

  test("an index on a variable that is no list is an error, with the reference without it as the fix", () => {
    const text = "A=${{api.URL[1]}}\n";
    const [d] = diagnostics(text);
    expect(d).toMatchObject({
      code: "not-a-list",
      severity: "error",
      message: "URL is not a list, so it takes no [1]",
      detail: "Only list variables such as DOMAINS take an index. api has DOMAINS. Write ${{api.URL}} for the whole value.",
      params: { target: "api", variable: "URL", key: "A", index: "1", lists: "DOMAINS" },
    });
    expect(d && slice(text, d.range)).toBe("URL[1]");
    // The fix replaces the whole reference.
    expect(d?.fixes.map((f) => (f.kind === "edit" ? [f.title, f.edits.map((e) => [slice(text, e.range), e.text])] : []))).toEqual([
      ["Use ${{api.URL}}", [["${{api.URL[1]}}", "${{api.URL}}"]]],
    ]);
  });

  test("DOMAIN[1] suggests DOMAINS[1] first", () => {
    const [d] = diagnostics("A=${{api.DOMAIN[1]}}\n");
    expect(d?.code).toBe("not-a-list");
    expect(d?.fixes.map((f) => f.title)).toEqual(["Use ${{api.DOMAINS[1]}}", "Use ${{api.DOMAIN}}"]);
  });

  test("an index on a database's variable, a shared variable or the service's own non-list built-in is an error too", () => {
    expect(codes("A=${{db.INTERNAL_HOST[0]}}\nB=${{project.HOSTS[1]}}\nC=${{web.URL[0]}}\n")).toEqual([
      ["not-a-list", "error", 1],
      ["not-a-list", "error", 2],
      ["not-a-list", "error", 3],
    ]);
    const [db] = diagnostics("A=${{db.INTERNAL_HOST[0]}}\n");
    expect(db?.detail).toBe("Only list variables such as DOMAINS take an index. Write ${{db.INTERNAL_HOST}} for the whole value.");
  });

  test("an index past the end is a warning naming how many domains the service has now", () => {
    const text =
      "A=${{api.DOMAINS[2]}}\nB=${{solo.DOMAINS[1]}}\nC=${{admin.DOMAINS[3]}}\nD=${{worker.DOMAINS[0]}}\nE=${{web.DOMAINS[4]}}\n";
    const found = diagnostics(text);
    expect(found.map((d) => [d.code, d.severity, d.message, slice(text, d.range)])).toEqual([
      ["index-out-of-range", "warning", "api has 2 domains: DOMAINS[0] and DOMAINS[1]", "DOMAINS[2]"],
      ["index-out-of-range", "warning", "solo has 1 domain: DOMAINS[0]", "DOMAINS[1]"],
      ["index-out-of-range", "warning", "admin has 3 domains: DOMAINS[0] to DOMAINS[2]", "DOMAINS[3]"],
      ["index-out-of-range", "warning", "worker has no domains yet", "DOMAINS[0]"],
      ["index-out-of-range", "warning", "web has 2 domains: DOMAINS[0] and DOMAINS[1]", "DOMAINS[4]"],
    ]);
    expect(found[0]).toMatchObject({
      detail: "DOMAINS[2] is empty until api has 3 domains. Indexes start at 0: DOMAINS[0] is the first.",
      params: {
        target: "api",
        variable: "DOMAINS",
        key: "A",
        index: "2",
        count: "2",
        item: "domain",
        indexes: "DOMAINS[0] and DOMAINS[1]",
      },
    });
    expect(found[3]?.detail).toBe("DOMAINS[0] is empty until worker has 1 domain. Indexes start at 0: DOMAINS[0] is the first.");
  });

  test("DOMAINS of a service without a domain is an empty reference, like DOMAIN", () => {
    expect(codes("A=${{worker.DOMAINS}}\n")).toEqual([["empty-reference", "warning", 1]]);
  });

  test("an unknown variable with an index keeps the index in its Did you mean fix", () => {
    const text = "A=${{api.DOMAINZ[1]}}\n";
    const [d] = diagnostics(text);
    expect(d?.code).toBe("unknown-variable");
    const fix = d?.fixes[0];
    const edited =
      fix?.kind === "edit" && fix.edits[0]
        ? text.slice(0, fix.edits[0].range.start) + fix.edits[0].text + text.slice(fix.edits[0].range.end)
        : "";
    expect(edited).toBe("A=${{api.DOMAINS[1]}}\n");
  });
});

describe("hints that write a reference", () => {
  test("an indexed reference in single quotes gets the double quotes warning", () => {
    const [d] = diagnostics("A='https://${{api.DOMAINS[1]}}/x'\n").filter((x) => x.code === "single-quoted-reference");
    expect(d).toMatchObject({ severity: "warning", params: { reference: "${{api.DOMAINS[1]}}", target: "api", variable: "DOMAINS" } });
    expect(d?.fixes.map((f) => f.title)).toEqual(["Use double quotes"]);
  });

  test("api.DOMAINS[1] without ${{ }} is one token, wrapped whole", () => {
    const text = "A=api.DOMAINS[1]\nB=https://api.DOMAINS[0]/x\nC=api.DOMAINS\nD=apu.DOMAINS[1]\nE=api.URL[1]\nF=blabla.URL[1]\n";
    const bare = diagnostics(text).filter((d) => d.code === "bare-reference");
    expect(bare.map((d) => [d.range.startLine, d.params.token, d.params.reason, d.fixes.map((f) => f.title)])).toEqual([
      [1, "api.DOMAINS[1]", "reference", ["Use ${{api.DOMAINS[1]}}"]],
      [3, "api.DOMAINS", "reference", ["Use ${{api.DOMAINS}}"]],
      [4, "apu.DOMAINS[1]", "unknownService", ["Use ${{api.DOMAINS[1]}}"]],
    ]);
    expect(bare[0]?.params).toMatchObject({ reference: "${{api.DOMAINS[1]}}", wrapped: "${{api.DOMAINS[1]}}" });
  });

  test("a value that writes out a service's domains suggests ${{svc.DOMAINS}}, its second domain ${{svc.DOMAINS[1]}}", () => {
    const text = [
      "ALLOWED_HOSTS=api.example.com,api.example.org",
      "API_HOST=api.example.com",
      "MIRROR_HOST=api.example.org",
      "ADMIN_HOSTS=admin.example.com,*.admin.example.com,ops.example.com",
      "OPS_HOST=OPS.example.com",
      "OWN_HOSTS=shop.example.com,www.shop.example.com",
      "WWW_DOMAIN=www.shop.example.com",
      "SOLO_HOSTS=solo.example.com",
      // Not the same value: another order, a blank after the comma, part of the list.
      "SWAPPED_HOSTS=api.example.org,api.example.com",
      "SPACED_HOSTS=api.example.com, api.example.org",
      "MORE_HOSTS=api.example.com,api.example.org,localhost",
      // A mail domain and a key that names no host are left alone.
      "MAIL_DOMAINS=api.example.com,api.example.org",
      "MIRROR=api.example.org",
      "",
    ].join("\n");
    const hints = diagnostics(text).filter((d) => d.code === "hardcoded-reference");
    expect(hints.map((d) => [d.range.startLine, d.params.reference, d.params.matched])).toEqual([
      [1, "${{api.DOMAINS}}", "DOMAINS"],
      [2, "${{api.DOMAIN}}", "DOMAIN"],
      [3, "${{api.DOMAINS[1]}}", "DOMAINS[1]"],
      [4, "${{admin.DOMAINS}}", "DOMAINS"],
      [5, "${{admin.DOMAINS[2]}}", "DOMAINS[2]"],
      [6, "${{web.DOMAINS}}", "DOMAINS"],
      [7, "${{web.DOMAINS[1]}}", "DOMAINS[1]"],
      [8, "${{solo.DOMAIN}}", "DOMAIN"],
    ]);
    expect(hints[2]).toMatchObject({
      severity: "info",
      message: "MIRROR_HOST can use ${{api.DOMAINS[1]}}",
      detail: "This is api's DOMAINS[1] written out. ${{api.DOMAINS[1]}} gives the same value and stays right when api's address changes.",
      fixes: [{ kind: "edit", title: "Use ${{api.DOMAINS[1]}}" }],
    });
    // The fix keeps the value: the reference resolves to what was written.
    const edit = hints[0]?.fixes[0];
    const line = edit?.kind === "edit" && edit.edits[0] ? text.slice(0, edit.edits[0].range.start) + edit.edits[0].text : "";
    expect(line).toBe("ALLOWED_HOSTS=${{api.DOMAINS}}");
    expect(resolveEnv(parseEnv("ALLOWED_HOSTS=${{api.DOMAINS}}\nMIRROR_HOST=${{api.DOMAINS[1]}}\n"), context).values).toEqual({
      ALLOWED_HOSTS: "api.example.com,api.example.org",
      MIRROR_HOST: "api.example.org",
    });
  });
});
