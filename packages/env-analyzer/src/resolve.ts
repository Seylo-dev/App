// Turning references into values: for the panel when it compiles the
// desired state for an agent, for hovers in the editor, and for the
// References list.

import { listItems, referenceValue } from "./builtins";
import { missingNodes } from "./nodes";
import { formatReference, substituteReferences } from "./references";
import type { AnalyzeContext, EnvReference, ParsedEnv, ReferenceTarget, ReferenceVariable } from "./types";

export interface ResolvedEnv {
  /** Final key/value pairs in file order; later duplicates win. */
  values: Record<string, string>;
  /** References that had no target, variable or value; they stay as written in values. */
  unresolved: { key: string; target: string; variable: string }[];
}

/**
 * The service being edited as a reference target that holds only its own
 * built-in values (AnalyzeContext.self.builtins); null without any.
 */
export function selfTarget(context: AnalyzeContext): ReferenceTarget | null {
  const builtins = context.self.builtins;
  if (!builtins?.length || !context.self.name) return null;
  return {
    name: context.self.name,
    kind: "service",
    serviceId: context.self.serviceId,
    serviceKind: null,
    nodes: context.self.nodes,
    internalHost: context.self.name,
    exposed: true,
    variables: builtins,
  };
}

export function findVariable(
  context: AnalyzeContext,
  target: string,
  variable: string,
): { target: ReferenceTarget; variable: ReferenceVariable } | null {
  if (target.toLowerCase() === context.self.name.toLowerCase()) {
    const own = selfTarget(context);
    const v = own?.variables.find((c) => c.name === variable);
    return own && v ? { target: own, variable: v } : null;
  }
  const t = context.targets.find((c) => c.name.toLowerCase() === target.toLowerCase());
  const v = t?.variables.find((c) => c.name === variable);
  return t && v ? { target: t, variable: v } : null;
}

/** Replaces every reference with its value from the context. */
export function resolveEnv(parsed: ParsedEnv, context: AnalyzeContext): ResolvedEnv {
  const values: Record<string, string> = {};
  const unresolved: ResolvedEnv["unresolved"] = [];
  for (const entry of parsed.entries) {
    if (entry.quote === "single") {
      values[entry.key] = entry.value;
      continue;
    }
    const result = substituteReferences(entry.value, (target, variable, index) =>
      referenceValue(findVariable(context, target, variable)?.variable, index),
    );
    values[entry.key] = result.value;
    for (const missing of result.unresolved) unresolved.push({ key: entry.key, ...missing });
  }
  return { values, unresolved };
}

export interface ReferenceHover {
  reference: EnvReference;
  target: ReferenceTarget | null;
  variable: ReferenceVariable | null;
  /**
   * What the reference becomes: the variable's value, or for
   * ${{api.DOMAINS[1]}} that item ("" past the end). Null when unknown,
   * hidden from the caller, or an index on a variable that is no list.
   */
  value: string | null;
  /** False when the variable is internal and the target misses one of this service's nodes. */
  reachable: boolean;
}

/** What a hover over a reference shows. */
export function describeReference(reference: EnvReference, context: AnalyzeContext): ReferenceHover {
  const found = findVariable(context, reference.target, reference.variable);
  if (!found) return { reference, target: null, variable: null, value: null, reachable: false };
  const reachable = found.variable.scope !== "internal" || missingNodes(context.self.nodes, found.target.nodes).length === 0;
  return { reference, target: found.target, variable: found.variable, value: referenceValue(found.variable, reference.index), reachable };
}

export interface ReferenceCompletion {
  /** "db.EXPOSED_URL", "api.DOMAINS[1]" */
  label: string;
  /** "${{db.EXPOSED_URL}}" */
  insertText: string;
  target: ReferenceTarget;
  variable: ReferenceVariable;
  /** The n of an item of a list ("api.DOMAINS[1]"); left out for the variable itself. */
  index?: number;
  /** What it becomes: the variable's value, or the item's. */
  value: string | null;
  reachable: boolean;
}

/**
 * Every reference the service could insert, reachable ones first. The
 * References button lists these; internal variables of services on other
 * nodes are included but marked unreachable so the UI can grey them out.
 * A list with two or more items (DOMAINS of a service with several
 * domains) is followed by each item, LIST[0] to LIST[n-1].
 */
export function referenceCompletions(context: AnalyzeContext): ReferenceCompletion[] {
  const out: ReferenceCompletion[] = [];
  const own = selfTarget(context);
  for (const target of own ? [own, ...context.targets] : context.targets) {
    const sameNodes = missingNodes(context.self.nodes, target.nodes).length === 0;
    for (const variable of target.variables) {
      const reachable = variable.scope !== "internal" || sameNodes;
      out.push({
        label: `${target.name}.${variable.name}`,
        insertText: formatReference(target.name, variable.name),
        target,
        variable,
        value: variable.value,
        reachable,
      });
      const items = variable.list && variable.value !== null ? listItems(variable.value) : [];
      if (items.length < 2) continue;
      for (const [index, item] of items.entries()) {
        out.push({
          label: `${target.name}.${variable.name}[${index}]`,
          insertText: formatReference(target.name, variable.name, index),
          target,
          variable,
          index,
          value: item,
          reachable,
        });
      }
    }
  }
  return out.sort((a, b) => Number(b.reachable) - Number(a.reachable));
}
