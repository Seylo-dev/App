// Input and output validation against an op's TypeBox schemas. Compiled
// checkers are cached per schema, since the same ops run all day.

import { OpError } from "@seylo/ops";
import type { TSchema } from "@sinclair/typebox";
import { type TypeCheck, TypeCompiler, type ValueError, ValueErrorType } from "@sinclair/typebox/compiler";
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
    const error = first && inChosenVariant(first);
    const field = error?.path.replace(/^\//, "").replaceAll("/", ".") || "(input)";
    const message = (error?.schema as { errorMessage?: string } | undefined)?.errorMessage ?? error?.message;
    throw new OpError("BAD_REQUEST", `Invalid ${field}: ${message ?? "does not match the schema"}.`, { field });
  }
  return value;
}

/**
 * A union (a source's "git" or "image" shape) only says "Expected union
 * value". When exactly one variant's literals matched (the `type` the caller
 * picked), its own first error names the real field instead.
 */
function inChosenVariant(error: ValueError): ValueError {
  if (error.type !== ValueErrorType.Union) return error;
  const variants = error.errors.map((iterator) => [...iterator]);
  const chosen = variants.filter((errors) => errors.length > 0 && !errors.some((e) => e.type === ValueErrorType.Literal));
  const first = chosen.length === 1 ? chosen[0]?.[0] : undefined;
  return first ? inChosenVariant(first) : error;
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
