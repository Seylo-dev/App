// The MCP tool list and tool calls. Tools are the ops marked mcp: true
// (buildMcpTools); a token sees only the tools it could use (read-only
// tokens: queries only; narrowed tokens: their actions, and no account-wide
// ops). Calls run through
// the op pipeline with transport "mcp", so permissions, rate limits and
// audit apply; a destructive op becomes an approval for a person while
// "Ask before destructive actions" is on (keys.ts), and runs right away
// when it is off (the pipeline decides, ops/pipeline.ts).

import { type AnyOpContract, actionAllowed, allOps, OpError, redact } from "@seylo/ops";
import { buildMcpTools, type McpTool, mcpToolName } from "@seylo/ops/generators";
import { createAccess, isNarrowedKey } from "../../auth/access";
import type { Principal } from "../../auth/principal";
import type { Deps } from "../../deps";
import { parseInput } from "../../ops/validate";
import { requestApproval } from "../approvals/queue";

const mcpOps = allOps.filter((op) => op.mcp);
const opsByTool = new Map(mcpOps.map((op) => [mcpToolName(op.id), op]));
const allTools = buildMcpTools(allOps);

export function toolCounts() {
  return {
    total: allTools.length,
    readOnly: allTools.filter((tool) => tool.annotations.readOnlyHint).length,
    destructive: allTools.filter((tool) => tool.annotations.destructiveHint).length,
  };
}

/** Whether a token could ever use an op: kind and action list; resource checks happen on the call. */
function usable(principal: Extract<Principal, { type: "apiKey" }>, op: AnyOpContract): boolean {
  if (principal.readOnly && op.kind !== "query") return false;
  const p = op.permission;
  if (p.kind === "public") return true;
  // Account-wide ops are refused to tokens limited to projects or actions (auth/access.ts).
  if (p.kind === "signedIn") return !(p.account && isNarrowedKey(principal));
  if (!actionAllowed(principal.actions, p.action)) return false;
  // Project-limited keys never hold panel-wide actions.
  if (p.kind === "global" && principal.projectIds !== null) return false;
  // Members without the role cannot use global actions either.
  if (p.kind === "global" && principal.user.role === "member") return false;
  return true;
}

export function toolsFor(principal: Extract<Principal, { type: "apiKey" }>): McpTool[] {
  return allTools.filter((tool) => {
    const op = opsByTool.get(tool.name);
    return op ? usable(principal, op) : false;
  });
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

const text = (value: string, isError: boolean): ToolResult => ({ content: [{ type: "text", text: value }], isError });

export async function callTool(
  deps: Deps,
  call: {
    name: string;
    args: unknown;
    bearerToken: string;
    principal: Extract<Principal, { type: "apiKey" }>;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<ToolResult | null> {
  const op = opsByTool.get(call.name);
  if (!op) return null;
  const args = call.args ?? {};
  const outcome = await deps.ops.execute({
    op,
    rawInput: args,
    credentials: { bearerToken: call.bearerToken },
    transport: "mcp",
    coerce: false,
    ip: call.ip,
    userAgent: call.userAgent,
    http: null,
  });
  if (outcome.ok) {
    // Like the assistant and approvals: sensitive output fields (env values,
    // database passwords, file contents) never reach the model host.
    const output = redact(outcome.output, op.sensitive?.output);
    const structured =
      output !== null && typeof output === "object" && !Array.isArray(output) ? (output as Record<string, unknown>) : undefined;
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      ...(structured ? { structuredContent: structured } : {}),
      isError: false,
    };
  }
  if (outcome.error.code === "APPROVAL_REQUIRED") return askApproval(deps, op, args, call.principal);
  return text(`${outcome.error.code}: ${outcome.error.message}`, true);
}

/** The pipeline refused for lack of an approval, after validation and the permission check passed: queue it. */
function askApproval(deps: Deps, op: AnyOpContract, args: unknown, principal: Extract<Principal, { type: "apiKey" }>): ToolResult {
  let input: unknown;
  let target: ReturnType<ReturnType<typeof createAccess>["require"]>;
  try {
    input = parseInput(op.input, args, false);
    target = createAccess(deps.db, principal).require(op.permission, op.kind, input);
  } catch (error) {
    const message = error instanceof OpError ? `${error.code}: ${error.message}` : "INTERNAL: the request could not be queued.";
    return text(message, true);
  }
  const approval = requestApproval(deps, { op, input, principal, via: "mcp", requestedVia: principal.keyId, target });
  return text(
    `This action needs a person's approval before it runs. Approval ${approval.id} is waiting in the panel's Approvals page ` +
      `(it expires at ${approval.expiresAt.toISOString()}). Call approvals_get with {"approvalId":"${approval.id}"} to see whether it was approved and ran.`,
    true,
  );
}
