// Recorded GitLab, Gitea and Bitbucket answers for the git provider tests
// (test/fixtures/git-providers/*-api.json), served through the provider
// HTTP client's transport hook after its address check and pinning, so
// those run for real. Every request is kept for the tests to look at.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setProviderFetch } from "../src/modules/gitProviders/http";
import { setTargetResolver } from "../src/modules/uptime/targets";

const dir = join(import.meta.dir, "fixtures/git-providers");

export interface RecordedEntry {
  /** "GET /api/v4/user": method and URL-encoded path, without the query. */
  request: string;
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface SentRequest {
  method: string;
  /** The host the request was meant for (the Host header after pinning). */
  host: string;
  /** The address it connected to (the vetted one). */
  address: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: any;
}

export type Override = (
  request: SentRequest,
) => Response | { status?: number; body: unknown; headers?: Record<string, string> } | undefined;

export function payloadFixture(name: string): any {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
}

export function recorded(kind: "gitlab" | "gitea" | "bitbucket"): RecordedEntry[] {
  return JSON.parse(readFileSync(join(dir, `${kind}-api.json`), "utf8")) as RecordedEntry[];
}

/** The address every name resolves to in these tests (TEST-NET-3, public). */
export const fakeAddress = "203.0.113.10";

export class FakeProviders {
  readonly sent: SentRequest[] = [];
  /** Answers that win over the recorded ones, newest first. */
  readonly overrides: Override[] = [];
  private readonly entries: Map<string, RecordedEntry[]>;

  constructor(byHost: Record<string, RecordedEntry[]>) {
    this.entries = new Map(Object.entries(byHost));
  }

  install(): void {
    setTargetResolver(async () => [fakeAddress]);
    setProviderFetch(async (url, init) => this.answer(url, init));
  }

  uninstall(): void {
    setProviderFetch(null);
    setTargetResolver(null);
  }

  override(fn: Override): void {
    this.overrides.unshift(fn);
  }

  /** Requests to one host, as "METHOD /path". */
  calls(host?: string): string[] {
    return this.sent.filter((r) => !host || r.host === host).map((r) => `${r.method} ${r.path}`);
  }

  private async answer(url: string, init: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const request: SentRequest = {
      method: init.method ?? "GET",
      host: headers.host ?? parsed.host,
      address: parsed.hostname,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    };
    this.sent.push(request);
    for (const fn of this.overrides) {
      const out = fn(request);
      if (out instanceof Response) return out;
      if (out) return respond(out.status ?? 200, out.body, out.headers);
    }
    const entry = this.entries.get(request.host)?.find((e) => e.request === `${request.method} ${request.path}`);
    if (!entry) return respond(404, { message: `no recorded answer for ${request.method} ${request.host}${request.path}` });
    return respond(entry.status, entry.body, entry.headers);
  }
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  if (status === 204 || body === null) return new Response(null, { status: status === 200 ? 204 : status, headers });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
