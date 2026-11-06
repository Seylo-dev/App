// Tool definitions for the AI assistant (Anthropic Messages API format).
// The assistant sees the same ops as MCP. Anything that is not a query
// needs a person to approve it before it runs.

import type { AnyOpContract } from "../define";
import { type JsonSchema, toJsonSchema } from "./json-schema";
import { mcpToolName } from "./mcp";

export interface AiTool {
  /** Tool name sent to the model. */
  name: string;
  description: string;
  input_schema: JsonSchema;
  /** Not sent to the model: the assistant loop pauses for approval when true. */
  needsApproval: boolean;
  /** The op a tool call runs, through the normal op pipeline. */
  opId: string;
}

export function buildAiTools(ops: readonly AnyOpContract[]): AiTool[] {
  return ops
    .filter((op) => op.mcp)
    .map((op) => ({
      name: mcpToolName(op.id),
      description: `${op.summary}. ${op.description}`,
      input_schema: toJsonSchema(op.input),
      needsApproval: op.kind !== "query",
      opId: op.id,
    }));
}
