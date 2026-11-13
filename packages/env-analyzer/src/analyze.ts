// Diagnostics that need to know about other services: unknown references,
// duplicate keys, and the one this package exists for - an internal address
// of a service that runs on another node. There is no cross-node private
// network, so db:5432 or ${{db.INTERNAL_URL}} only works for services that
// have an instance on every node this service runs on. hardcoded.ts adds a
// hint for another service's address written out instead of referenced,
// literal.ts warnings for references the app gets as text ('${{api.URL}}'
// in single quotes, api.URL without ${{ }}).

import { listItemName, listItems } from "./builtins";
import { checkHardcoded } from "./hardcoded";
import { hostMentions } from "./hosts";
import { checkBareReferences, checkSingleQuoted } from "./literal";
import { missingNodes } from "./nodes";
import { parseEnv } from "./parse";
import { formatReference, sharedTarget } from "./references";
import { selfTarget } from "./resolve";
import { LineIndex } from "./source";
import { closestNames, suggest } from "./suggest";
import type {
  AnalyzeContext,
  AnalyzeResult,
  Diagnostic,
  EnvEntry,
  EnvReference,
  NodeRef,
  ParsedEnv,
  QuickFix,
  ReferenceTarget,
  ReferenceVariable,
  SourceRange,
} from "./types";

export function analyzeEnv(text: string, context: AnalyzeContext): AnalyzeResult {
  const parsed = parseEnv(text);
  return { parsed, diagnostics: analyzeParsed(parsed, context) };
}

/** Syntax problems plus context problems for an already parsed file, sorted by position. */
export function analyzeParsed(parsed: ParsedEnv, context: AnalyzeContext): Diagnostic[] {
  const index = new LineIndex(parsed.text);
  const diagnostics: Diagnostic[] = [...parsed.problems];
  const targets = new Map(context.targets.map((t) => [t.name.toLowerCase(), t]));

  // References written in this file, per key, so cycles through this service's own keys are found.
  const selfDeps = new Map<string, EnvReference[]>();
  for (const entry of parsed.entries) selfDeps.set(entry.key, entry.references);

  const seen = new Map<string, EnvEntry>();
  for (const entry of parsed.entries) {
    const earlier = seen.get(entry.key);
    if (earlier) {
      diagnostics.push({
        code: "duplicate-key",
        severity: "warning",
        message: `${entry.key} is set twice`,
        detail: `It is also set on line ${earlier.keyRange.startLine}; the last value wins.`,
        params: { key: entry.key, line: String(earlier.keyRange.startLine) },
        range: entry.keyRange,
        fixes: [],
      });
    }
    seen.set(entry.key, entry);

    for (const reference of entry.references) diagnostics.push(...checkReference(entry, reference, context, targets, selfDeps));
    if (entry.quote !== "single") diagnostics.push(...checkLiteralAddresses(index, entry, context));
    if (!parsed.problems.some((p) => p.range.start < entry.range.end && p.range.end > entry.range.start)) {
      diagnostics.push(...checkHardcoded(index, entry, context));
      // Where references are not allowed, a hint to write one would only lead to a refused save.
      if (context.references !== false) {
        diagnostics.push(...checkSingleQuoted(index, entry), ...checkBareReferences(index, entry, context));
      }
    }
  }

  return diagnostics.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
}

function checkReference(
  entry: EnvEntry,
  reference: EnvReference,
  context: AnalyzeContext,
  targets: Map<string, ReferenceTarget>,
  selfDeps: Map<string, EnvReference[]>,
): Diagnostic[] {
  const params = { target: reference.target, variable: reference.variable, key: entry.key };
  if (reference.target.toLowerCase() === context.self.name.toLowerCase() && reference.target !== sharedTarget) {
    // Its own built-in values (DOMAIN, URL, ...) depend on none of its variables: fine, an index aside.
    const own = selfTarget(context);
    const builtin = own?.variables.find((v) => v.name === reference.variable);
    if (own && builtin) return checkIndex(entry, reference, own, builtin) ?? [];
    const builtins = (context.self.builtins ?? []).map((v) => v.name);
    return [
      diag(
        "self-reference",
        "error",
        `${reference.target} is this service`,
        builtins.length
          ? `A service can reference its own ${builtins.join(", ")}, not its own variables: write ${reference.variable}'s value instead.`
          : "A service cannot reference its own variables; write the value instead.",
        { ...params, builtins: builtins.join(", ") },
        reference.targetRange,
      ),
    ];
  }
  const target = targets.get(reference.target.toLowerCase());
  if (!target) {
    const message =
      reference.target === sharedTarget ? "This project has no shared variables" : `No service named ${reference.target} in this project`;
    const names = context.targets.map((t) => t.name).filter((name) => name.toLowerCase() !== context.self.name.toLowerCase());
    return [
      diag("unknown-service", "error", message, "", params, reference.targetRange, suggest(reference.target, names, reference.targetRange)),
    ];
  }
  const variable = target.variables.find((v) => v.name === reference.variable);
  if (!variable) {
    const what = target.kind === "shared" ? "the shared variables" : target.name;
    // With an index only a list would do: DOMAINZ[1] -> DOMAINS[1], never DOMAIN[1].
    const names = target.variables.filter((v) => reference.index === undefined || v.list).map((v) => v.name);
    return [
      diag(
        "unknown-variable",
        "error",
        `${reference.variable} is not a variable of ${what}`,
        "",
        params,
        reference.variableRange,
        suggest(reference.variable, names, reference.variableRange),
      ),
    ];
  }

  const indexed = checkIndex(entry, reference, target, variable);
  if (indexed?.some((d) => d.severity === "error")) return indexed;

  const cycle = findCycle(context, targets, selfDeps, { target: target.name, variable: variable.name }, entry.key);
  if (cycle) {
    const chain = [`${context.self.name}.${entry.key}`, ...cycle].join(" -> ");
    return [
      diag(
        "reference-cycle",
        "error",
        `${entry.key} depends on itself`,
        `The references form a loop (${chain}), so none of these values can be resolved. Write one of them as a plain value.`,
        { ...params, chain },
        reference.range,
      ),
    ];
  }

  const out: Diagnostic[] = [];
  if (variable.scope === "internal") {
    const missing = missingNodes(context.self.nodes, target.nodes);
    if (missing.length > 0) out.push(crossNodeDiagnostic("reference", target, missing, context, reference.range, reference, entry));
  }
  // An item past the end says how many there are instead (an empty list has none).
  if (indexed) out.push(...indexed);
  else if (variable.value === "" && out.length === 0) {
    out.push(
      diag("empty-reference", "warning", `${target.name}.${variable.name} has no value yet`, variable.description, params, reference.range),
    );
  }
  return out;
}

/**
 * The index of VARIABLE[n], or null without one: not-a-list on a variable
 * that is no list (with "Did you mean" a list a typo away, DOMAIN[1] ->
 * DOMAINS[1], and the reference without the index), index-out-of-range
 * past the end of the list as it is now, [] when the item exists or the
 * list's value is not known.
 */
function checkIndex(entry: EnvEntry, reference: EnvReference, target: ReferenceTarget, variable: ReferenceVariable): Diagnostic[] | null {
  if (reference.index === undefined) return null;
  const index = reference.index;
  const at = String(index);
  const range = indexedRange(reference);
  const params = { target: target.name, variable: variable.name, key: entry.key, index: at };
  if (!variable.list) {
    const lists = target.variables.filter((v) => v.list).map((v) => v.name);
    const fixes: QuickFix[] = closestNames(variable.name, lists).map((name) => {
      const text = formatReference(reference.target, name, index);
      return { kind: "edit", title: `Use ${text}`, edits: [{ range: reference.range, text }] };
    });
    const plain = formatReference(reference.target, variable.name);
    fixes.push({ kind: "edit", title: `Use ${plain}`, edits: [{ range: reference.range, text: plain }] });
    const listed = lists.length > 0 ? ` ${target.name} has ${lists.join(", ")}.` : "";
    return [
      diag(
        "not-a-list",
        "error",
        `${variable.name} is not a list, so it takes no [${at}]`,
        `Only list variables such as DOMAINS take an index.${listed} Write ${plain} for the whole value.`,
        { ...params, lists: lists.join(", "), reference: plain },
        range,
        fixes,
      ),
    ];
  }
  if (variable.value === null) return [];
  const items = listItems(variable.value);
  if (index < items.length) return [];
  const noun = listItemName(variable.name);
  const has =
    items.length === 0
      ? `${target.name} has no ${noun}s yet`
      : `${target.name} has ${items.length} ${noun}${items.length === 1 ? "" : "s"}: ${indexNames(variable.name, items.length)}`;
  return [
    diag(
      "index-out-of-range",
      "warning",
      has,
      `${variable.name}[${at}] is empty until ${target.name} has ${index + 1} ${noun}${index === 0 ? "" : "s"}. Indexes start at 0: ${variable.name}[0] is the first.`,
      { ...params, count: String(items.length), item: noun, indexes: items.length > 0 ? indexNames(variable.name, items.length) : "" },
      range,
    ),
  ];
}

/** "DOMAINS[0]", "DOMAINS[0] and DOMAINS[1]", "DOMAINS[0] to DOMAINS[2]". */
function indexNames(name: string, count: number): string {
  if (count === 1) return `${name}[0]`;
  if (count === 2) return `${name}[0] and ${name}[1]`;
  return `${name}[0] to ${name}[${count - 1}]`;
}

/** From the variable's name to the end of its [n]: what an index problem underlines. */
function indexedRange(reference: EnvReference): SourceRange {
  const from = reference.variableRange;
  const to = reference.indexRange ?? from;
  return { ...from, end: to.end, endLine: to.endLine, endColumn: to.endColumn };
}

/**
 * Finds a target's internal host typed literally: "db:5432", "@db/",
 * "//db", or a value that is just "db". Text inside references is skipped.
 */
function checkLiteralAddresses(index: LineIndex, entry: EnvEntry, context: AnalyzeContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (context.self.nodes.length === 0) return out;
  const start = entry.valueRange.start + (entry.quote === "none" ? 0 : 1);
  const end = entry.valueRange.end - (entry.quote === "none" ? 0 : 1);
  const raw = index.text.slice(start, Math.max(start, end));

  for (const target of context.targets) {
    if (!target.internalHost || target.kind !== "service") continue;
    const missing = missingNodes(context.self.nodes, target.nodes);
    if (missing.length === 0) continue;
    for (const mention of hostMentions(raw, target.internalHost)) {
      const from = start + mention.from;
      const to = from + mention.host.length + mention.port.length;
      if (entry.references.some((r) => from < r.range.end && to > r.range.start)) continue;
      out.push(
        crossNodeDiagnostic("address", target, missing, context, index.range(from, to), null, entry, `${mention.host}${mention.port}`),
      );
    }
  }
  return out;
}

function crossNodeDiagnostic(
  via: "reference" | "address",
  target: ReferenceTarget,
  missing: NodeRef[],
  context: AnalyzeContext,
  range: SourceRange,
  reference: EnvReference | null,
  entry: EnvEntry,
  address = "",
): Diagnostic {
  const where = target.nodes.map((n) => n.name).join(", ") || "no node";
  const selfWhere = missing.map((n) => n.name).join(", ");
  const shown = via === "reference" && reference ? `${target.name}.${reference.variable}` : address;
  const params = { target: target.name, nodes: where, selfNodes: selfWhere, address: shown, key: entry.key };
  const fixes: QuickFix[] = [];

  const publicVariable = pickPublicVariable(target, reference?.variable ?? null);
  if (target.exposed && publicVariable) {
    // Replace the reference, or for a literal address the whole value, with the exposed variant.
    const editRange = reference ? reference.range : entry.valueRange;
    fixes.push({
      kind: "edit",
      title: `Use ${formatReference(target.name, publicVariable)}`,
      edits: [{ range: editRange, text: formatReference(target.name, publicVariable) }],
    });
  }
  const firstTargetNode = target.nodes[0];
  if (firstTargetNode && context.self.nodes.length === 1) {
    fixes.push({
      kind: "moveService",
      title: `Move ${context.self.name} to ${firstTargetNode.name}`,
      nodeId: firstTargetNode.id,
      nodeName: firstTargetNode.name,
    });
  }
  if (!target.exposed && target.serviceId) {
    fixes.push({ kind: "exposeService", title: `Expose ${target.name}`, serviceId: target.serviceId, serviceName: target.name });
  }

  if (!target.exposed) {
    return diag(
      "service-not-exposed",
      "error",
      `${target.name} is internal-only on ${where}`,
      `${shown} only works for services on ${where}. ${context.self.name} runs on ${selfWhere} and ${target.name} has no exposed address yet.`,
      params,
      range,
      fixes,
    );
  }
  return diag(
    via === "reference" ? "internal-reference-other-node" : "internal-address-other-node",
    "error",
    `${target.name} runs on another node`,
    `${shown} only works for services on ${where}. ${context.self.name} runs on ${selfWhere}, so this connection will fail. Use ${target.name}'s exposed URL instead.`,
    params,
    range,
    fixes,
  );
}

/** The public counterpart of an internal variable: INTERNAL_URL -> EXPOSED_URL, else URL. */
export function pickPublicVariable(target: ReferenceTarget, variable: string | null): string | null {
  const isPublic = (name: string) => target.variables.some((v) => v.name === name && v.scope === "public");
  const candidates = [variable?.replace(/^INTERNAL_/, "EXPOSED_"), variable?.replace(/^INTERNAL_/, ""), "EXPOSED_URL", "URL"].filter(
    (c): c is string => !!c && c !== variable,
  );
  return candidates.find(isPublic) ?? null;
}

/**
 * Follows references from start through the targets' dependsOn lists and
 * this file's own keys. Returns the chain (as "target.VARIABLE" steps,
 * start first) when it comes back to selfKey or runs into a loop, else null.
 */
function findCycle(
  context: AnalyzeContext,
  targets: Map<string, ReferenceTarget>,
  selfDeps: Map<string, EnvReference[]>,
  start: { target: string; variable: string },
  selfKey: string,
): string[] | null {
  const selfName = context.self.name.toLowerCase();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const finished = new Set<string>();

  const depsOf = (target: string, variable: string): { target: string; variable: string }[] => {
    if (target.toLowerCase() === selfName) {
      // Its own built-ins depend on nothing in the file.
      if (context.self.builtins?.some((v) => v.name === variable)) return [];
      return selfDeps.get(variable) ?? [];
    }
    const found = targets.get(target.toLowerCase())?.variables.find((v) => v.name === variable);
    return found?.dependsOn ?? [];
  };

  const visit = (target: string, variable: string): string[] | null => {
    const id = `${target.toLowerCase()}.${variable}`;
    const label = `${target}.${variable}`;
    if (target.toLowerCase() === selfName && variable === selfKey) return [...stack, label];
    if (onStack.has(id)) return [...stack, label];
    if (finished.has(id)) return null;
    stack.push(label);
    onStack.add(id);
    for (const dep of depsOf(target, variable)) {
      const found = visit(dep.target, dep.variable);
      if (found) return found;
    }
    stack.pop();
    onStack.delete(id);
    finished.add(id);
    return null;
  };
  return visit(start.target, start.variable);
}

function diag(
  code: Diagnostic["code"],
  severity: Diagnostic["severity"],
  message: string,
  detail: string,
  params: Record<string, string>,
  range: SourceRange,
  fixes: QuickFix[] = [],
): Diagnostic {
  return { code, severity, message, detail, params, range, fixes };
}
