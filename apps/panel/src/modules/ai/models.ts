// Model tiers, their Anthropic ids and prices, routing between them, and
// cost accounting. Prices are US dollars per million tokens (first-party
// API, November 2026); cache writes cost 1.25x input. Ported in spirit
// from an earlier in-house implementation by the same authors.

import type { ai as aiOps } from "@seylo/ops";

export type Tier = aiOps.ModelTier;

export const modelIds: Record<Tier, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const prices: Record<Tier, Price> = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** How hard each tier thinks; Haiku answers lookups, Opus does the long multi-step work. */
export const effortFor: Record<Tier, "low" | "medium" | "high"> = { haiku: "low", sonnet: "medium", opus: "high" };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cost in millionths of a dollar, rounded up so the bill never undercounts. */
export function costMicroUsd(tier: Tier, usage: TokenUsage): number {
  const p = prices[tier];
  const dollars =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000;
  return Math.ceil(dollars * 1_000_000);
}

export interface Routing {
  mode: "auto" | "fixed";
  model: Tier;
  allowOpus: boolean;
}

const hardWork =
  /\b(migrat\w*|refactor\w*|architect\w*|investigat\w*|debug\w*|root cause|step by step|plan\b|design\b|why (is|does|did)|figure out|multiple|all (my|the) services)\b/i;
const quickLookup = /^(what|which|how many|list|show|is|are|does|when|where)\b/i;

/**
 * auto: short lookups go to Haiku, hard multi-step questions to Opus (when
 * allowed), everything else to Sonnet. fixed: always the chosen tier. A
 * tier forced for one message wins over both.
 */
export function routeModel(routing: Routing, message: string, forced?: Tier): Tier {
  if (forced) return forced === "opus" && routing.mode === "auto" && !routing.allowOpus ? "sonnet" : forced;
  if (routing.mode === "fixed") return routing.model;
  const text = message.trim();
  if (routing.allowOpus && (hardWork.test(text) || text.length > 1500)) return "opus";
  if (text.length <= 160 && quickLookup.test(text) && !hardWork.test(text)) return "haiku";
  return "sonnet";
}
