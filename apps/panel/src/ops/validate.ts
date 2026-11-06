// Input and output validation against an op's TypeBox schemas. Compiled
// checkers are cached per schema, since the same ops run all day.

import { OpError } from "@seylo/ops";
import type { TSchema } from "@sinclair/typebox";
import { type TypeCheck, TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";

const compiled = new WeakMap<TSchema, TypeCheck<TSchema>>();

function checker(schema: TSchema): TypeCheck<TSchema> {
  let check = compiled.get(schema);
  if (!check) {
    check = TypeCompiler.Compile(schema);
    compiled.set(schema, check);
  }
  return check;
}

/**
 * Validates raw input: unknown fields are dropped, defaults applied, and
 * with `coerce` (query strings) "3" becomes 3 and "true" becomes true.
 * Throws BAD_REQUEST naming the first invalid field.
 */
export function parseInput(schema: TSchema, raw: unknown, coerce: boolean): unknown {
  let value = Value.Clean(schema, Value.Clone(raw ?? {}));
  value = Value.Default(schema, value);
  if (coerce) value = Value.Convert(schema, value);
  const check = checker(schema);
  if (!check.Check(value)) {
    const first = check.Errors(value).First();
    const field = first?.path.replace(/^\//, "").replaceAll("/", ".") || "(input)";
    throw new OpError("BAD_REQUEST", `Invalid ${field}: ${first?.message ?? "does not match the schema"}.`, { field });
  }
  return value;
}

/**
 * Strips fields the schema does not declare (so a handler returning a whole
 * database row cannot leak columns) and checks the rest. A mismatch is a
 * bug in the handler, reported as INTERNAL.
 */
export function checkOutput(schema: TSchema, output: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  const value = Value.Clean(schema, Value.Clone(output));
  const check = checker(schema);
  if (check.Check(value)) return { ok: true, value };
  const first = check.Errors(value).First();
  return { ok: false, reason: `${first?.path || "/"}: ${first?.message ?? "invalid"}` };
}
