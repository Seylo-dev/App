// The AI assistant: Anthropic only, with routing between Haiku, Sonnet and
// Opus, a monthly budget, usage with a projected bill, and conversations.
// The assistant calls the same ops as MCP; anything that is not a query
// becomes an approval. Replies stream over the live socket: subscribe to
// the topic `ai:<conversationId>` (see aiLiveTopic) before sending, and
// apply the AiStreamEvent payloads it carries.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

/** Model tiers; the panel maps each to the current Anthropic model id. */
export const ModelTier = Type.Union([Type.Literal("haiku"), Type.Literal("sonnet"), Type.Literal("opus")]);
export type ModelTier = Static<typeof ModelTier>;

export const AiRouting = Type.Object({
  /** auto: Haiku for quick lookups, Sonnet by default, Opus for hard multi-step work. fixed: always `model`. */
  mode: Type.Union([Type.Literal("auto"), Type.Literal("fixed")]),
  /** Used when mode is fixed. */
  model: ModelTier,
  /** Lets auto routing pick Opus; off keeps the bill predictable. */
  allowOpus: Type.Boolean(),
});

export const AiSettings = Type.Object({
  enabled: Type.Boolean(),
  /** Whether an Anthropic API key is stored. The key itself is never returned. */
  keySet: Type.Boolean(),
  /** Last four characters of the stored key, for recognising it; empty when none. */
  keyHint: Type.String(),
  routing: AiRouting,
  /** Monthly limit in US dollars; requests stop once it is reached. Null means no limit. */
  monthlyBudgetUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  /** Members may use the assistant (it only ever acts with their own permissions). */
  allowMembers: Type.Boolean(),
});
export type AiSettings = Static<typeof AiSettings>;

export const settings = defineOp({
  id: "ai.settings",
  kind: "query",
  summary: "Get AI assistant settings",
  description: "Returns whether the assistant is on, whether a key is stored, the model routing and the monthly budget.",
  input: Empty,
  output: AiSettings,
  permission: permission.global("settings.view"),
  mcp: false,
  audit: false,
});

export const updateSettings = defineOp({
  id: "ai.updateSettings",
  kind: "mutation",
  summary: "Update AI assistant settings",
  description:
    "Changes the assistant settings. anthropicApiKey stores a new key (sealed; null removes it); omitted fields keep their value. The key is checked with a cheap request before it is saved.",
  input: Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    anthropicApiKey: Type.Optional(Type.Union([Type.String({ minLength: 20, maxLength: 256 }), Type.Null()])),
    routing: Type.Optional(AiRouting),
    monthlyBudgetUsd: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 100_000 }), Type.Null()])),
    allowMembers: Type.Optional(Type.Boolean()),
  }),
  output: AiSettings,
  permission: permission.global("settings.manage"),
  sensitive: { input: ["anthropicApiKey"] },
  mcp: false,
  audit: true,
});

const UsageRow = Type.Object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0 }),
  costUsd: Type.Number({ minimum: 0 }),
  requests: Type.Integer({ minimum: 0 }),
});

export const usage = defineOp({
  id: "ai.usage",
  kind: "query",
  summary: "Get AI usage and the projected bill",
  description:
    "Returns token use and cost for a month (default the current one, UTC) by model, by day and by person, the budget, and the bill projected from the pace so far.",
  input: Type.Object({ month: Type.Optional(Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description: "YYYY-MM" })) }),
  output: Type.Object({
    month: Type.String(),
    spentUsd: Type.Number({ minimum: 0 }),
    /** Spend so far divided by elapsed days times days in the month; equals spentUsd for past months. */
    projectedUsd: Type.Number({ minimum: 0 }),
    budgetUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    /** True once spentUsd reached the budget; the assistant refuses new requests until next month. */
    budgetReached: Type.Boolean(),
    byModel: Type.Array(Type.Composite([Type.Object({ model: ModelTier }), UsageRow])),
    byDay: Type.Array(Type.Object({ day: Type.String({ description: "YYYY-MM-DD" }), costUsd: Type.Number({ minimum: 0 }) })),
    byUser: Type.Array(Type.Object({ userId: Type.Union([Id, Type.Null()]), name: Type.String(), costUsd: Type.Number({ minimum: 0 }) })),
  }),
  permission: permission.global("settings.view"),
  mcp: false,
  audit: false,
});

// ---------------------------------------------------------------- conversations

export const ToolCallStatus = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("error"),
  /** A non-query op waiting in approvals. */
  Type.Literal("needs_approval"),
  Type.Literal("denied"),
]);

export const AiMessagePart = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({
    type: Type.Literal("tool_call"),
    toolCallId: Type.String(),
    opId: Type.String(),
    /** Redacted like the audit log. */
    input: Type.Unknown(),
    status: ToolCallStatus,
    approvalId: Type.Union([Id, Type.Null()]),
    /** Short redacted result or error text for the chat; the full output stays server side. */
    resultPreview: Type.Union([Type.String(), Type.Null()]),
  }),
]);
export type AiMessagePart = Static<typeof AiMessagePart>;

export const AiMessageStatus = Type.Union([
  Type.Literal("streaming"),
  Type.Literal("done"),
  Type.Literal("error"),
  Type.Literal("cancelled"),
]);

export const AiMessage = Type.Object({
  id: Id,
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  parts: Type.Array(AiMessagePart),
  /** Tier that wrote an assistant message; null for the person's messages. */
  model: Type.Union([ModelTier, Type.Null()]),
  status: AiMessageStatus,
  /** Safe error text when status is error. */
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: Timestamp,
});
export type AiMessage = Static<typeof AiMessage>;

export const AiContext = Type.Object({ projectId: Type.Optional(Id), serviceId: Type.Optional(Id) });

export const AiConversation = Type.Object({
  id: Id,
  title: Type.String(),
  context: AiContext,
  costUsd: Type.Number({ minimum: 0 }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const conversations = defineOp({
  id: "ai.conversations",
  kind: "query",
  summary: "List AI conversations",
  description: "Lists the caller's assistant conversations, most recently active first.",
  input: Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
    cursor: Type.Optional(Type.String({ maxLength: 64 })),
  }),
  output: Type.Object({ conversations: Type.Array(AiConversation), nextCursor: Type.Union([Type.String(), Type.Null()]) }),
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

export const conversation = defineOp({
  id: "ai.conversation",
  kind: "query",
  summary: "Get an AI conversation",
  description: "Returns one of the caller's conversations with all its messages.",
  input: Type.Object({ conversationId: Id }),
  output: Type.Object({ conversation: AiConversation, messages: Type.Array(AiMessage) }),
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

export const send = defineOp({
  id: "ai.send",
  kind: "mutation",
  summary: "Send a message to the AI assistant",
  description:
    "Adds the person's message (to a new conversation when conversationId is left out) and starts the assistant's reply. Returns at once; the reply streams on the live topic ai:<conversationId>. Fails with CONFLICT while a reply is still streaming and with FORBIDDEN once the monthly budget is reached.",
  input: Type.Object({
    conversationId: Type.Optional(Id),
    message: Type.String({ minLength: 1, maxLength: 20_000 }),
    /** Page the chat was opened from; only used when starting a conversation. */
    context: Type.Optional(AiContext),
    /** Force a tier for this reply instead of the routing setting. */
    model: Type.Optional(ModelTier),
  }),
  output: Type.Object({
    conversationId: Id,
    userMessage: AiMessage,
    /** Empty, status streaming; filled by the live events. */
    assistantMessage: AiMessage,
  }),
  permission: permission.signedIn(),
  rateLimit: "strict",
  mcp: false,
  audit: true,
});

export const cancel = defineOp({
  id: "ai.cancel",
  kind: "mutation",
  summary: "Stop the assistant's reply",
  description: "Stops the reply that is streaming in a conversation. Text so far is kept; the message ends with status cancelled.",
  input: Type.Object({ conversationId: Id }),
  output: Empty,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});

export const deleteConversation = defineOp({
  id: "ai.deleteConversation",
  kind: "destructive",
  summary: "Delete an AI conversation",
  description: "Deletes one of the caller's conversations and its messages. Usage records stay for the bill.",
  input: Type.Object({ conversationId: Id }),
  output: Empty,
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});

// ---------------------------------------------------------------- streaming

/** Live topic carrying a conversation's reply. Only the conversation's owner may subscribe. */
export function aiLiveTopic(conversationId: string): `ai:${string}` {
  return `ai:${conversationId}`;
}

/**
 * Events on `ai:<conversationId>`, in order, for one assistant message.
 * Apply them to the message from ai.send: "delta" appends text to the
 * part at `index` (creating a text part there when missing), "part" sets
 * the part at `index` (tool calls, and their later status changes),
 * "done" ends it. After a reconnect, refetch ai.conversation.
 */
export const AiStreamEvent = Type.Union([
  Type.Object({ type: Type.Literal("delta"), messageId: Id, index: Type.Integer({ minimum: 0 }), text: Type.String() }),
  Type.Object({ type: Type.Literal("part"), messageId: Id, index: Type.Integer({ minimum: 0 }), part: AiMessagePart }),
  Type.Object({
    type: Type.Literal("done"),
    messageId: Id,
    status: AiMessageStatus,
    error: Type.Union([Type.String(), Type.Null()]),
    model: Type.Union([ModelTier, Type.Null()]),
    costUsd: Type.Number({ minimum: 0 }),
  }),
  /** A new conversation got its title (after the first reply). */
  Type.Object({ type: Type.Literal("title"), conversationId: Id, title: Type.String() }),
]);
export type AiStreamEvent = Static<typeof AiStreamEvent>;
