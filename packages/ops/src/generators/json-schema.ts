// TypeBox schemas are JSON Schema plus symbol-keyed metadata. Generators
// emit plain JSON, so they strip the symbols with one JSON round trip.

import type { TSchema } from "@sinclair/typebox";

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: TSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}
