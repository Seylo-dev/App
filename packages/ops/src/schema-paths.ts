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
export function secretLookingPaths(schema: TSchema, prefix: string[] = []): string[] {
  const found: string[] = [];
  for (const [key, child] of childrenOf(schema)) {
    const path = [...prefix, key];
    if (key !== "*" && looksSecret(key)) found.push(path.join("."));
    found.push(...secretLookingPaths(child, path));
  }
  return [...new Set(found)];
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
