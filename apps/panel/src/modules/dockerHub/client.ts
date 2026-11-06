// The panel's Docker Hub client: search and tags from hub.docker.com, image
// configs from the registry (registry-1.docker.io with tokens from
// auth.docker.io). Answers are cached in memory (search 10 minutes, tags 30
// minutes, configs by digest for a week) and rate limits are kept: after a
// 429 the client answers RATE_LIMITED itself until the limit resets
// instead of asking again.
//
// The saved Docker Hub login (registries module) is used in two ways:
// - for public images it pulls manifests with the login's token, so
//   inspecting spends the account's higher pull limit, not the panel
//   address's anonymous one. "Public" is proven first with an anonymous
//   HEAD, which Docker Hub does not count;
// - private repositories of that account are only read for callers who
//   may manage registries (`privateAccess`), never for others, and those
//   answers are cached apart from the public ones.

import { OpError } from "@seylo/ops";
import { TtlCache } from "./cache";
import { type Fetch, type HubResponse, hubFetch, jsonOf, sha256Digest } from "./http";
import {
  displayRepository,
  hasVersionTag,
  manifestAccept,
  type ParsedConfig,
  parseConfig,
  parseManifest,
  parseSearchV2,
  parseSearchV4,
  parseTag,
  parseTags,
  pickPlatform,
  repositoryPath,
  type SearchResult,
  suggestTag,
  type TagInfo,
} from "./parse";

export interface HubLogin {
  /** registry_credentials.id, for cache keys. */
  id: string;
  username: string;
  password: string;
}

export interface CallerAccess {
  /** The saved Docker Hub login, or null. */
  login: HubLogin | null;
  /** May read the login's private repositories (registries.manage). */
  privateAccess: boolean;
}

export interface SearchPage {
  results: SearchResult[];
  page: number;
  hasMore: boolean;
}

export interface TagsPage {
  tags: TagInfo[];
  suggested: string | null;
  page: number;
  hasMore: boolean;
}

export interface InspectResult extends ParsedConfig {
  repository: string;
  tag: string;
  digest: string;
  platforms: string[];
  private: boolean;
}

export interface ClientOptions {
  fetch?: Fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Logs a line without secrets (a refused login, a fallback). */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

const minute = 60_000;
const searchPageSize = 25;
const tagsPageSize = 100;
const maxJsonBytes = 4 * 1024 * 1024;
const maxManifestBytes = 1024 * 1024;
const maxConfigBytes = 8 * 1024 * 1024;
const hubBase = "https://hub.docker.com";
const registryBase = "https://registry-1.docker.io";
const authBase = "https://auth.docker.io";

/** What a 429 blocks: the Hub API and token server, registry HEADs (free, but limited too), or pulls by whose limit. */
type Limited = "hub" | "head" | "pulls" | "loginPulls";

export class DockerHubClient {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly warn: NonNullable<ClientOptions["warn"]>;

  private readonly searches: TtlCache<SearchPage>;
  private readonly tagPages: TtlCache<TagsPage>;
  private readonly singleTags: TtlCache<TagInfo | null>;
  /** "<path>@<digest>/<arch>" -> the platform manifest's config digest and the tag's platforms. */
  private readonly resolved: TtlCache<{ configDigest: string; platforms: string[] }>;
  /** Config digest -> parsed config. Content-addressed, so it never goes stale. */
  private readonly configs: TtlCache<ParsedConfig>;
  private readonly tokens: TtlCache<string>;
  private readonly hubJwts: TtlCache<string>;
  /** Logins a token endpoint refused lately, so a wrong password is not retried on every call. */
  private readonly refusedLogins: TtlCache<true>;
  private readonly blockedUntil = new Map<Limited, number>();

  constructor(options: ClientOptions = {}) {
    // Looked up per call so tests can swap globalThis.fetch.
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.warn = options.warn ?? (() => {});
    this.searches = new TtlCache(10 * minute, 200, this.now);
    this.tagPages = new TtlCache(30 * minute, 300, this.now);
    this.singleTags = new TtlCache(30 * minute, 300, this.now);
    this.resolved = new TtlCache(7 * 24 * 60 * minute, 1000, this.now);
    this.configs = new TtlCache(7 * 24 * 60 * minute, 500, this.now);
    this.tokens = new TtlCache(4 * minute, 500, this.now);
    this.hubJwts = new TtlCache(10 * minute, 20, this.now);
    this.refusedLogins = new TtlCache(5 * minute, 20, this.now);
  }

  // Search.

  async search(query: string, page: number): Promise<SearchPage> {
    const q = query.trim().toLowerCase();
    const key = `${q}|${page}`;
    const cached = this.searches.get(key);
    if (cached) return cached;
    const from = (page - 1) * searchPageSize;
    const v4 = await this.hub(`/api/search/v4?query=${encodeURIComponent(q)}&from=${from}&size=${searchPageSize}`);
    let result: SearchPage | null = null;
    if (v4.status === 200) {
      const parsed = parseSearchV4(jsonOf(v4));
      if (parsed) result = { results: parsed.results, page, hasMore: from + searchPageSize < parsed.total };
    }
    if (!result) {
      // The website's search moved before; the older endpoint has fewer details but the same results.
      this.warn("docker hub search v4 failed, using v2", { status: v4.status });
      const v2 = await this.hub(`/v2/search/repositories/?query=${encodeURIComponent(q)}&page=${page}&page_size=${searchPageSize}`);
      const parsed = v2.status === 200 ? parseSearchV2(jsonOf(v2)) : null;
      if (!parsed) throw unavailable(`Docker Hub's search answered ${v2.status}.`);
      result = { results: parsed.results, page, hasMore: parsed.hasMore };
    }
    this.searches.set(key, result);
    return result;
  }

  // Tags.

  async tags(repository: string, options: { page: number; filter?: string; access: CallerAccess }): Promise<TagsPage> {
    const { path, namespace, name } = repositoryPath(repository);
    const filter = options.filter?.trim() ?? "";
    const base = `/v2/namespaces/${namespace}/repositories/${name}/tags`;
    const query = `?page=${options.page}&page_size=${tagsPageSize}&ordering=last_updated${filter ? `&name=${encodeURIComponent(filter)}` : ""}`;
    const publicKey = `public|${path}|${options.page}|${filter}`;
    const cached = this.tagPages.get(publicKey);
    if (cached) return cached;
    const privateKey = options.access.login ? `login:${options.access.login.id}|${path}|${options.page}|${filter}` : null;
    if (options.access.privateAccess && privateKey) {
      const own = this.tagPages.get(privateKey);
      if (own) return own;
    }

    let jwt: string | null = null;
    let response = await this.hub(base + query);
    if (response.status === 404 || response.status === 401 || response.status === 403) {
      jwt = options.access.privateAccess && options.access.login ? await this.hubJwt(options.access.login) : null;
      if (!jwt) throw notFound(repository);
      response = await this.hub(base + query, jwt);
      if (response.status === 404 || response.status === 401 || response.status === 403) throw notFound(repository);
    }
    const parsed = response.status === 200 ? parseTags(jsonOf(response)) : null;
    if (!parsed) throw unavailable(`Docker Hub answered ${response.status} for ${repository}'s tags.`);

    let latest = parsed.tags.find((t) => t.name === "latest") ?? null;
    let pool = parsed.tags;
    if (options.page === 1 && !filter) {
      if (!latest) latest = await this.singleTag(`${base}/latest`, path, jwt);
      // Busy repositories push dozens of variant tags per release; the plain version may sit on the next page.
      if (latest?.digest && parsed.hasMore && !hasVersionTag(pool, latest.digest))
        pool = [...pool, ...(await this.nextTags(base, query, jwt))];
    }
    const result: TagsPage = { tags: parsed.tags, suggested: suggestTag(pool, latest), page: options.page, hasMore: parsed.hasMore };
    this.tagPages.set(jwt && privateKey ? privateKey : publicKey, result);
    return result;
  }

  /** Page 2 of the tags, only to find the version tag to suggest; nothing when it fails. */
  private async nextTags(base: string, query: string, jwt: string | null): Promise<TagInfo[]> {
    try {
      const response = await this.hub(base + query.replace("page=1&", "page=2&"), jwt ?? undefined);
      return (response.status === 200 ? parseTags(jsonOf(response))?.tags : null) ?? [];
    } catch {
      return [];
    }
  }

  private async singleTag(url: string, path: string, jwt: string | null): Promise<TagInfo | null> {
    const key = `${jwt ? "login" : "public"}|${path}`;
    const cached = this.singleTags.get(key);
    if (cached !== undefined) return cached;
    const response = await this.hub(url, jwt ?? undefined);
    const body = response.status === 200 ? jsonOf(response) : null;
    const tag = body && typeof body === "object" ? parseTag(body as Record<string, unknown>) : null;
    if (response.status === 200 || response.status === 404) this.singleTags.set(key, tag);
    return tag;
  }

  // Image configs.

  async inspect(repository: string, tag: string, arch: "amd64" | "arm64", access: CallerAccess): Promise<InspectResult> {
    const { path } = repositoryPath(repository);
    // An anonymous HEAD costs nothing and proves the image is public.
    let isPrivate = false;
    let usingLogin = false;
    let token = await this.registryToken(path, null);
    let head = await this.registry("HEAD", `/v2/${path}/manifests/${tag}`, token, "head");
    if (head.status === 401 || head.status === 404) {
      const login = access.privateAccess ? access.login : null;
      const own = login ? await this.registryToken(path, login) : null;
      if (!own) throw notFoundTag(repository, tag);
      head = await this.registry("HEAD", `/v2/${path}/manifests/${tag}`, own, "head");
      if (head.status === 401 || head.status === 404) throw notFoundTag(repository, tag);
      token = own;
      isPrivate = true;
      usingLogin = true;
    } else if (head.status === 200 && access.login) {
      // Public: pull with the login's token so its limit is spent, not the address's.
      const own = await this.registryToken(path, access.login);
      if (own) {
        token = own;
        usingLogin = true;
      }
    }
    if (head.status !== 200) throw unavailable(`Docker Hub's registry answered ${head.status} for ${repository}:${tag}.`);
    const digest = head.headers.get("docker-content-digest") ?? "";
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw unavailable("Docker Hub's registry did not say which image the tag points at.");
    const limit: Limited = usingLogin ? "loginPulls" : "pulls";

    const key = `${path}@${digest}/${arch}`;
    let resolved = this.resolved.get(key);
    if (!resolved) {
      const top = await this.manifest(path, digest, token, limit);
      if (top.kind === "index") {
        const platforms = [...new Set(top.entries.flatMap((e) => (e.platform ? [e.platform] : [])))];
        const picked = pickPlatform(top.entries, arch);
        if (!picked) {
          throw new OpError(
            "BAD_REQUEST",
            `${repository}:${tag} has no linux/amd64 or linux/arm64 image${platforms.length ? ` (it has ${platforms.join(", ")})` : ""}.`,
            { reason: "platform" },
          );
        }
        const image = await this.manifest(path, picked.digest, token, limit);
        if (image.kind !== "image") throw unavailable(`${repository}:${tag} has a manifest this panel cannot read.`);
        resolved = { configDigest: image.configDigest, platforms };
      } else if (top.kind === "image") {
        resolved = { configDigest: top.configDigest, platforms: [] };
      } else {
        throw new OpError("BAD_REQUEST", `${repository}:${tag} uses an old manifest format this panel cannot read.`, {
          reason: "manifest",
        });
      }
      this.resolved.set(key, resolved);
    }

    let config = this.configs.get(resolved.configDigest);
    if (!config) {
      const blob = await this.registry("GET", `/v2/${path}/blobs/${resolved.configDigest}`, token, limit, maxConfigBytes);
      if (blob.status !== 200) throw unavailable(`Docker Hub's registry answered ${blob.status} for the image config.`);
      if (sha256Digest(blob.body) !== resolved.configDigest) throw unavailable("The image config did not match its digest.");
      const parsed = parseConfig(jsonOf(blob));
      if (!parsed) throw unavailable("The image config could not be read.");
      config = parsed;
      this.configs.set(resolved.configDigest, config);
    }
    const platforms = resolved.platforms.length > 0 ? resolved.platforms : [config.platform];
    return { ...config, repository: displayRepository(path), tag, digest, platforms, private: isPrivate };
  }

  private async manifest(path: string, digest: string, token: string | null, limit: Limited): Promise<ReturnType<typeof parseManifest>> {
    const response = await this.registry("GET", `/v2/${path}/manifests/${digest}`, token, limit, maxManifestBytes);
    if (response.status !== 200) throw unavailable(`Docker Hub's registry answered ${response.status} for a manifest.`);
    if (sha256Digest(response.body) !== digest) throw unavailable("A manifest did not match its digest.");
    return parseManifest(jsonOf(response), response.headers.get("content-type") ?? "");
  }

  // Transport.

  private async hub(pathAndQuery: string, jwt?: string): Promise<HubResponse> {
    this.assertNotBlocked("hub");
    const response = await this.send(`${hubBase}${pathAndQuery}`, {
      headers: { accept: "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
      maxBytes: maxJsonBytes,
    });
    if (response.status === 429) this.block("hub", response);
    return response;
  }

  private async registry(
    method: "GET" | "HEAD",
    path: string,
    token: string | null,
    limit: Limited,
    maxBytes = maxJsonBytes,
  ): Promise<HubResponse> {
    this.assertNotBlocked(limit);
    const response = await this.send(`${registryBase}${path}`, {
      method,
      headers: { accept: manifestAccept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      maxBytes,
    });
    if (response.status === 429) this.block(limit, response);
    return response;
  }

  /** A pull token for one repository; with a login, null when Docker Hub refuses it. */
  private async registryToken(path: string, login: HubLogin | null): Promise<string | null> {
    const key = `${login ? `login:${login.id}` : "anonymous"}|${path}`;
    const cached = this.tokens.get(key);
    if (cached) return cached;
    if (login && this.refusedLogins.get(login.id)) return null;
    const url = `${authBase}/token?service=registry.docker.io&scope=${encodeURIComponent(`repository:${path}:pull`)}`;
    const response = await this.send(url, {
      headers: login ? { authorization: `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}` } : {},
      maxBytes: 64 * 1024,
    });
    if (response.status === 401 && login) {
      this.refusedLogins.set(login.id, true);
      this.warn("docker hub refused the saved registry login; continuing without it", { registryId: login.id });
      return null;
    }
    if (response.status === 429) this.block("hub", response);
    const body = jsonOf(response) as { token?: unknown; access_token?: unknown; expires_in?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token : typeof body?.access_token === "string" ? body.access_token : null;
    if (response.status !== 200 || !token) throw unavailable(`Docker Hub's login server answered ${response.status}.`);
    const lifetime = typeof body?.expires_in === "number" ? body.expires_in * 1000 : 5 * minute;
    this.tokens.set(key, token, Math.max(10_000, Math.min(lifetime - 30_000, 30 * minute)));
    return token;
  }

  /** A Hub API token for the saved login (private repositories' tags); null when refused. */
  private async hubJwt(login: HubLogin): Promise<string | null> {
    const cached = this.hubJwts.get(login.id);
    if (cached) return cached;
    if (this.refusedLogins.get(login.id)) return null;
    this.assertNotBlocked("hub");
    const response = await this.send(`${hubBase}/v2/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ identifier: login.username, secret: login.password }),
      maxBytes: 64 * 1024,
    });
    if (response.status === 429) this.block("hub", response);
    const token = (jsonOf(response) as { access_token?: unknown } | null)?.access_token;
    if (response.status !== 200 || typeof token !== "string") {
      this.refusedLogins.set(login.id, true);
      this.warn("docker hub refused the saved registry login for the Hub API", { registryId: login.id, status: response.status });
      return null;
    }
    this.hubJwts.set(login.id, token);
    return token;
  }

  private async send(
    url: string,
    options: { method?: "GET" | "HEAD" | "POST"; headers?: Record<string, string>; body?: string; maxBytes: number },
  ): Promise<HubResponse> {
    try {
      return await hubFetch(this.fetch, url, { ...options, timeoutMs: this.timeoutMs });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      if (name !== "TimeoutError") this.warn("docker hub request failed", { host: new URL(url).host, error: name });
      throw unavailable(`Could not reach Docker Hub: ${name === "TimeoutError" ? "it did not answer in time" : "the request failed"}.`);
    }
  }

  private assertNotBlocked(limit: Limited): void {
    const until = this.blockedUntil.get(limit) ?? 0;
    const left = Math.ceil((until - this.now()) / 1000);
    if (left > 0) throw rateLimited(limit, left);
  }

  private block(limit: Limited, response: HubResponse): never {
    const seconds = retryAfterSeconds(response.headers, this.now());
    this.blockedUntil.set(limit, this.now() + seconds * 1000);
    throw rateLimited(limit, seconds);
  }
}

/** Seconds until a 429 lifts: Retry-After, else X-RateLimit-Reset (Unix seconds), else a minute. */
export function retryAfterSeconds(headers: Headers, now: number): number {
  const retryAfter = Number(headers.get("retry-after") ?? "");
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(Math.ceil(retryAfter), 6 * 3600);
  const reset = Number(headers.get("x-ratelimit-reset") ?? "");
  if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(1, Math.ceil(reset - now / 1000)), 6 * 3600);
  return 60;
}

function rateLimited(limit: Limited, seconds: number): OpError {
  const wait = seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
  const message =
    limit === "pulls"
      ? `Docker Hub's anonymous pull limit for this panel's address is used up. Try again in ${wait}, or add a Docker Hub login under registries for a higher limit.`
      : limit === "loginPulls"
        ? `The Docker Hub login's pull limit is used up. Try again in ${wait}.`
        : `Docker Hub is limiting requests from this panel. Try again in ${wait}.`;
  return new OpError("RATE_LIMITED", message, { reason: "dockerHubRateLimit", retryAfterSeconds: String(seconds) });
}

function unavailable(message: string): OpError {
  return new OpError("UNAVAILABLE", message, { reason: "dockerHub" });
}

function notFound(repository: string): OpError {
  return new OpError("NOT_FOUND", `There is no public repository ${repository} on Docker Hub.`, { field: "repository" });
}

function notFoundTag(repository: string, tag: string): OpError {
  return new OpError("NOT_FOUND", `There is no public image ${repository}:${tag} on Docker Hub.`, { field: "tag" });
}
