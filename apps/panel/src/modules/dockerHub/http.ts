// Every request of the Docker Hub client goes through hubFetch: HTTPS only,
// only to Docker Hub's own hosts, redirects followed by hand (blobs move to
// Docker's CDN) and only to those hosts, the Authorization header never
// carried to another host, a timeout and a cap on the body size.

export const dockerHubHosts: ReadonlySet<string> = new Set([
  // Search, tags and the Hub API's own login.
  "hub.docker.com",
  // Registry tokens.
  "auth.docker.io",
  // Manifests and blobs.
  "registry-1.docker.io",
  // Where registry-1 redirects blob downloads (signed URLs), depending on
  // where the panel is: Docker's two CDNs and its R2 bucket.
  "production.cloudflare.docker.com",
  "production.cloudfront.docker.com",
  "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
]);

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface HubResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** The URL that answered, after redirects. */
  url: string;
}

export class HostNotAllowedError extends Error {
  override name = "HostNotAllowedError";
}

export class BodyTooLargeError extends Error {
  override name = "BodyTooLargeError";
}

const maxRedirects = 3;

function allowedUrl(raw: string, base?: string): URL {
  const url = new URL(raw, base);
  if (url.protocol !== "https:" || !dockerHubHosts.has(url.hostname) || url.port !== "" || url.username || url.password) {
    throw new HostNotAllowedError(`refusing to contact ${url.protocol}//${url.host}`);
  }
  return url;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new BodyTooLargeError(`answer larger than ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(`answer larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function hubFetch(
  fetchImpl: Fetch,
  rawUrl: string,
  options: { method?: "GET" | "HEAD" | "POST"; headers?: Record<string, string>; body?: string; maxBytes: number; timeoutMs: number },
): Promise<HubResponse> {
  let url = allowedUrl(rawUrl);
  const origin = url.host;
  const signal = AbortSignal.timeout(options.timeoutMs);
  for (let hop = 0; ; hop++) {
    const headers = { ...options.headers };
    // A token is for the host it was made for; the CDN gets a signed URL instead.
    if (url.host !== origin) delete headers.authorization;
    const response = await fetchImpl(url.toString(), {
      method: hop === 0 ? (options.method ?? "GET") : "GET",
      headers,
      ...(hop === 0 && options.body !== undefined ? { body: options.body } : {}),
      redirect: "manual",
      signal,
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (hop >= maxRedirects) throw new HostNotAllowedError("too many redirects");
      url = allowedUrl(location, url.toString());
      continue;
    }
    const body = options.method === "HEAD" ? new Uint8Array() : await readCapped(response, options.maxBytes);
    if (options.method === "HEAD") await response.body?.cancel();
    return { status: response.status, headers: response.headers, body, url: url.toString() };
  }
}

export function jsonOf(response: HubResponse): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return null;
  }
}

/** "sha256:<hex>" of a body, to check registry content against the digest it was asked for. */
export function sha256Digest(body: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`;
}
