// One uptime probe: request the URL and decide up or down from the status
// code, an optional keyword in the body and an optional latency limit.
// Redirects are not followed, so a 301 counts as the answer it is.

import { slug } from "@seylo/brand";
import { pinRequest } from "../../http/pinned-fetch";
import { mayRequest } from "./targets";

export interface ProbeSettings {
  url: string;
  /** The address checkTarget vetted; the request goes there, never to a fresh DNS answer. */
  address?: string | null;
  /** checkTarget allowed resolving the name in the request itself (internal targets allowed). */
  byName?: boolean;
  method: "GET" | "HEAD";
  /** 0 accepts any 2xx or 3xx. */
  expectedStatus: number;
  timeoutMs: number;
  keyword: string | null;
  maxLatencyMs: number | null;
}

export interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  /** Why it failed, safe to show; null when ok. */
  error: string | null;
}

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Bodies are read up to this size when looking for the keyword. */
const maxBodyBytes = 1024 * 1024;

export async function probe(settings: ProbeSettings, doFetch: ProbeFetch = (url, init) => fetch(url, init)): Promise<ProbeResult> {
  // A hostname with no vetted address would be resolved again here, unchecked.
  if (!mayRequest(settings.url, settings))
    return { ok: false, statusCode: null, latencyMs: null, error: "Not checked: the name did not resolve" };
  const started = performance.now();
  let response: Response;
  try {
    const pinned = pinRequest(settings.url, settings.address);
    response = await doFetch(pinned.url, {
      method: settings.method,
      redirect: "manual",
      headers: { "user-agent": `${slug}-uptime`, accept: "*/*", ...pinned.headers },
      signal: AbortSignal.timeout(settings.timeoutMs),
      ...(pinned.tls ? { tls: pinned.tls } : {}),
    } as RequestInit);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      statusCode: null,
      latencyMs: timedOut ? settings.timeoutMs : null,
      error: timedOut ? `timeout after ${settings.timeoutMs} ms` : `could not connect: ${connectReason(error)}`,
    };
  }
  const latencyMs = Math.round(performance.now() - started);
  const statusCode = response.status;
  const statusOk = settings.expectedStatus === 0 ? statusCode >= 200 && statusCode < 400 : statusCode === settings.expectedStatus;

  let error: string | null = null;
  if (!statusOk) {
    error = settings.expectedStatus === 0 ? `status ${statusCode}` : `status ${statusCode}, expected ${settings.expectedStatus}`;
  } else if (settings.keyword && settings.method === "GET") {
    const body = await readCapped(response, maxBodyBytes).catch(() => null);
    if (body === null) error = "the body could not be read";
    // The keyword is not echoed: the check's last error must not read back what the page said.
    else if (!body.includes(settings.keyword)) error = "the keyword is not in the response";
  }
  if (error === null && settings.maxLatencyMs !== null && latencyMs > settings.maxLatencyMs) {
    error = `answered in ${latencyMs} ms, limit ${settings.maxLatencyMs} ms`;
  }
  if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
  return { ok: error === null, statusCode, latencyMs, error };
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

function connectReason(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND" || code === "DNSException") return "the name does not resolve";
  if (code && /CERT|TLS|SSL/i.test(code)) return "TLS certificate problem";
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 120);
}
