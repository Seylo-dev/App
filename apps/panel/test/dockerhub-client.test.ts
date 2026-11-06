// The Docker Hub client against recorded answers (fixtures/dockerhub): no
// network. Covers parsing, ranking, the suggested tag, caching, rate
// limits, the saved login (public pulls and private repositories), the host
// allowlist and digest checks.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpError } from "@seylo/ops";
import { type CallerAccess, DockerHubClient, retryAfterSeconds } from "../src/modules/dockerHub/client";
import { type Fetch, HostNotAllowedError, hubFetch } from "../src/modules/dockerHub/http";
import {
  configBudget,
  parseConfig,
  parsePullCount,
  parseSearchV2,
  parseSearchV4,
  parseTags,
  pickPlatform,
  rankResults,
  repositoryPath,
  suggestTag,
} from "../src/modules/dockerHub/parse";
import { FakeDockerHub, meta, privateImage } from "./dockerhub-fake";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "dockerhub", name), "utf8"));
const anonymous: CallerAccess = { login: null, privateAccess: false };
const login = { id: "reg0000000000001", username: "acme", password: "dckr_pat_test" };

function setup(options: ConstructorParameters<typeof FakeDockerHub>[0] = {}, wrap?: (hub: FakeDockerHub) => Fetch) {
  const hub = new FakeDockerHub(options);
  let now = Date.now();
  const warnings: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const client = new DockerHubClient({
    fetch: wrap ? wrap(hub) : hub.fetch,
    now: () => now,
    warn: (message, fields) => {
      warnings.push(message);
      logged.push(fields ?? {});
    },
  });
  return { hub, client, warnings, logged, advance: (ms: number) => (now += ms) };
}

async function opError(promise: Promise<unknown>): Promise<OpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpError) return error;
    throw error;
  }
  throw new Error("expected an OpError");
}

describe("parsing Docker Hub answers", () => {
  test("v4 search keeps images only; exact names lead, then official and verified", () => {
    const parsed = parseSearchV4(fixture("search-v4-gitea.json"), "gitea");
    const names = parsed?.results.map((r) => r.repository) ?? [];
    // Hardened images (dhi/*) live in another registry and are left out.
    expect(names).not.toContain("dhi/gitea");
    // Every */gitea, most pulled first (the project's own image), then the rest in Docker Hub's order.
    expect(names.slice(0, 5)).toEqual(["gitea/gitea", "bitnamicharts/gitea", "vulhub/gitea", "sbx/gitea", "hkube/gitea"]);
    expect(names.slice(5)).toEqual(["gitea/act_runner", "gitea/runner", "gitea/runner-images", "gitea/test-openldap"]);
    const gitea = parsed?.results.find((r) => r.repository === "gitea/gitea");
    expect(gitea).toMatchObject({ publisher: "gitea", badge: "none" });
    expect(gitea?.pullCount).toBeGreaterThan(300_000_000);
    expect(gitea?.architectures).toEqual(expect.arrayContaining(["amd64", "arm64"]));
    expect(gitea?.architectures).not.toContain("unknown");
    expect(parsed?.total).toBeGreaterThan(10);
    // Without an exact name, official and verified publishers come first.
    const loose = parseSearchV4(fixture("search-v4-gitea.json"), "git server");
    expect(loose?.results.slice(0, 2).map((r) => r.badge)).toEqual(["verified", "verified"]);
  });

  test("ranking tiers: exact official, exact by pulls, official, verified, the rest", () => {
    const r = (repository: string, badge: "official" | "verified" | "openSource" | "none", pullCount: number) => ({
      repository,
      badge,
      pullCount,
      publisher: "",
      description: "",
      stars: 0,
      updatedAt: null,
      architectures: [],
    });
    const ranked = rankResults(
      [
        r("acme/other", "none", 9),
        r("kumahq/kuma", "verified", 5),
        r("vendor/uptime-kuma", "verified", 10),
        r("louislam/uptime-kuma", "none", 100),
      ],
      "Uptime Kuma",
    );
    expect(ranked.map((x) => x.repository)).toEqual(["louislam/uptime-kuma", "vendor/uptime-kuma", "kumahq/kuma", "acme/other"]);
    expect(rankResults([r("nginx/nginx", "verified", 1), r("nginx", "official", 1)], "nginx").map((x) => x.repository)).toEqual([
      "nginx",
      "nginx/nginx",
    ]);
  });

  test("v2 search maps official images to the Docker publisher", () => {
    const parsed = parseSearchV2(fixture("search-v2-nginx.json"), "nginx");
    expect(parsed?.results[0]).toMatchObject({ repository: "nginx", badge: "official", publisher: "Docker" });
    expect(parsed?.results[1]?.repository).toBe("nginx/nginx-ingress");
    expect(parsed?.hasMore).toBe(true);
  });

  test("pull counts like 1B+ and 4.2K", () => {
    expect(parsePullCount("1B+")).toBe(1_000_000_000);
    expect(parsePullCount("4.2K")).toBe(4200);
    expect(parsePullCount("8685")).toBe(8685);
    expect(parsePullCount(12)).toBe(12);
    expect(parsePullCount("lots")).toBe(0);
  });

  test("tags carry Linux platforms only, and the suggestion is the full version latest points at", () => {
    const parsed = parseTags(fixture("tags-gitea.json"));
    const latest = parsed?.tags.find((t) => t.name === "latest") ?? null;
    expect(latest?.platforms.map((p) => p.platform)).toEqual(expect.arrayContaining(["linux/amd64", "linux/arm64"]));
    expect(latest?.platforms.every((p) => p.platform.startsWith("linux/"))).toBe(true);
    expect(latest?.platforms[0]?.sizeBytes).toBeGreaterThan(1_000_000);
    expect(suggestTag(parsed?.tags ?? [], latest)).toBe("28.3.0");
    // Without latest: the newest version tag; with nothing like a version, the newest tag.
    expect(suggestTag(parsed?.tags ?? [], null)).toBe("28.3.0");
    expect(suggestTag([{ name: "edge", digest: null, updatedAt: null, platforms: [] }], null)).toBe("edge");
    expect(suggestTag([], null)).toBeNull();
  });

  test("image config: ports, volumes, env, health check, labels", () => {
    const parsed = parseConfig(fixture("registry/config-amd64.raw"));
    expect(parsed).toMatchObject({
      platform: "linux/amd64",
      ports: [
        { port: 22, protocol: "tcp" },
        { port: 3000, protocol: "tcp" },
      ],
      volumes: ["/data"],
      entrypoint: ["/usr/bin/entrypoint"],
      cmd: ["/usr/bin/s6-svscan", "/etc/s6"],
    });
    expect(parsed?.env).toContainEqual({ name: "GITEA_CUSTOM", value: "/data/gitea" });
    const made = parseConfig(JSON.parse(new TextDecoder().decode(privateImage.config)));
    expect(made?.healthcheck).toEqual({
      test: ["CMD-SHELL", "wget -qO- localhost:8080/health"],
      intervalSeconds: 30,
      timeoutSeconds: 5,
      startPeriodSeconds: 10,
      retries: 3,
    });
    expect(made?.ports).toEqual([
      { port: 8080, protocol: "tcp" },
      { port: 9090, protocol: "udp" },
    ]);
    expect(made?.user).toBe("1000:1000");
    expect(made?.labels).toEqual([{ name: "org.opencontainers.image.title", value: "private app" }]);
    expect(parseConfig("nope")).toBeNull();
  });

  test("image config: long strings are cut, a long ENV value is left out, and one config holds at most the budget", () => {
    const long = "x".repeat(10_000);
    const parsed = parseConfig({
      architecture: "amd64",
      os: "linux",
      config: {
        Env: [`HUGE=${long}`, "KEEP=1", `${"N".repeat(300)}=1`],
        Entrypoint: [long],
        Cmd: ["run", long],
        WorkingDir: long,
        User: long,
        Volumes: { "/data": {}, [`/${long}`]: {} },
        Labels: { title: long, [long]: "x" },
        Healthcheck: { Test: ["CMD-SHELL", long] },
      },
    });
    // A cut value would replace the image's own default with a wrong one.
    expect(parsed?.env).toEqual([{ name: "KEEP", value: "1" }]);
    expect(parsed?.entrypoint[0]).toHaveLength(4000);
    expect(parsed?.cmd).toEqual(["run", "x".repeat(4000)]);
    expect(parsed?.workingDir).toHaveLength(4000);
    expect(parsed?.user).toHaveLength(256);
    expect(parsed?.volumes).toEqual(["/data"]);
    expect(parsed?.labels).toEqual([{ name: "title", value: "x".repeat(2000) }]);
    expect(parsed?.healthcheck?.test).toEqual(["CMD-SHELL", "x".repeat(4000)]);

    // Hundreds of long values: what is kept stops at the budget, whatever the caps per string.
    const many = parseConfig({
      config: {
        Entrypoint: Array.from({ length: 200 }, () => long),
        Env: Array.from({ length: 200 }, (_, i) => `VAR_${i}=${"v".repeat(3000)}`),
        Labels: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`label.${i}`, long])),
      },
    });
    const chars = (many?.entrypoint.join("").length ?? 0) + (many?.env ?? []).reduce((n, e) => n + e.name.length + e.value.length, 0);
    expect(chars).toBeLessThanOrEqual(configBudget);
    // The env the form fills in comes first: 21 whole entries of about 3000 characters fit, none cut.
    expect(many?.env).toHaveLength(21);
    expect(many?.env.every((e) => e.value.length === 3000)).toBe(true);
    // The rest of the budget goes to the entrypoint, cut; nothing is left for labels.
    expect(many?.entrypoint).toHaveLength(1);
    expect(chars).toBe(configBudget);
    expect(many?.labels).toEqual([]);
  });

  test("platform choice prefers the node's CPU, then the other one", () => {
    const entries = [
      { digest: "a", platform: "linux/arm/v7" },
      { digest: "b", platform: "linux/arm64/v8" },
      { digest: "c", platform: "linux/amd64" },
    ];
    expect(pickPlatform(entries, "amd64")).toEqual({ digest: "c", platform: "linux/amd64" });
    expect(pickPlatform(entries, "arm64")).toEqual({ digest: "b", platform: "linux/arm64/v8" });
    expect(pickPlatform([entries[1] as (typeof entries)[number]], "amd64")?.platform).toBe("linux/arm64/v8");
    expect(pickPlatform([entries[0] as (typeof entries)[number]], "amd64")).toBeNull();
  });

  test("official images live under library/", () => {
    expect(repositoryPath("nginx")).toEqual({ namespace: "library", name: "nginx", path: "library/nginx" });
    expect(repositoryPath("gitea/gitea").path).toBe("gitea/gitea");
  });
});

describe("search and tags", () => {
  test("search is cached for 10 minutes", async () => {
    const { hub, client, advance } = setup();
    const first = await client.search("gitea", 1);
    expect(first.results[0]?.repository).toBe("gitea/gitea");
    expect(first.hasMore).toBe(true);
    await client.search("Gitea ", 1);
    expect(hub.count("hub.docker.com")).toBe(1);
    advance(11 * 60_000);
    await client.search("gitea", 1);
    expect(hub.count("hub.docker.com")).toBe(2);
  });

  test("words are also looked up as a repository name, and its exact matches lead", async () => {
    const item = (id: string, badge = "none", pulls = 1) => ({ id, type: "image", badge, raw_pull_count: pulls, publisher: { name: "x" } });
    const answers: Record<string, unknown> = {
      "my app": { total: 2, results: [item("acme/other-app", "verified", 50), item("acme/app-tools")] },
      "my-app": { total: 2, results: [item("someone/my-app", "none", 900), item("x/my-app-extra")] },
    };
    const queries: string[] = [];
    const client = new DockerHubClient({
      fetch: async (url) => {
        const query = new URL(url).searchParams.get("query") ?? "";
        queries.push(query);
        return new Response(JSON.stringify(answers[query] ?? { total: 0, results: [] }), { status: 200 });
      },
    });
    const page = await client.search("My  App", 1);
    expect(queries).toEqual(["my app", "my-app"]);
    expect(page.results.map((r) => r.repository)).toEqual(["someone/my-app", "acme/other-app", "acme/app-tools"]);
    // One word needs no second lookup; later pages neither.
    await client.search("gitea", 1);
    await client.search("my app", 2);
    expect(queries).toEqual(["my app", "my-app", "gitea", "my app"]);
  });

  test("page 20 is the last: hasMore is false there however many results Docker Hub has", async () => {
    const { client } = setup();
    expect((await client.search("gitea", 19)).hasMore).toBe(true);
    expect((await client.search("gitea", 20)).hasMore).toBe(false);
  });

  test("falls back to the older search when v4 is gone", async () => {
    const { hub, client, warnings } = setup({ searchV4Gone: true });
    const page = await client.search("nginx", 1);
    expect(page.results[0]?.repository).toBe("nginx");
    expect(hub.seen.map((s) => s.url.pathname)).toEqual(["/api/search/v4", "/v2/search/repositories/"]);
    expect(warnings).toHaveLength(1);
  });

  test("a 429 answers RATE_LIMITED and the client waits out the limit before asking again", async () => {
    const { hub, client, advance } = setup({ limited: new Set(["hub.docker.com"]) });
    const error = await opError(client.search("gitea", 1));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toContain("Try again in");
    const wait = Number(error.details?.retryAfterSeconds);
    expect(wait).toBeGreaterThan(30);
    expect(wait).toBeLessThanOrEqual(43);
    expect((await opError(client.tags("gitea/gitea", { page: 1, access: anonymous }))).code).toBe("RATE_LIMITED");
    expect(hub.count("hub.docker.com")).toBe(1);
    hub.options.limited = undefined;
    advance(wait * 1000 + 1);
    expect((await client.search("gitea", 1)).results.length).toBeGreaterThan(0);
  });

  test("a 429 from the token server blocks tokens only, and a Hub API 429 does not block tokens", async () => {
    const { hub, client, advance } = setup({ limited: new Set(["auth.docker.io"]) });
    const error = await opError(client.inspect("gitea/gitea", meta.tag, "amd64", anonymous));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.details?.retryAfterSeconds).toBe("600");
    // Search and tags (hub.docker.com) are not held back by the token server's limit.
    expect((await client.search("gitea", 1)).results.length).toBeGreaterThan(0);
    // No more token requests until the limit lifts.
    expect((await opError(client.inspect("gitea/gitea", meta.tag, "amd64", anonymous))).code).toBe("RATE_LIMITED");
    expect(hub.count("auth.docker.io")).toBe(1);
    hub.options.limited = undefined;
    advance(601_000);
    expect((await client.inspect("gitea/gitea", meta.tag, "amd64", anonymous)).ports).toHaveLength(2);

    // The other way round: a limited Hub API leaves inspect working.
    const other = setup({ limited: new Set(["hub.docker.com"]) });
    expect((await opError(other.client.search("gitea", 1))).code).toBe("RATE_LIMITED");
    expect((await other.client.inspect("gitea/gitea", meta.tag, "amd64", anonymous)).ports).toHaveLength(2);
  });

  test("tags are cached for 30 minutes and suggest the version latest points at", async () => {
    const { hub, client, advance } = setup();
    const page = await client.tags("gitea/gitea", { page: 1, access: anonymous });
    expect(page.suggested).toBe("28.3.0");
    expect(page.tags[0]?.name).toBe("main-nightly-rootless");
    await client.tags("gitea/gitea", { page: 1, access: anonymous });
    expect(hub.count("hub.docker.com")).toBe(1);
    advance(31 * 60_000);
    await client.tags("gitea/gitea", { page: 1, access: anonymous });
    expect(hub.count("hub.docker.com")).toBe(2);
  });

  test("when latest's version tag is not on the first page, the suggestion looks one page further", async () => {
    const a = `sha256:${"a".repeat(64)}`;
    const tag = (name: string, digest: string) => ({ name, digest, images: [{ os: "linux", architecture: "amd64", size: 10 }] });
    const pages: Record<string, unknown> = {
      "1": { next: "https://hub.docker.com/next", results: [tag("edge", `sha256:${"b".repeat(64)}`), tag("latest", a)] },
      "2": { next: null, results: [tag("1.2", a), tag("1.2.3", a)] },
    };
    const seen: string[] = [];
    const client = new DockerHubClient({
      fetch: async (url) => {
        const page = new URL(url).searchParams.get("page") ?? "";
        seen.push(page);
        return new Response(JSON.stringify(pages[page]), { status: 200 });
      },
    });
    const result = await client.tags("acme/app", { page: 1, access: anonymous });
    expect(result.tags.map((t) => t.name)).toEqual(["edge", "latest"]);
    expect(result.suggested).toBe("1.2.3");
    expect(seen).toEqual(["1", "2"]);
  });

  test("an unknown repository is NOT_FOUND; private repositories only with the login and registries.manage", async () => {
    const { hub, client } = setup({ login });
    expect((await opError(client.tags("acme/private", { page: 1, access: anonymous }))).code).toBe("NOT_FOUND");
    // A member with the login configured still sees nothing private, and the login is never sent.
    expect((await opError(client.tags("acme/private", { page: 1, access: { login, privateAccess: false } }))).code).toBe("NOT_FOUND");
    expect(hub.seen.some((s) => s.method === "POST")).toBe(false);
    const own = await client.tags("acme/private", { page: 1, access: { login, privateAccess: true } });
    expect(own.tags.map((t) => t.name)).toEqual(["1"]);
    // The private answer is cached apart: a member still gets NOT_FOUND.
    expect((await opError(client.tags("acme/private", { page: 1, access: { login, privateAccess: false } }))).code).toBe("NOT_FOUND");
  });
});

describe("inspect", () => {
  test("reads the config through a token, the index, the platform manifest and the CDN blob", async () => {
    const { hub, client } = setup();
    const config = await client.inspect("gitea/gitea", meta.tag, "amd64", anonymous);
    expect(config).toMatchObject({
      repository: "gitea/gitea",
      tag: meta.tag,
      digest: meta.indexDigest,
      platform: "linux/amd64",
      ports: [
        { port: 22, protocol: "tcp" },
        { port: 3000, protocol: "tcp" },
      ],
      volumes: ["/data"],
      private: false,
      registryId: null,
    });
    expect(config.platforms).toEqual(expect.arrayContaining(["linux/amd64", "linux/arm64"]));
    expect(hub.seen.map((s) => `${s.method} ${s.url.hostname}`)).toEqual([
      "GET auth.docker.io",
      "HEAD registry-1.docker.io",
      "GET registry-1.docker.io",
      "GET registry-1.docker.io",
      "GET registry-1.docker.io",
      "GET production.cloudflare.docker.com",
    ]);
    // The registry token never goes to the CDN.
    const cdn = hub.seen.find((s) => s.url.hostname === "production.cloudflare.docker.com");
    expect(cdn?.headers.get("authorization")).toBeNull();
    const blob = hub.seen.find((s) => s.url.pathname.includes("/blobs/"));
    expect(blob?.headers.get("authorization")).toBe("Bearer anon-token:gitea/gitea");
  });

  test("a digest read before costs only a free HEAD", async () => {
    const { hub, client } = setup();
    await client.inspect("gitea/gitea", meta.tag, "amd64", anonymous);
    const before = hub.seen.length;
    await client.inspect("gitea/gitea", meta.tag, "amd64", anonymous);
    expect(hub.seen.slice(before).map((s) => s.method)).toEqual(["HEAD"]);
    // Another CPU of the same tag reads its own manifest and config.
    const arm = await client.inspect("gitea/gitea", meta.tag, "arm64", anonymous);
    expect(arm.platform).toBe("linux/arm64");
  });

  test("public images pull with the saved login's token; the free HEAD stays anonymous", async () => {
    const { hub, client } = setup({ login });
    // Public: the form pulls anonymously unless the person picks the login.
    expect((await client.inspect("gitea/gitea", meta.tag, "amd64", { login, privateAccess: true })).registryId).toBeNull();
    const head = hub.seen.find((s) => s.method === "HEAD");
    expect(head?.headers.get("authorization")).toBe("Bearer anon-token:gitea/gitea");
    const gets = hub.seen.filter((s) => s.method === "GET" && s.url.hostname === "registry-1.docker.io");
    expect(gets.every((s) => s.headers.get("authorization") === "Bearer login-token:gitea/gitea")).toBe(true);
    const basic = hub.seen.find((s) => s.url.hostname === "auth.docker.io" && s.headers.get("authorization"));
    expect(basic?.headers.get("authorization")).toBe(`Basic ${Buffer.from("acme:dckr_pat_test").toString("base64")}`);
  });

  test("a refused login falls back to anonymous pulls and is not retried every call", async () => {
    const { hub, client, warnings } = setup({ login: { username: "acme", password: "other" } });
    const config = await client.inspect("gitea/gitea", meta.tag, "amd64", { login, privateAccess: false });
    expect(config.private).toBe(false);
    expect(warnings.some((w) => w.includes("refused"))).toBe(true);
    const basics = () => hub.seen.filter((s) => s.url.hostname === "auth.docker.io" && s.headers.get("authorization")).length;
    expect(basics()).toBe(1);
    await client.inspect("gitea/gitea", meta.tag, "amd64", { login, privateAccess: false });
    expect(basics()).toBe(1);
  });

  test("private images: NOT_FOUND for members, readable for people who manage registries", async () => {
    const { hub, client } = setup({ login });
    expect((await opError(client.inspect("acme/private", "1", "amd64", { login, privateAccess: false }))).code).toBe("NOT_FOUND");
    expect(hub.seen.some((s) => s.headers.get("authorization")?.startsWith("Basic"))).toBe(false);
    const config = await client.inspect("acme/private", "1", "amd64", { login, privateAccess: true });
    expect(config).toMatchObject({
      private: true,
      registryId: login.id,
      digest: privateImage.digest,
      platform: "linux/amd64",
      platforms: ["linux/amd64"],
    });
    expect(config.healthcheck?.retries).toBe(3);
    // Cached digests do not open the image to members either.
    expect((await opError(client.inspect("acme/private", "1", "amd64", { login, privateAccess: false }))).code).toBe("NOT_FOUND");
  });

  test("the pull limit: RATE_LIMITED with a hint to add a login, then no requests until it resets", async () => {
    const { hub, client, advance } = setup({ limited: new Set(["registry-get"]) });
    const error = await opError(client.inspect("gitea/gitea", meta.tag, "amd64", anonymous));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toContain("Docker Hub login");
    expect(error.details?.retryAfterSeconds).toBe("600");
    const before = hub.seen.length;
    expect((await opError(client.inspect("gitea/gitea", meta.tag, "amd64", anonymous))).code).toBe("RATE_LIMITED");
    // The HEAD is free and still allowed; no GET was sent.
    expect(hub.seen.slice(before).every((s) => s.method !== "GET" || s.url.hostname !== "registry-1.docker.io")).toBe(true);
    hub.options.limited = undefined;
    advance(601_000);
    expect((await client.inspect("gitea/gitea", meta.tag, "amd64", anonymous)).ports).toHaveLength(2);
  });

  test("an unknown tag is NOT_FOUND", async () => {
    const { client } = setup();
    expect((await opError(client.inspect("gitea/gitea", "0.0.0-nope", "amd64", anonymous))).code).toBe("NOT_FOUND");
  });

  test("content that does not match its digest is refused", async () => {
    const hub = new FakeDockerHub();
    const client = new DockerHubClient({
      fetch: async (url, init) => {
        const response = await hub.fetch(url, init);
        if (!url.includes("production.cloudflare.docker.com")) return response;
        const body = new TextEncoder().encode(`${await response.text()} `);
        return new Response(body, { status: 200 });
      },
    });
    const error = await opError(client.inspect("gitea/gitea", meta.tag, "amd64", anonymous));
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toContain("digest");
  });

  test("an image without linux/amd64 or linux/arm64 says which platforms it has", async () => {
    const index = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [{ digest: `sha256:${"1".repeat(64)}`, platform: { os: "linux", architecture: "arm", variant: "v7" } }],
      }),
    );
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(index).digest("hex")}`;
    const hub = new FakeDockerHub();
    const client = new DockerHubClient({
      fetch: async (url, init) => {
        if (url.startsWith("https://registry-1.docker.io/")) {
          return new Response(init?.method === "HEAD" ? null : index, {
            status: 200,
            headers: { "docker-content-digest": digest, "content-type": "application/vnd.oci.image.index.v1+json" },
          });
        }
        return hub.fetch(url, init);
      },
    });
    const error = await opError(client.inspect("gitea/gitea", "arm-only", "amd64", anonymous));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toContain("linux/arm/v7");
  });
});

describe("transport", () => {
  test("only Docker Hub's hosts over HTTPS, and redirects only among them", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    };
    const opts = { maxBytes: 1024, timeoutMs: 1000 };
    await expect(hubFetch(fetchImpl, "https://example.com/v2/", opts)).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(hubFetch(fetchImpl, "http://hub.docker.com/v2/", opts)).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(hubFetch(fetchImpl, "https://hub.docker.com:8443/v2/", opts)).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(hubFetch(fetchImpl, "https://hub.docker.com/v2/", opts)).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(seen).toEqual(["https://hub.docker.com/v2/"]);
  });

  test("bodies are capped while read", async () => {
    const big = new Uint8Array(5000);
    const fetchImpl = async () => new Response(big, { status: 200 });
    await expect(hubFetch(fetchImpl, "https://hub.docker.com/v2/", { maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow("larger than");
  });

  test("a config blob over 2 MiB is refused while read, not parsed or cached", async () => {
    const { client, logged } = setup(
      {},
      (hub) => async (url, init) =>
        url.includes("production.cloudflare.docker.com")
          ? new Response(new Uint8Array(3 * 1024 * 1024), { status: 200 })
          : hub.fetch(url, init),
    );
    const error = await opError(client.inspect("gitea/gitea", meta.tag, "amd64", anonymous));
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toContain("larger than this panel reads");
    expect(logged).toContainEqual(
      expect.objectContaining({ error: "BodyTooLargeError", detail: `answer larger than ${2 * 1024 * 1024} bytes` }),
    );
  });

  test("a redirect to a host the panel does not contact names that host, in the answer and the log", async () => {
    const { hub, client, logged } = setup(
      {},
      (hub) => async (url, init) =>
        url.includes("/blobs/")
          ? new Response(null, { status: 307, headers: { location: "https://production.newcdn.docker.com/blob/data?signature=secret" } })
          : hub.fetch(url, init),
    );
    const error = await opError(client.inspect("gitea/gitea", meta.tag, "amd64", anonymous));
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toBe("Docker Hub sent this panel to production.newcdn.docker.com, which it does not contact.");
    expect(logged).toContainEqual({
      host: "registry-1.docker.io",
      error: "HostNotAllowedError",
      detail: "refusing to contact https://production.newcdn.docker.com",
    });
    expect(JSON.stringify(logged)).not.toContain("secret");
    expect(hub.count("production.newcdn.docker.com")).toBe(0);
  });

  test("Retry-After wins, then X-RateLimit-Reset, then a minute", () => {
    const now = 1_000_000_000_000;
    expect(retryAfterSeconds(new Headers({ "retry-after": "90" }), now)).toBe(90);
    expect(retryAfterSeconds(new Headers({ "x-ratelimit-reset": String(now / 1000 + 30) }), now)).toBe(30);
    expect(retryAfterSeconds(new Headers(), now)).toBe(60);
  });
});
