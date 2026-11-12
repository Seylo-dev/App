// Env op handlers: the service's .env text and the project's shared
// variables (sealed at rest), the References list (resolved values, hidden
// where the caller may not see the target), and diagnostics from
// @seylo/env-analyzer, the same code the web editor runs locally.

import { analyzeEnv, analyzeParsed, type Diagnostic, type EnvEntry, type ParsedEnv, parseEnv, setEnvVariable } from "@seylo/env-analyzer";
import { env as envOps, OpError } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { projects, servicePlacements, services } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { getService, invalidateService, type ServiceRow } from "../domains/lookup";
import { receivesShared } from "./desired";
import { buildEnvGraph, contextFor, type GraphService, isCredentialVariable } from "./graph";
import { matchesExpected, readProjectEnv, readServiceEnv, writeProjectEnv, writeServiceEnv } from "./store";

function variablesOf(text: string) {
  return parseEnv(text).entries.map((e) => ({ key: e.key, value: e.value, line: e.keyRange.startLine }));
}

function syntaxErrors(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error" && isSyntaxCode(d.code));
}

const syntaxCodes = new Set([
  "invalid-line",
  "invalid-key",
  "missing-equals",
  "unterminated-quote",
  "trailing-characters",
  "unterminated-reference",
  "malformed-reference",
]);
function isSyntaxCode(code: string): boolean {
  return syntaxCodes.has(code);
}

function refuseSyntax(errors: Diagnostic[]): never {
  const first = errors[0];
  throw new OpError("BAD_REQUEST", `Line ${first?.range.startLine}: ${first?.message}. Fix the syntax errors before saving.`, {
    field: "text",
    code: first?.code ?? "",
    line: String(first?.range.startLine ?? 0),
    errors: String(errors.length),
  });
}

/** Who may see which values in the References list: env.view on the target, databases.credentials for DB secrets. */
function visibility(ctx: OpContext, projectId: string) {
  const cache = new Map<string, boolean>();
  const can = (action: `${string}.${string}`, type: "project" | "service", id: string) => {
    const key = `${action}:${type}:${id}`;
    let allowed = cache.get(key);
    if (allowed === undefined) {
      allowed = ctx.access.can(action, { type, id });
      cache.set(key, allowed);
    }
    return allowed;
  };
  return (target: GraphService | "shared", variable: string): boolean => {
    if (target === "shared") return can("env.view", "project", projectId);
    if (isCredentialVariable(target, variable)) return can("databases.credentials", "service", target.row.id);
    const isBuiltin = target.builtins.some((b) => b.name === variable);
    // Addresses (URL, host, port) are not secrets; another service's own values are.
    return isBuiltin || can("env.view", "service", target.row.id);
  };
}

export const get = implement(envOps.get, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  const stored = readServiceEnv(ctx.db, ctx.secrets, service.id);
  const own = new Set(parseEnv(stored.text).entries.map((e) => e.key));
  const shared = receivesShared(service.kind)
    ? parseEnv(readProjectEnv(ctx.db, ctx.secrets, service.projectId).text).entries.filter((e) => !own.has(e.key))
    : [];
  return {
    text: stored.text,
    variables: variablesOf(stored.text),
    sharedCount: new Set(shared.map((e) => e.key)).size,
    updatedAt: stored.updatedAt?.toISOString() ?? null,
  };
});

/**
 * The first ${{target.VAR}} in `parsed` that `canSee` refuses, or null.
 * `self` holds the lower-cased names whose values are the writer's own (the
 * service itself, or every member of a stack or template being written);
 * unknown targets are diagnostics, not secrets.
 */
export function hiddenReference(
  graph: ReturnType<typeof buildEnvGraph>,
  self: ReadonlySet<string>,
  parsed: ParsedEnv,
  canSee: (target: GraphService | "shared", variable: string) => boolean,
): { key: string; line: number; reference: string } | null {
  for (const entry of parsed.entries) {
    for (const ref of entry.references) {
      const target = ref.target.toLowerCase() === "project" ? "shared" : graph.byName(ref.target);
      if (!target || (target !== "shared" && self.has(target.row.name.toLowerCase()))) continue;
      if (canSee(target, ref.variable)) continue;
      return { key: entry.key, line: entry.keyRange.startLine, reference: `${ref.target}.${ref.variable}` };
    }
  }
  return null;
}

/**
 * Refuses a ${{target.VAR}} the caller may not see: the container resolves
 * references whoever wrote them, so a hidden value in the References list
 * must not be one line of .env away. Same rule as the list (visibility()).
 * Every path that writes a service's .env runs it: env.set, compose stacks
 * (each member's environment:) and templates. `where` names the member or
 * template service in the message instead of a line number.
 */
export function checkEnvReferences(
  ctx: OpContext,
  projectId: string,
  self: readonly string[],
  text: string,
  options: { graph?: ReturnType<typeof buildEnvGraph>; where?: string } = {},
): void {
  assertVisible(ctx, options.graph ?? buildEnvGraph(ctx, projectId), projectId, self, parseEnv(text), options.where);
}

function assertVisible(
  ctx: OpContext,
  graph: ReturnType<typeof buildEnvGraph>,
  projectId: string,
  self: readonly string[],
  parsed: ParsedEnv,
  where?: string,
): void {
  const hidden = hiddenReference(graph, new Set(self.map((n) => n.toLowerCase())), parsed, visibility(ctx, projectId));
  if (!hidden) return;
  const at = where ? `${where}` : `Line ${hidden.line}`;
  throw new OpError("FORBIDDEN", `${at}: you cannot read ${hidden.reference}, so ${hidden.key} cannot reference it.`, {
    field: where ? "env" : "text",
    line: String(hidden.line),
    reference: hidden.reference,
    ...(where ? { service: where } : {}),
  });
}

function refuseStale(what: "environment" | "shared"): never {
  const message =
    what === "environment"
      ? "Someone else saved this environment in the meantime. Reload to see their changes."
      : "Someone else saved the shared variables in the meantime. Reload to see their changes.";
  throw new OpError("CONFLICT", message, { reason: "stale" });
}

/**
 * One variable changed in stored text (setEnvVariable), or the refusal. The
 * messages name the key, never the value: it can be a secret and the audit
 * log and model transcripts keep error messages.
 */
function editVariable(text: string, key: string, value: string | null): string {
  const edit = setEnvVariable(text, key, value);
  if (edit.ok) return edit.text;
  if (edit.reason === "not-set") throw new OpError("NOT_FOUND", `${key} is not set, so there is nothing to remove.`, { field: "key", key });
  throw new OpError("BAD_REQUEST", edit.message, { field: edit.reason === "invalid-key" ? "key" : "value", key });
}

/** Whether running instances still have the old values after a change, and the live updates every service env write sends. */
function afterServiceWrite(ctx: OpContext, service: ServiceRow, changed: boolean): boolean {
  const running = ctx.agents.state.serviceStatuses(service.id).length > 0 || service.liveDeploymentId !== null;
  invalidateService(ctx, service.id, [envOps.get.id, envOps.analyze.id]);
  // Other services that reference this one see new values in their References list.
  ctx.live.publish(`project:${service.projectId}`, { type: "invalidate", ops: [envOps.references.id] });
  return changed && running;
}

export const set = implement(envOps.set, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  const graph = buildEnvGraph(ctx, service.projectId);
  const { parsed, diagnostics } = analyzeEnv(input.text, contextFor(graph, service.id));
  const errors = syntaxErrors(parsed.problems);
  if (errors.length > 0) refuseSyntax(errors);
  assertVisible(ctx, graph, service.projectId, [service.name], parsed);

  const updatedAt = ctx.db.transaction((tx) => {
    const stored = readServiceEnv(tx, ctx.secrets, service.id);
    if (!matchesExpected(stored.updatedAt, input.expectedUpdatedAt)) refuseStale("environment");
    return {
      at: writeServiceEnv(tx, ctx.secrets, service.id, input.text, userOf(ctx.principal)?.id ?? null),
      changed: stored.text !== input.text,
    };
  });
  return { updatedAt: updatedAt.at.toISOString(), diagnostics, restartNeeded: afterServiceWrite(ctx, service, updatedAt.changed) };
});

/**
 * One variable of the saved text, the others left as they are: what a model
 * can do with env.get's values redacted. The same checks as env.set, on the
 * edited line: its references must be ones the caller may see (other lines
 * were written by whoever wrote them), and the file must have no syntax errors.
 */
export const setVariable = implement(envOps.setVariable, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  const graph = buildEnvGraph(ctx, service.projectId);
  const saved = ctx.db.transaction((tx) => {
    const stored = readServiceEnv(tx, ctx.secrets, service.id);
    if (!matchesExpected(stored.updatedAt, input.expectedUpdatedAt)) refuseStale("environment");
    const text = editVariable(stored.text, input.key, input.value);
    const parsed = parseEnv(text);
    const errors = syntaxErrors(parsed.problems);
    if (errors.length > 0) refuseSyntax(errors);
    const edited = parsed.entries.findLast((e) => e.key === input.key);
    assertVisible(ctx, graph, service.projectId, [service.name], { ...parsed, entries: edited ? [edited] : [] });
    return {
      at: writeServiceEnv(tx, ctx.secrets, service.id, text, userOf(ctx.principal)?.id ?? null),
      text,
      changed: stored.text !== text,
    };
  });
  const { diagnostics } = analyzeEnv(saved.text, contextFor(graph, service.id));
  return { updatedAt: saved.at.toISOString(), diagnostics, restartNeeded: afterServiceWrite(ctx, service, saved.changed) };
});

export const references = implement(envOps.references, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  const graph = buildEnvGraph(ctx, service.projectId);
  return contextFor(graph, service.id, { canSee: visibility(ctx, service.projectId) });
});

export const analyze = implement(envOps.analyze, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  const graph = buildEnvGraph(ctx, service.projectId);
  const self = graph.services.find((s) => s.row.id === service.id);
  if (!self) return { diagnostics: [] };
  return { diagnostics: analyzeParsed(self.parsed, contextFor(graph, service.id)) };
});

function requireProject(ctx: OpContext, projectId: string) {
  const row = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!row) throw new OpError("NOT_FOUND", "That project does not exist.", { projectId });
  return row;
}

export const getShared = implement(envOps.getShared, (input, ctx) => {
  requireProject(ctx, input.projectId);
  const stored = readProjectEnv(ctx.db, ctx.secrets, input.projectId);
  return { text: stored.text, variables: variablesOf(stored.text), updatedAt: stored.updatedAt?.toISOString() ?? null };
});

/** Shared variables are plain values: the first entry with a reference is refused. */
function refuseSharedReferences(entries: readonly EnvEntry[], field: "text" | "value"): void {
  const withReference = entries.find((e) => e.references.length > 0);
  if (!withReference) return;
  throw new OpError(
    "BAD_REQUEST",
    `Line ${withReference.keyRange.startLine}: shared variables cannot reference services. Write the value instead.`,
    {
      field,
      line: String(withReference.keyRange.startLine),
    },
  );
}

/** Keys whose last value differs between two versions of a .env text (added and removed ones too). */
function changedKeys(before: ParsedEnv, after: ParsedEnv): Set<string> {
  const old = new Map(before.entries.map((e) => [e.key, e.value]));
  const now = new Map(after.entries.map((e) => [e.key, e.value]));
  return new Set([...old.keys(), ...now.keys()].filter((k) => old.get(k) !== now.get(k)));
}

/**
 * Services running with an old value after shared keys changed: they
 * receive shared variables (or reference them) and do not override the key.
 * Also sends the live updates every shared variables write sends.
 */
function afterSharedWrite(ctx: OpContext, projectId: string, changed: ReadonlySet<string>): string[] {
  const affected: string[] = [];
  if (changed.size > 0) {
    const rows = ctx.db.select().from(services).where(eq(services.projectId, projectId)).all();
    for (const row of rows) {
      const placed = ctx.db
        .select({ nodeId: servicePlacements.nodeId })
        .from(servicePlacements)
        .where(and(eq(servicePlacements.serviceId, row.id)))
        .get();
      if (!placed) continue;
      const own = parseEnv(readServiceEnv(ctx.db, ctx.secrets, row.id).text);
      const ownKeys = new Set(own.entries.map((e) => e.key));
      const references = own.entries.some((e) => e.references.some((r) => r.target === "project" && changed.has(r.variable)));
      const inherits = receivesShared(row.kind) && [...changed].some((k) => !ownKeys.has(k));
      if (references || inherits) affected.push(row.id);
    }
  }
  ctx.live.publish(`project:${projectId}`, { type: "invalidate", ops: [envOps.getShared.id, envOps.get.id, envOps.references.id] });
  return affected;
}

export const setShared = implement(envOps.setShared, (input, ctx) => {
  requireProject(ctx, input.projectId);
  const parsed = parseEnv(input.text);
  const errors = syntaxErrors(parsed.problems);
  if (errors.length > 0) refuseSyntax(errors);
  refuseSharedReferences(parsed.entries, "text");

  const result = ctx.db.transaction((tx) => {
    const stored = readProjectEnv(tx, ctx.secrets, input.projectId);
    if (!matchesExpected(stored.updatedAt, input.expectedUpdatedAt)) refuseStale("shared");
    const at = writeProjectEnv(tx, ctx.secrets, input.projectId, input.text, userOf(ctx.principal)?.id ?? null);
    return { at, changed: changedKeys(parseEnv(stored.text), parsed) };
  });
  return {
    updatedAt: result.at.toISOString(),
    diagnostics: parsed.problems,
    affectedServiceIds: afterSharedWrite(ctx, input.projectId, result.changed),
  };
});

/** One shared variable, the others left as they are (env.setVariable for the project's shared variables). */
export const setSharedVariable = implement(envOps.setSharedVariable, (input, ctx) => {
  requireProject(ctx, input.projectId);
  const result = ctx.db.transaction((tx) => {
    const stored = readProjectEnv(tx, ctx.secrets, input.projectId);
    if (!matchesExpected(stored.updatedAt, input.expectedUpdatedAt)) refuseStale("shared");
    const text = editVariable(stored.text, input.key, input.value);
    const parsed = parseEnv(text);
    const errors = syntaxErrors(parsed.problems);
    if (errors.length > 0) refuseSyntax(errors);
    refuseSharedReferences(
      parsed.entries.filter((e) => e.key === input.key),
      "value",
    );
    const at = writeProjectEnv(tx, ctx.secrets, input.projectId, text, userOf(ctx.principal)?.id ?? null);
    return { at, parsed, changed: changedKeys(parseEnv(stored.text), parsed) };
  });
  return {
    updatedAt: result.at.toISOString(),
    diagnostics: result.parsed.problems,
    affectedServiceIds: afterSharedWrite(ctx, input.projectId, result.changed),
  };
});
