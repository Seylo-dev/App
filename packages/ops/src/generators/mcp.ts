// MCP tool descriptors for every op marked `mcp: true`. The MCP server
// (apps/panel/src/modules/mcp) lists these and routes calls back through
// the same op pipeline, so permissions, rate limits and audit still apply.

import type { AnyOpContract } from "../define";
import { type JsonSchema, toJsonSchema } from "./json-schema";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    /** Queries can be retried freely; mutations might not be. */
    idempotentHint: boolean;
    /** Ops act on this panel and its nodes only. */
    openWorldHint: false;
  };
}

/** MCP tool names allow [A-Za-z0-9_-], so "projects.create" becomes "projects_create". */
export function mcpToolName(opId: string): string {
  return opId.replaceAll(".", "_");
}

export function buildMcpTools(ops: readonly AnyOpContract[]): McpTool[] {
  return ops
    .filter((op) => op.mcp)
    .map((op) => ({
      name: mcpToolName(op.id),
      title: op.summary,
      description: op.description,
      inputSchema: toJsonSchema(op.input),
      outputSchema: toJsonSchema(op.output),
      annotations: {
        readOnlyHint: op.kind === "query",
        destructiveHint: op.kind === "destructive",
        idempotentHint: op.kind === "query",
        openWorldHint: false,
      },
    }));
}
