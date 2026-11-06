// Typed fetch client for the op API, used by the web app (through
// ./react.ts) and by scripts. Types come straight from the contracts, so a
// renamed field fails to compile instead of failing at runtime.

import type { AnyOpContract, OpInput, OpOutput } from "../define";
import { type ErrorBody, isOpErrorCode, OpError } from "../errors";
import { opRoute } from "../registry";

export interface OpClientOptions {
  /** Origin of the panel; empty for same-origin requests from the web app. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Extra headers, for example an Authorization header for API keys. */
  headers?: Record<string, string>;
}

export interface OpClient {
  call<C extends AnyOpContract>(op: C, input: OpInput<C>, init?: { signal?: AbortSignal }): Promise<OpOutput<C>>;
}

export function createOpClient(options: OpClientOptions = {}): OpClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    async call(op, input, init) {
      const { method, path } = opRoute(op);
      const url = new URL(baseUrl + path, baseUrl === "" ? globalThis.location?.origin : undefined);
      const request: RequestInit = {
        method,
        credentials: "same-origin",
        headers: { accept: "application/json", ...options.headers },
        signal: init?.signal,
      };
      if (method === "GET") {
        for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
          if (value !== undefined) url.searchParams.set(key, String(value));
        }
      } else {
        request.headers = { ...request.headers, "content-type": "application/json" };
        request.body = JSON.stringify(input);
      }

      let response: Response;
      try {
        response = await doFetch(url, request);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        throw new OpError("UNAVAILABLE", "The panel could not be reached.");
      }
      if (response.ok) return (await response.json()) as OpOutput<typeof op>;
      throw await errorFrom(response);
    },
  };
}

async function errorFrom(response: Response): Promise<OpError> {
  try {
    const body = (await response.json()) as Partial<ErrorBody>;
    const error = body.error;
    if (error && isOpErrorCode(error.code)) return new OpError(error.code, error.message, error.details);
  } catch {
    // Not our JSON error body (a proxy page, for example); fall through.
  }
  return new OpError(response.status >= 500 ? "UNAVAILABLE" : "INTERNAL", `Unexpected response (HTTP ${response.status}).`);
}
