// HTTP to a git provider's API. Every request goes to the connection's own
// API base and nowhere else: the address is vetted (never a cloud metadata
// endpoint, never a name that does not resolve) and the request connects
// to exactly that address (no DNS rebinding), redirects are refused (a
// token never follows one to another host), answers are capped and time
// out. Private addresses are allowed: connections are made by admins, and
// a self-hosted Gitea on the same network is a normal setup.

import { displayName } from "@seylo/brand";
import type { Deps } from "../../deps";
import { pinRequest } from "../../http/pinned-fetch";
import { blockedMessage, checkTarget } from "../uptime/targets";

const timeoutMs = 20_000;
/** Largest answer read; repository lists and diffstats stay far below. */
const maxBodyBytes = 8 * 1024 * 1024;
const userAgent = `${displayName}-Panel`;

export class ProviderApiError extends Error {
  override name = "ProviderApiError";
  constructor(
    /** HTTP status, or 0 when no answer came. */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiTarget {
  /** "GitLab", "Gitea", "Bitbucket": for messages. */
  label: string;
  /** API base without a trailing slash, for example "https://gitlab.com/api/v4". */
  base: string;
  /** Authorization headers for the token. */
  auth: Record<string, string>;
}

export interface ApiRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Query parameters; undefined values are left out. */
  query?: Record<string, string | number | boolean | undefined>;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** Tests swap the transport (after vetting and pinning) for recorded answers. */
export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;
let transport: ProviderFetch = (url, init) => fetch(url, init);
export function setProviderFetch(next: ProviderFetch | null): void {
  transport = next ?? ((url, init) => fetch(url, init));
}

/** Builds the request URL; path segments must already be encoded by the caller. */
export function apiUrl(base: string, path: string, query: ApiRequest["query"] = {}): string {
  const url = new URL(`${base}${path}`);
  if (url.origin !== new URL(base).origin) throw new ProviderApiError(0, "The request left the provider's address.");
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.toString();
}

/**
 * One URL path segment. "." and ".." (also percent-encoded, which URL
 * parsing folds the same way) are refused: a repository or branch name must
 * never walk the request to another API endpoint with the token.
 */
export function encodeSegment(segment: string): string {
  if (segment === "" || /^(\.|%2e){1,2}$/i.test(segment)) throw new ProviderApiError(0, `"${segment}" is not a valid name.`);
  return encodeURIComponent(segment);
}

/** Encodes each segment of a repository path ("group/sub/project") for a URL path. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeSegment).join("/");
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBodyBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderApiError(response.status, "The provider's answer is too large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel().catch(() => {});
      throw new ProviderApiError(response.status, "The provider's answer is too large.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function errorMessage(data: unknown, text: string): string {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const nested = d.error && typeof d.error === "object" ? (d.error as Record<string, unknown>).message : undefined;
    const value = nested ?? d.message ?? d.error_description ?? d.error;
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return JSON.stringify(value);
  }
  return text;
}

/** One API request to the connection's provider. */
export async function apiRequest<T>(
  deps: Pick<Deps, "db">,
  target: ApiTarget,
  path: string,
  request: ApiRequest = {},
): Promise<ApiResponse<T>> {
  const url = apiUrl(target.base, path, request.query);
  const check = await checkTarget(deps, url, { allowInternal: false });
  let address: string;
  if (check.ok) address = check.address as string;
  else if (check.reason === "metadata" || check.reason === "unresolvable") throw new ProviderApiError(0, blockedMessage(check));
  else address = check.address;
  const pinned = pinRequest(url, address);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": userAgent,
    ...target.auth,
    ...pinned.headers,
  };
  if (request.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await transport(pinned.url, {
      method: request.method ?? "GET",
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(pinned.tls ? { tls: pinned.tls } : {}),
    } as RequestInit);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new ProviderApiError(
      0,
      name === "TimeoutError" || name === "AbortError"
        ? `${target.label} did not answer within ${timeoutMs / 1000} seconds.`
        : `Could not reach ${target.label} at ${new URL(target.base).host}.`,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderApiError(response.status, `${target.label} answered with a redirect; check the connection's address.`);
  }
  const text = await readCapped(response);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = errorMessage(data, text) || response.statusText;
    throw new ProviderApiError(response.status, `${target.label} answered ${response.status}: ${message.slice(0, 300)}`);
  }
  return { status: response.status, data: data as T, headers: response.headers };
}

export function describeProviderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
