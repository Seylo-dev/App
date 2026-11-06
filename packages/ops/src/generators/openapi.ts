// Builds the OpenAPI 3.1 document for the REST API from the op registry.
// scripts/gen-openapi.ts writes it to openapi.json; the docs site renders
// its API reference from that file.

import type { AnyOpContract } from "../define";
import { moduleOf } from "../define";
import { ErrorBody } from "../errors";
import { describePermission } from "../permission";
import { opRoute } from "../registry";
import { type JsonSchema, toJsonSchema } from "./json-schema";

export interface OpenApiOptions {
  title: string;
  version: string;
  description?: string;
  /** Name of the session cookie, documented as an auth scheme. */
  sessionCookie: string;
}

export function buildOpenApi(ops: readonly AnyOpContract[], options: OpenApiOptions): JsonSchema {
  const paths: Record<string, JsonSchema> = {};
  for (const op of ops) {
    const { method, path } = opRoute(op);
    paths[path] = { [method.toLowerCase()]: operation(op) };
  }
  return {
    openapi: "3.1.0",
    info: { title: options.title, version: options.version, description: options.description },
    paths,
    components: {
      schemas: { ErrorBody: toJsonSchema(ErrorBody) },
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: options.sessionCookie },
        apiKey: { type: "http", scheme: "bearer", description: "API key or MCP token." },
      },
      responses: {
        Error: {
          description: "The op failed; `error.code` says why.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } } },
        },
      },
    },
  };
}

function operation(op: AnyOpContract): JsonSchema {
  const isQuery = op.kind === "query";
  return {
    operationId: op.id,
    summary: op.summary,
    description: op.description,
    tags: [moduleOf(op)],
    security: op.permission.kind === "public" ? [] : [{ session: [] }, { apiKey: [] }],
    ...(isQuery ? { parameters: queryParameters(op) } : { requestBody: jsonBody(op) }),
    responses: {
      "200": { description: "Success.", content: { "application/json": { schema: toJsonSchema(op.output) } } },
      default: { $ref: "#/components/responses/Error" },
    },
    "x-op-kind": op.kind,
    "x-permission": describePermission(op.permission),
    "x-mcp": op.mcp,
  };
}

function queryParameters(op: AnyOpContract): JsonSchema[] {
  const required = new Set<string>(op.input.required ?? []);
  return Object.entries(op.input.properties).map(([name, schema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: toJsonSchema(schema),
  }));
}

function jsonBody(op: AnyOpContract): JsonSchema {
  return { required: true, content: { "application/json": { schema: toJsonSchema(op.input) } } };
}
