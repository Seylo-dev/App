// Token-bucket rate limits per caller and class, kept in memory. One panel
// process serves everything, so there is nothing to share between
// instances; limits reset on restart, which is acceptable for their purpose
// (slowing brute force and runaway scripts).

import type { RateLimitClass } from "@seylo/ops";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitRule {
  /** Requests allowed in a burst. */
  burst: number;
  /** Tokens added back per second. */
  refillPerSecond: number;
}

export const defaultRules: Record<RateLimitClass, RateLimitRule> = {
  // Generous: the web app fires several queries per screen.
  standard: { burst: 120, refillPerSecond: 20 },
  // Sign-in and token checks: 10 tries, then one every 6 seconds.
  strict: { burst: 10, refillPerSecond: 1 / 6 },
};

export interface RateLimiter {
  /** Takes one token; returns the seconds to wait when none is left, or 0. */
  take(key: string, limitClass: RateLimitClass, now?: number): number;
  /** Gives back a token taken by `take` (never above the burst), for a request that turned out not to count. */
  refund(key: string, limitClass: RateLimitClass, now?: number): void;
}

export function createRateLimiter(rules = defaultRules, maxKeys = 50_000): RateLimiter {
  const buckets = new Map<string, Bucket>();

  /** The refilled bucket for a key, most recently used. */
  const bucketFor = (key: string, rule: RateLimitRule, limitClass: RateLimitClass, now: number) => {
    const id = `${limitClass}:${key}`;
    const bucket = buckets.get(id) ?? { tokens: rule.burst, updatedAt: now };
    bucket.tokens = Math.min(rule.burst, bucket.tokens + ((now - bucket.updatedAt) / 1000) * rule.refillPerSecond);
    bucket.updatedAt = now;

    // Re-insert so the map stays ordered by last use, then evict the least
    // recently used buckets to bound memory under a flood of new keys.
    buckets.delete(id);
    buckets.set(id, bucket);
    while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value as string);
    return bucket;
  };

  return {
    take(key, limitClass, now = Date.now()) {
      const rule = rules[limitClass];
      const bucket = bucketFor(key, rule, limitClass, now);
      if (bucket.tokens < 1) return Math.ceil((1 - bucket.tokens) / rule.refillPerSecond);
      bucket.tokens -= 1;
      return 0;
    },
    refund(key, limitClass, now = Date.now()) {
      const rule = rules[limitClass];
      const bucket = bucketFor(key, rule, limitClass, now);
      bucket.tokens = Math.min(rule.burst, bucket.tokens + 1);
    },
  };
}
