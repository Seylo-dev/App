// A fake Docker Hub for the dockerHub tests: replays the recorded answers in
// fixtures/dockerhub (search, tags, gitea/gitea's index, manifests and
// configs, byte for byte) and serves one private repository, acme/private,
// whose content is made here. Every request is recorded with the headers it
// carried, so tests can check which host saw which token.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "fixtures", "dockerhub");
const file = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const text = (name: string) => readFileSync(join(dir, name), "utf8");

export const meta = JSON.parse(text("registry/meta.json")) as {
  repository: string;
  tag: string;
  indexDigest: string;
  amd64: { manifestDigest: string; configDigest: string };
  arm64: { manifestDigest: string; configDigest: string };
};

export const sha256 = (bytes: Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

/** acme/private:1, a single-platform image with a health check, made up here. */
export const privateImage = (() => {
  const config = encode({
    architecture: "amd64",
    os: "linux",
    created: "2026-10-01T10:00:00Z",
    config: {
      ExposedPorts: { "8080/tcp": {}, "9090/udp": {} },
      Env: ["PATH=/usr/bin", "API_TOKEN=", "APP_MODE=production"],
      Volumes: { "/srv/data": {} },
      User: "1000:1000",
      Healthcheck: { Test: ["CMD-SHELL", "wget -qO- localhost:8080/health"], Interval: 30e9, Timeout: 5e9, StartPeriod: 10e9, Retries: 3 },
      Labels: { "org.opencontainers.image.title": "private app" },
    },
  });
  const manifest = encode({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: { mediaType: "application/vnd.docker.container.image.v1+json", size: config.byteLength, digest: sha256(config) },
    layers: [],
  });
  return { config, configDigest: sha256(config), manifest, digest: sha256(manifest) };
})();

export interface Seen {
  method: string;
  url: URL;
  headers: Headers;
}

export interface FakeHubOptions {
  /** The Docker Hub login that auth.docker.io and hub.docker.com accept. */
  login?: { username: string; password: string };
  /** Answer 429 on these hosts (or "registry-get" for registry GETs only). */
  limited?: Set<string>;
  /** v4 search answers 404 (Docker Hub moved it). */
  searchV4Gone?: boolean;
}

export class FakeDockerHub {
  readonly seen: Seen[] = [];

  constructor(readonly options: FakeHubOptions = {}) {}

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    this.seen.push({ method, url, headers });
    if (init?.redirect !== "manual") throw new Error("the client must follow redirects by hand");
    if (this.options.limited?.has(url.hostname)) return limitedResponse(url.hostname);
    switch (url.hostname) {
      case "hub.docker.com":
        return this.hub(method, url, headers, init?.body);
      case "auth.docker.io":
        return this.auth(url, headers);
      case "registry-1.docker.io":
        return this.registry(method, url, headers);
      case "production.cloudflare.docker.com":
        return this.cdn(url);
      default:
        throw new Error(`unexpected host ${url.hostname}`);
    }
  };

  count(host: string, method?: string): number {
    return this.seen.filter((s) => s.url.hostname === host && (!method || s.method === method)).length;
  }

  private loginOk(username: string, password: string): boolean {
    return !!this.options.login && username === this.options.login.username && password === this.options.login.password;
  }

  private hub(method: string, url: URL, headers: Headers, body: unknown): Response {
    const path = url.pathname;
    if (method === "POST" && path === "/v2/auth/token") {
      const sent = JSON.parse(String(body)) as { identifier: string; secret: string };
      return this.loginOk(sent.identifier, sent.secret)
        ? json({ access_token: "hub-jwt-test" })
        : json({ message: "unauthorized", errinfo: {} }, 401);
    }
    if (path === "/api/search/v4") {
      if (this.options.searchV4Gone) return json({ message: "not found" }, 404);
      return url.searchParams.get("query") === "gitea" ? bytes(file("search-v4-gitea.json")) : json({ total: 0, results: [] });
    }
    if (path === "/v2/search/repositories/") return bytes(file("search-v2-nginx.json"));
    if (path === "/v2/namespaces/gitea/repositories/gitea/tags") return bytes(file("tags-gitea.json"));
    if (path === "/v2/namespaces/gitea/repositories/gitea/tags/latest") return bytes(file("tag-latest-gitea.json"));
    if (path === "/v2/namespaces/acme/repositories/private/tags") {
      if (headers.get("authorization") !== "Bearer hub-jwt-test") return json({ message: "object not found", errinfo: {} }, 404);
      return json({
        count: 1,
        next: null,
        results: [
          {
            name: "1",
            digest: privateImage.digest,
            tag_last_pushed: "2026-10-01T10:00:00Z",
            images: [{ os: "linux", architecture: "amd64", size: 1234, digest: privateImage.digest }],
          },
        ],
      });
    }
    return json({ message: "object not found", errinfo: {} }, 404);
  }

  private auth(url: URL, headers: Headers): Response {
    const scope = url.searchParams.get("scope") ?? "";
    const path = /^repository:(.+):pull$/.exec(scope)?.[1];
    if (url.pathname !== "/token" || url.searchParams.get("service") !== "registry.docker.io" || !path) return json({}, 400);
    const basic = headers.get("authorization");
    if (basic) {
      const [user, pass] = Buffer.from(basic.replace(/^Basic /, ""), "base64")
        .toString()
        .split(":");
      if (!this.loginOk(user ?? "", pass ?? "")) return json({ details: "incorrect username or password" }, 401);
      return json({ token: `login-token:${path}`, access_token: `login-token:${path}`, expires_in: 300 });
    }
    return json({ token: `anon-token:${path}`, access_token: `anon-token:${path}`, expires_in: 300 });
  }

  private registry(method: string, url: URL, headers: Headers): Response {
    const m = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(url.pathname);
    if (!m) return json({ errors: [{ code: "NAME_UNKNOWN" }] }, 404);
    const [, path, kind, ref] = m as unknown as [string, string, string, string];
    const auth = headers.get("authorization") ?? "";
    const isPrivate = path === "acme/private";
    const allowed = isPrivate
      ? auth === `Bearer login-token:${path}`
      : auth === `Bearer anon-token:${path}` || auth === `Bearer login-token:${path}`;
    if (!allowed) return json({ errors: [{ code: "UNAUTHORIZED" }] }, 401);
    if (method === "GET" && this.options.limited?.has("registry-get")) return limitedResponse("registry-1.docker.io");

    if (kind === "blobs") {
      const known = isPrivate ? [privateImage.configDigest] : [meta.amd64.configDigest, meta.arm64.configDigest];
      if (!known.includes(ref)) return json({ errors: [{ code: "BLOB_UNKNOWN" }] }, 404);
      const hex = ref.slice("sha256:".length);
      return new Response(null, {
        status: 307,
        headers: {
          location: `https://production.cloudflare.docker.com/registry-v2/docker/registry/v2/blobs/sha256/${hex.slice(0, 2)}/${hex}/data?verify=1`,
        },
      });
    }

    let body: Uint8Array | null = null;
    let type = "application/vnd.oci.image.manifest.v1+json";
    if (isPrivate) {
      if (ref === "1" || ref === privateImage.digest) {
        body = privateImage.manifest;
        type = "application/vnd.docker.distribution.manifest.v2+json";
      }
    } else if (ref === meta.tag || ref === meta.indexDigest) {
      body = file("registry/index.raw");
      type = "application/vnd.oci.image.index.v1+json";
    } else if (ref === meta.amd64.manifestDigest) body = file("registry/manifest-amd64.raw");
    else if (ref === meta.arm64.manifestDigest) body = file("registry/manifest-arm64.raw");
    if (!body) return json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, 404);
    const head = { "content-type": type, "docker-content-digest": sha256(body), "content-length": String(body.byteLength) };
    return new Response(method === "HEAD" ? null : body, { status: 200, headers: head });
  }

  private cdn(url: URL): Response {
    const hex = /\/sha256\/[0-9a-f]{2}\/([0-9a-f]{64})\/data$/.exec(url.pathname)?.[1];
    const digest = `sha256:${hex}`;
    if (digest === meta.amd64.configDigest) return bytes(file("registry/config-amd64.raw"));
    if (digest === meta.arm64.configDigest) return bytes(file("registry/config-arm64.raw"));
    if (digest === privateImage.configDigest) return bytes(privateImage.config);
    return new Response("not found", { status: 404 });
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function bytes(body: Uint8Array): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function limitedResponse(host: string): Response {
  if (host === "hub.docker.com") {
    return new Response(JSON.stringify({ message: "rate limited" }), {
      status: 429,
      headers: {
        "x-ratelimit-limit": "180",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 42),
      },
    });
  }
  return new Response(JSON.stringify({ errors: [{ code: "TOOMANYREQUESTS", message: "You have reached your pull rate limit." }] }), {
    status: 429,
    headers: { "retry-after": "600", "ratelimit-limit": "100;w=21600", "ratelimit-remaining": "0;w=21600" },
  });
}
