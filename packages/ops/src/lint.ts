// Rules every op contract must follow. The test suite runs lintOp over the
// whole registry, so a new op that breaks one fails CI with a plain reason.

import { Kind, type TSchema } from "@sinclair/typebox";
import type { AnyOpContract } from "./define";
import { registeredFormats } from "./formats";
import { schemaHasPath, secretLookingPaths } from "./schema-paths";

/** TypeBox kinds that have no JSON form; they would break OpenAPI and MCP. */
const nonJsonKinds = new Set([
  "Date",
  "Uint8Array",
  "Function",
  "Constructor",
  "Undefined",
  "Symbol",
  "BigInt",
  "Promise",
  "AsyncIterator",
  "Iterator",
]);

/** Kinds a query-string parameter can hold. */
const scalarKinds = new Set(["String", "Number", "Integer", "Boolean", "Literal"]);

export function lintOp(op: AnyOpContract): string[] {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(`${op.id}: ${message}`);

  if (op.summary.trim() === "") problem("summary is empty");
  if (op.description.trim().length < 20) problem("description must say what the op does (20+ characters)");
  if (!op.permission || !["public", "signedIn", "global", "project", "service"].includes(op.permission.kind)) {
    problem("permission is missing or unknown");
  }
  if (op.kind !== "query" && !op.audit) problem(`${op.kind} ops must be audited`);
  if (op.kind === "destructive" && op.permission.kind === "public") problem("destructive ops cannot be public");

  for (const [side, schema] of [
    ["input", op.input],
    ["output", op.output],
  ] as const) {
    const declared = op.sensitive?.[side] ?? [];
    for (const path of declared) {
      if (!schemaHasPath(schema, path)) problem(`sensitive ${side} path "${path}" does not exist in the schema`);
    }
    for (const path of secretLookingPaths(schema)) {
      if (!declared.some((d) => covers(d, path))) {
        problem(`${side} field "${path}" looks secret; list it in sensitive.${side} so audit and model output redact it`);
      }
    }
    for (const format of formatsIn(schema)) {
      if (!registeredFormats.includes(format)) problem(`${side} uses format "${format}", which is not registered in src/formats.ts`);
    }
    for (const kind of kindsIn(schema)) {
      if (nonJsonKinds.has(kind)) problem(`${side} uses Type.${kind}, which has no JSON form; use a string format instead`);
    }
  }

  if (op.kind === "query") {
    for (const [name, prop] of Object.entries(op.input.properties)) {
      if (!isScalar(prop)) problem(`query input "${name}" must be a scalar so it fits in the query string`);
    }
  }
  return problems;
}

/** A declared path covers itself and everything below it. */
function covers(declared: string, path: string): boolean {
  const d = declared.split(".");
  const p = path.split(".");
  return d.length <= p.length && d.every((segment, i) => segment === p[i] || segment === "*" || p[i] === "*");
}

function isScalar(schema: TSchema): boolean {
  if (scalarKinds.has(schema[Kind])) return true;
  return schema[Kind] === "Union" && (schema.anyOf as TSchema[]).every(isScalar);
}

function kindsIn(schema: TSchema, seen = new Set<string>()): Set<string> {
  seen.add(schema[Kind]);
  for (const child of childSchemas(schema)) kindsIn(child, seen);
  return seen;
}

function formatsIn(schema: TSchema, seen = new Set<string>()): Set<string> {
  if (typeof schema.format === "string") seen.add(schema.format);
  for (const child of childSchemas(schema)) formatsIn(child, seen);
  return seen;
}

function childSchemas(schema: TSchema): TSchema[] {
  return [
    ...Object.values((schema.properties ?? {}) as Record<string, TSchema>),
    ...Object.values((schema.patternProperties ?? {}) as Record<string, TSchema>),
    ...((schema.anyOf ?? []) as TSchema[]),
    ...((schema.allOf ?? []) as TSchema[]),
    ...(schema.items && !Array.isArray(schema.items) ? [schema.items as TSchema] : []),
    ...(typeof schema.additionalProperties === "object" ? [schema.additionalProperties as TSchema] : []),
  ];
}
