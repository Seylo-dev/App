// Walks TypeBox schemas by field path. Used to check that every sensitive
// path an op declares exists, and that no secret-looking field was missed.

import type { TSchema } from "@sinclair/typebox";

/**
 * Field names that almost always hold a secret, matched on the end of the
 * name so "clientSecret" counts and "tokenExpiresAt" does not.
 */
const secretSuffixes = [
  "password",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "secretaccesskey",
  "credential",
  "credentials",
];

function looksSecret(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return secretSuffixes.some((suffix) => normalized.endsWith(suffix));
}

/** True when `path` (dotted, `*` for any index or key) resolves in `schema`. */
export function schemaHasPath(schema: TSchema, path: string): boolean {
  return resolve(schema, path.split("."));
}

function resolve(schema: TSchema, segments: string[]): boolean {
  if (segments.length === 0) return true;
  const [head, ...rest] = segments as [string, ...string[]];
  return childrenOf(schema).some(([key, child]) => (key === head || key === "*") && resolve(child, rest));
}

/**
 * Every leaf path whose last field name looks like a secret, for example
 * "password" or "providers.*.apiKey".
 */
export function secretLookingPaths(schema: TSchema): string[] {
  return pathsWhere(schema, looksSecret);
}

/**
 * Every path whose last field name matches, for checks narrower than the
 * registry-wide one (a module whose URLs carry passwords, say).
 */
export function pathsWhere(schema: TSchema, match: (key: string) => boolean, prefix: string[] = []): string[] {
  const found: string[] = [];
  for (const [key, child] of childrenOf(schema)) {
    const path = [...prefix, key];
    if (key !== "*" && match(key) && canHoldSecret(child)) found.push(path.join("."));
    found.push(...pathsWhere(child, match, path));
  }
  return [...new Set(found)];
}

/**
 * False for a field that cannot carry a secret value itself: a boolean, null,
 * or an object with named fields (those fields are checked on their own). A
 * flag such as "keepNativePassword" or an object such as "nativePassword:
 * { on, lines }" is not a secret; a string, a number, an array or a record of
 * those, or a schema with no type at all might be.
 */
function canHoldSecret(schema: TSchema): boolean {
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])] as TSchema[];
  if (branches.length > 0) return branches.some(canHoldSecret);
  if (schema.type === "boolean" || schema.type === "null" || typeof schema.const === "boolean") return false;
  if (schema.type === "object" && schema.properties && !schema.additionalProperties && !schema.patternProperties) return false;
  if (schema.type === "array") return schema.items && !Array.isArray(schema.items) ? canHoldSecret(schema.items as TSchema) : true;
  return true;
}

/**
 * Direct children as [key, schema]. Arrays and records use "*". Unions,
 * intersections and nullable wrappers are flattened so a field that exists
 * in any branch counts.
 */
function childrenOf(schema: TSchema): [string, TSchema][] {
  const out: [string, TSchema][] = [];
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties as Record<string, TSchema>)) out.push([key, child]);
  }
  if (schema.items && !Array.isArray(schema.items)) out.push(["*", schema.items as TSchema]);
  if (schema.patternProperties) {
    for (const child of Object.values(schema.patternProperties as Record<string, TSchema>)) out.push(["*", child]);
  }
  if (typeof schema.additionalProperties === "object") out.push(["*", schema.additionalProperties as TSchema]);
  for (const branch of [...(schema.anyOf ?? []), ...(schema.allOf ?? []), ...(schema.oneOf ?? [])] as TSchema[]) {
    out.push(...childrenOf(branch));
  }
  return out;
}
