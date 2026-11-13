// DOMAINS in the env editor: ${{api.DOMAINS}} and ${{api.DOMAINS[1]}} are
// references like any other (one violet token, no squiggle), the index
// problems get the catalog's messages, the hover shows the item, and
// completions offer DOMAINS[0..n-1] with their values.

import { describe, expect, test } from "bun:test";
import { type AnalyzeContext, analyzeEnv, appVariables, describeReference, parseEnv, type ReferenceVariable } from "@seylo/env-analyzer";
import { envMonarch } from "./env-language";
import {
  completionTail,
  indexNames,
  markerSeverity,
  problemMessage,
  quickFixActions,
  referenceHover,
  referenceRanges,
  referenceSuggestions,
  toMarkers,
} from "./env-model";

const de = { id: "n000000000000001", name: "de-fsn-1" };

const builtins = (name: string, hosts: string[]): ReferenceVariable[] => {
  const values: Record<string, string> = {
    URL: hosts[0] ? `https://${hosts[0]}` : "",
    DOMAIN: hosts[0] ?? "",
    DOMAINS: hosts.join(","),
    INTERNAL_URL: `http://${name}:3000`,
    INTERNAL_HOST: name,
    INTERNAL_PORT: "3000",
  };
  return appVariables.map((v) => ({ ...v, value: values[v.name] ?? "" }));
};

// worker (no domain) edits its env; api has two domains, admin three.
const context: AnalyzeContext = {
  self: { serviceId: "s000000000000001", name: "worker", nodes: [de], builtins: builtins("worker", []) },
  targets: ["api", "admin"].map((name, i) => ({
    name,
    kind: "service" as const,
    serviceId: `s00000000000000${i + 2}`,
    serviceKind: "app",
    nodes: [de],
    internalHost: name,
    exposed: true,
    variables: builtins(
      name,
      name === "api" ? ["api.example.com", "api.example.org"] : ["admin.example.com", "a2.example.com", "a3.example.com"],
    ),
  })),
};

/** The text the env tokenizer gives a reference: the first root rule that matches at the start. */
function referenceToken(value: string): string | null {
  for (const rule of envMonarch.tokenizer.root ?? []) {
    if (!Array.isArray(rule) || !(rule[0] instanceof RegExp) || rule[1] !== "env.reference") continue;
    const match = new RegExp(`^(?:${rule[0].source})`).exec(value);
    if (match) return match[0];
  }
  return null;
}

describe("DOMAINS in the env editor", () => {
  test("an indexed reference is one reference token and one violet pill, with no problem", () => {
    expect(referenceToken("${{api.DOMAINS[1]}}/path")).toBe("${{api.DOMAINS[1]}}");
    expect(referenceToken("${{api.DOMAINS}},x")).toBe("${{api.DOMAINS}}");
    const text = "HOSTS=${{api.DOMAINS}}\nSECOND=https://${{api.DOMAINS[1]}}/x\n";
    const { parsed, diagnostics } = analyzeEnv(text, context);
    expect(diagnostics).toEqual([]);
    expect(referenceRanges(parsed)).toEqual([
      { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 23 },
      { startLineNumber: 2, startColumn: 16, endLineNumber: 2, endColumn: 35 },
    ]);
  });

  test("index problems get the catalog's messages: past the end a warning, no list or a broken index an error", () => {
    const text = [
      "A=${{api.DOMAINS[2]}}",
      "B=${{admin.DOMAINS[5]}}",
      "C=${{worker.DOMAINS[0]}}",
      "D=${{api.URL[1]}}",
      "E=${{api.DOMAINS[-1]}}",
      "",
    ].join("\n");
    const markers = toMarkers(analyzeEnv(text, context).diagnostics, "worker");
    expect(markers.map((m) => [m.code, m.startLineNumber, m.severity, m.message])).toEqual([
      [
        "index-out-of-range",
        1,
        markerSeverity.warning,
        "api has 2 domains: DOMAINS[0] and DOMAINS[1]\nDOMAINS[2] is empty until api has 3 domains. Indexes start at 0: DOMAINS[0] is the first.",
      ],
      [
        "index-out-of-range",
        2,
        markerSeverity.warning,
        "admin has 3 domains: DOMAINS[0] to DOMAINS[2]\nDOMAINS[5] is empty until admin has 6 domains. Indexes start at 0: DOMAINS[0] is the first.",
      ],
      [
        "index-out-of-range",
        3,
        markerSeverity.warning,
        "worker has no domains yet\nDOMAINS[0] is empty until worker has 1 domain. Indexes start at 0: DOMAINS[0] is the first.",
      ],
      [
        "not-a-list",
        4,
        markerSeverity.error,
        "URL is not a list, so it takes no [1]\nOnly list variables such as DOMAINS take an index. Write ${{api.URL}} for the whole value.",
      ],
      [
        "malformed-reference",
        5,
        markerSeverity.error,
        "The index in DOMAINS[-1] must be a whole number\nWrite it in [ ] right after the name, with no spaces or sign: DOMAINS[0] is the first item, DOMAINS[1] the second.",
      ],
    ]);
    // A reference that is broken elsewhere keeps the general message.
    const [plain] = analyzeEnv("A=${{nodot}}\n", context).diagnostics;
    expect(plain && problemMessage(plain)).toBe("A reference looks like ${{service.VARIABLE}}");
    expect(indexNames("DOMAINS", 1)).toBe("DOMAINS[0]");
  });

  test("DOMAIN[1] offers DOMAINS[1] as its preferred quick fix", () => {
    const text = "A=${{api.DOMAIN[1]}}\n";
    const { diagnostics } = analyzeEnv(text, context);
    const at = text.indexOf("DOMAIN");
    expect(quickFixActions(diagnostics, at, at, "worker").map((a) => [a.title, a.isPreferred])).toEqual([
      ["Use ${{api.DOMAINS[1]}}", true],
      ["Use ${{api.DOMAIN}}", false],
    ]);
  });

  test("the hover shows the item, where it sits in the list, and that it follows the domains", () => {
    const text = "A=${{api.DOMAINS[1]}}\nB=${{api.DOMAINS}}\nC=${{api.DOMAINS[4]}}\nD=${{api.URL[1]}}\n";
    const hovers = parseEnv(text).entries.map((e) => {
      const ref = e.references[0];
      return ref ? referenceHover(describeReference(ref, context), false) : [];
    });
    expect(hovers[0]).toEqual([
      "**api · DOMAINS[1]**",
      "Becomes\n\n```text\napi.example.org\n```",
      "Item 2 of 2 in DOMAINS. Indexes start at 0.",
      "_Updates on its own if api's domain changes._",
    ]);
    expect(hovers[1]?.slice(0, 2)).toEqual([
      "**api · all domain hosts, primary first, comma separated**",
      "Becomes\n\n```text\napi.example.com,api.example.org\n```",
    ]);
    expect(hovers[2]?.slice(1, 3)).toEqual(["Becomes\n\n```text\nEmpty for now\n```", "DOMAINS has 2 items right now."]);
    expect(hovers[3]).toEqual(["**api · URL[1]**", "URL is not a list, so it takes no [1]"]);
  });

  test("completions offer DOMAINS and, for a service with several domains, each one with its value", () => {
    const suggestions = referenceSuggestions(context);
    const domains = (target: string) =>
      suggestions.filter((s) => s.label.startsWith(`${target}.DOMAINS`)).map((s) => [s.label, s.detail, s.insertText, s.filterText]);
    expect(domains("api")).toEqual([
      ["api.DOMAINS", "all domain hosts, primary first, comma separated", "${{api.DOMAINS}}", "${{api.DOMAINS"],
      ["api.DOMAINS[0]", "api.example.com", "${{api.DOMAINS[0]}}", "${{api.DOMAINS[0]"],
      ["api.DOMAINS[1]", "api.example.org", "${{api.DOMAINS[1]}}", "${{api.DOMAINS[1]"],
    ]);
    expect(domains("admin").map(([label]) => label)).toEqual(["admin.DOMAINS", "admin.DOMAINS[0]", "admin.DOMAINS[1]", "admin.DOMAINS[2]"]);
    // worker has no domain: DOMAINS alone (empty for now), nothing to pick.
    expect(domains("worker").map(([label]) => label)).toEqual(["worker.DOMAINS"]);
    // The order Monaco keeps: by sortText, items right after their list.
    const labels = suggestions.map((s) => s.label);
    expect(labels.indexOf("api.DOMAINS[0]")).toBe(labels.indexOf("api.DOMAINS") + 1);
    expect([...suggestions].sort((a, b) => a.sortText.localeCompare(b.sortText)).map((s) => s.label)).toEqual(labels);
  });

  test("a completion replaces the rest of the name, an index and the closing }}", () => {
    expect(completionTail("DOMAINS[1]}} rest")).toBe("DOMAINS[1]}}".length);
    expect(completionTail("MAINS[1] }}")).toBe("MAINS[1] }}".length);
    expect(completionTail("DOMAINS[1")).toBe("DOMAINS[1".length);
    expect(completionTail(" other")).toBe(0);
  });
});
