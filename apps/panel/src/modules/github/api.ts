// GitHub's REST API with whatever credential the caller has: the App's
// JWT, an installation token or a person's token. Conditional requests
// (ETag) answer 304 without counting against the rate limit.
// Ported from an earlier in-house implementation by the same authors.

import { displayName } from "@seylo/brand";

export const githubApi = "https://api.github.com";
const userAgent = `${displayName}-Panel`;
const timeoutMs = 20_000;

export class GithubApiError extends Error {
  override name = "GithubApiError";
  constructor(
    readonly status: number,
    message: string,
    /** GitHub refused for its rate limit (rateLimitedAnswer), not for what was asked. */
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

/**
 * Whether a 403 or 429 is GitHub's rate limit (the token's hourly requests
 * used up, or a secondary limit) rather than a permission: it sends
 * x-ratelimit-remaining: 0 or retry-after, or says so in the message. It
 * clears by itself, so it says nothing about the repository.
 */
export function rateLimitedAnswer(status: number, headers: Headers, message: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") || /rate limit/i.test(message);
}

export interface GithubResponse<T> {
  status: number;
  data: T;
  etag: string | null;
  link: string | null;
  scopes: string | null;
}

export interface GithubRequestOptions {
  auth?: string | null;
  method?: string;
  body?: unknown;
  etag?: string | null;
}

export async function githubRequest<T>(path: string, options: GithubRequestOptions = {}): Promise<GithubResponse<T>> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": userAgent,
  };
  if (options.auth) headers.authorization = `Bearer ${options.auth}`;
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(path.startsWith("http") ? path : `${githubApi}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const meta = { etag: response.headers.get("etag"), link: response.headers.get("link"), scopes: response.headers.get("x-oauth-scopes") };
  if (response.status === 304) return { status: 304, data: null as T, ...meta, etag: options.etag ?? meta.etag };
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = (data && typeof data === "object" && "message" in data ? String(data.message) : text) || response.statusText;
    throw new GithubApiError(
      response.status,
      `GitHub answered ${response.status}: ${message.slice(0, 300)}`,
      rateLimitedAnswer(response.status, response.headers, message),
    );
  }
  return { status: response.status, data: data as T, ...meta };
}

/** Every page of a list, up to maxPages of 100. */
export async function githubPages<T>(path: string, auth: string, pick: (page: unknown) => T[], maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  for (let page = 0; next && page < maxPages; page++) {
    const response: GithubResponse<unknown> = await githubRequest<unknown>(next, { auth });
    out.push(...pick(response.data));
    next = nextLink(response.link);
  }
  return out;
}

export function nextLink(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

export function describeGithubError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
