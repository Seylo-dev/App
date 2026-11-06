// Diagnostics that need to know about other services: unknown references,
// duplicate keys, and the one this package exists for - an internal address
// of a service that runs on another node. There is no cross-node private
// network, so db:5432 or ${{db.INTERNAL_URL}} only works for services that
// have an instance on every node this service runs on.

import { parseEnv } from "./parse";
import { formatReference, sharedTarget } from "./references";
import { LineIndex } from "./source";
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
    return [
      diag(
        "self-reference",
        "error",
        `${reference.target} is this service`,
        "A service cannot reference its own variables; write the value instead.",
        params,
        reference.targetRange,
      ),
    ];
  }
  const target = targets.get(reference.target.toLowerCase());
  if (!target) {
    const message =
      reference.target === sharedTarget ? "This project has no shared variables" : `No service named ${reference.target} in this project`;
    const names = context.targets.map((t) => t.name).filter((name) => name.toLowerCase() !== context.self.name.toLowerCase());
    return [diag("unknown-service", "error", message, "", params, reference.targetRange, suggest(reference.target, names, reference.targetRange))];
  }
  const variable = target.variables.find((v) => v.name === reference.variable);
  if (!variable) {
    const what = target.kind === "shared" ? "the shared variables" : target.name;
    const names = target.variables.map((v) => v.name);
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
  if (variable.value === "" && out.length === 0) {
    out.push(
      diag("empty-reference", "warning", `${target.name}.${variable.name} has no value yet`, variable.description, params, reference.range),
    );
  }
  return out;
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
    const host = escapeRegExp(target.internalHost);
    const pattern = new RegExp(`(^|@|//)(${host})(:\\d{1,5})?(?=$|[/?#\\s,;])|(^|[\\s,;=(])(${host}):(\\d{1,5})(?=$|[/?#\\s,;)])`, "gi");
    for (const match of raw.matchAll(pattern)) {
      const prefix = match[1] ?? match[4] ?? "";
      const hostText = match[2] ?? match[5] ?? "";
      const port = match[3] ?? (match[6] ? `:${match[6]}` : "");
      // "^db$" alone only counts when it is the whole value.
      if (prefix === "" && match.index === 0 && port === "" && hostText.length !== raw.trim().length) continue;
      const from = start + (match.index ?? 0) + prefix.length;
      const to = from + hostText.length + port.length;
      if (entry.references.some((r) => from < r.range.end && to > r.range.start)) continue;
      out.push(crossNodeDiagnostic("address", target, missing, context, index.range(from, to), null, entry, `${hostText}${port}`));
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
function pickPublicVariable(target: ReferenceTarget, variable: string | null): string | null {
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
    if (target.toLowerCase() === selfName) return selfDeps.get(variable) ?? [];
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

/** A "Did you mean" fix when a known name is a typo away (case or up to two edits). */
function suggest(wrong: string, known: readonly string[], range: SourceRange): QuickFix[] {
  // Short names get fewer edits, so "db" never suggests "api".
  const limit = wrong.length >= 6 ? 2 : wrong.length >= 3 ? 1 : 0;
  let best: { name: string; distance: number } | null = null;
  for (const name of known) {
    if (name === wrong) continue;
    const distance = editDistance(name.toLowerCase(), wrong.toLowerCase());
    if (distance <= limit && (!best || distance < best.distance)) best = { name, distance };
  }
  return best ? [{ kind: "edit", title: `Change to ${best.name}`, edits: [{ range, text: best.name }] }] : [];
}

/** Levenshtein distance, small inputs only. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Nodes of self that the target has no instance on. Shared targets and unplaced services never miss. */
export function missingNodes(self: readonly NodeRef[], target: readonly NodeRef[]): NodeRef[] {
  if (target.length === 0) return [];
  const have = new Set(target.map((n) => n.id));
  return self.filter((n) => !have.has(n.id));
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
