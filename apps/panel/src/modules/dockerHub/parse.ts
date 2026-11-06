// Docker Hub and registry answers to the op shapes. Pure functions over
// unknown JSON: anything missing or malformed is skipped or left empty, so
// an answer that changes shape degrades to fewer details, never a crash.

import type { dockerHub as hubOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";

export type SearchResult = Static<typeof hubOps.SearchResult>;
export type TagInfo = Static<typeof hubOps.TagInfo>;
export type ImagePort = Static<typeof hubOps.ImagePort>;
export type ImageHealthcheck = Static<typeof hubOps.ImageHealthcheck>;

type Json = Record<string, unknown>;

const repositoryRe = /^(?:[a-z0-9]+(?:[_-][a-z0-9]+)*\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const tagRe = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strings = (v: unknown): string[] => arr(v).filter((s): s is string => typeof s === "string");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function isRepository(name: string): boolean {
  return name.length <= 255 && repositoryRe.test(name);
}

export function isTag(name: string): boolean {
  return tagRe.test(name);
}

/** "nginx" -> "library/nginx": the path Docker Hub's APIs use. */
export function repositoryPath(repository: string): { namespace: string; name: string; path: string } {
  const [first, second] = repository.split("/");
  const namespace = second === undefined ? "library" : (first as string);
  const name = second ?? (first as string);
  return { namespace, name, path: `${namespace}/${name}` };
}

/** "library/nginx" -> "nginx"; everything else stays. */
export function displayRepository(path: string): string {
  return path.startsWith("library/") ? path.slice("library/".length) : path;
}

function timestamp(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** "1B+", "4.2K", "8685" -> a number (the lower bound for "+" forms). */
export function parsePullCount(v: unknown): number {
  if (typeof v === "number") return count(v);
  const m = /^([\d.]+)\s*([KMB])?\+?$/i.exec(str(v).trim());
  if (!m) return 0;
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase() as "K" | "M" | "B"] ?? 1;
  const n = Number(m[1]) * scale;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const knownArchitectures = new Set(["amd64", "arm64", "arm", "386", "ppc64le", "s390x", "riscv64", "mips64le"]);

function badgeOf(v: unknown): SearchResult["badge"] {
  switch (str(v)) {
    case "official":
      return "official";
    case "verified_publisher":
      return "verified";
    case "open_source":
      return "openSource";
    default:
      return "none";
  }
}

/** "Uptime Kuma" -> "uptime-kuma": a query as a repository name. */
export function queryName(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, "-");
}

/** The repository is named exactly what was searched for ("gitea" for gitea/gitea, "nginx" for nginx). */
export function isExactMatch(result: Pick<SearchResult, "repository">, query: string): boolean {
  const name = queryName(query);
  return result.repository === name || result.repository.split("/").pop() === name;
}

/**
 * Official images and verified publishers first, then the rest in Docker
 * Hub's order. Images named exactly what was searched for lead: the
 * official one, then the others by pulls, so the project's own image
 * (gitea/gitea, 400M pulls) is not buried under repackagings that happen
 * to carry a badge.
 */
export function rankResults(results: SearchResult[], query: string): SearchResult[] {
  const tier = (r: SearchResult) => {
    const exact = isExactMatch(r, query);
    if (exact) return r.badge === "official" ? 0 : 1;
    return r.badge === "official" ? 2 : r.badge === "verified" ? 3 : 4;
  };
  return results
    .map((r, i) => ({ r, i, tier: tier(r) }))
    .sort((a, b) => a.tier - b.tier || (a.tier === 1 ? b.r.pullCount - a.r.pullCount : 0) || a.i - b.i)
    .map(({ r }) => r);
}

/** Docker Hub's search (api/search/v4): image repositories only, not extensions, MCP servers or hardened images. */
export function parseSearchV4(body: unknown, query: string): { results: SearchResult[]; total: number } | null {
  const root = obj(body);
  if (!root || !Array.isArray(root.results)) return null;
  const results: SearchResult[] = [];
  for (const item of root.results.map(obj)) {
    if (!item || str(item.type) !== "image") continue;
    const repository = displayRepository(str(item.id) || str(item.slug));
    if (!isRepository(repository)) continue;
    const badge = badgeOf(item.badge);
    results.push({
      repository,
      publisher: badge === "official" ? "Docker" : str(obj(item.publisher)?.name) || (repository.split("/")[0] as string),
      description: str(item.short_description).slice(0, 500),
      pullCount: typeof item.raw_pull_count === "number" ? count(item.raw_pull_count) : parsePullCount(item.pull_count),
      stars: count(item.star_count),
      badge,
      updatedAt: timestamp(item.updated_at),
      architectures: [...new Set(arr(item.architectures).map((a) => str(obj(a)?.name)))].filter((a) => knownArchitectures.has(a)),
    });
  }
  return { results: rankResults(results, query), total: count(root.total) };
}

/** The older search (v2/search/repositories): no publisher badges beyond "official". */
export function parseSearchV2(body: unknown, query: string): { results: SearchResult[]; hasMore: boolean } | null {
  const root = obj(body);
  if (!root || !Array.isArray(root.results)) return null;
  const results: SearchResult[] = [];
  for (const item of root.results.map(obj)) {
    if (!item) continue;
    const repository = displayRepository(str(item.repo_name));
    if (!isRepository(repository)) continue;
    const official = item.is_official === true;
    results.push({
      repository,
      publisher: official ? "Docker" : str(item.repo_owner) || (repository.includes("/") ? (repository.split("/")[0] as string) : "Docker"),
      description: str(item.short_description).slice(0, 500),
      pullCount: count(item.pull_count),
      stars: count(item.star_count),
      badge: official ? "official" : "none",
      updatedAt: null,
      architectures: [],
    });
  }
  return { results: rankResults(results, query), hasMore: typeof root.next === "string" && root.next !== "" };
}

function platformOf(p: Json | null): string | null {
  if (!p) return null;
  const os = str(p.os);
  const architecture = str(p.architecture);
  if (os !== "linux" || !knownArchitectures.has(architecture)) return null;
  const variant = str(p.variant);
  return variant ? `linux/${architecture}/${variant}` : `linux/${architecture}`;
}

export function parseTag(item: Json): TagInfo | null {
  const name = str(item.name);
  if (!isTag(name)) return null;
  const platforms: TagInfo["platforms"] = [];
  const seen = new Set<string>();
  for (const image of arr(item.images).map(obj)) {
    const platform = platformOf(image);
    if (!platform || seen.has(platform)) continue;
    seen.add(platform);
    platforms.push({ platform, sizeBytes: typeof image?.size === "number" ? count(image.size) : null });
  }
  return {
    name,
    digest: str(item.digest).startsWith("sha256:") ? str(item.digest) : null,
    updatedAt: timestamp(item.tag_last_pushed) ?? timestamp(item.last_updated),
    platforms,
  };
}

/** One page of v2/namespaces/<ns>/repositories/<name>/tags. */
export function parseTags(body: unknown): { tags: TagInfo[]; hasMore: boolean } | null {
  const root = obj(body);
  if (!root || !Array.isArray(root.results)) return null;
  const tags = root.results.map(obj).flatMap((item) => (item ? [parseTag(item)].filter((t): t is TagInfo => t !== null) : []));
  return { tags, hasMore: typeof root.next === "string" && root.next !== "" };
}

const versionRe = /^v?\d+(?:\.\d+){0,3}$/;

/** Whether a version tag ("1.29.3", "v2") in the list is the image with this digest. */
export function hasVersionTag(tags: readonly TagInfo[], digest: string): boolean {
  return tags.some((t) => t.digest === digest && versionRe.test(t.name));
}

/**
 * The tag to preselect, so the service is pinned: the most specific version
 * tag that is the same image as latest ("1.29.3" over "1.29" and "1"), else
 * latest itself. Without latest the newest version tag stands in for it;
 * with no version tags at all, the newest tag.
 */
export function suggestTag(tags: readonly TagInfo[], latest: TagInfo | null): string | null {
  const versions = tags.filter((t) => versionRe.test(t.name));
  const anchor = latest ?? versions[0] ?? null;
  if (!anchor) return tags[0]?.name ?? null;
  const same = anchor.digest ? versions.filter((t) => t.digest === anchor.digest) : [];
  const best = same.sort((a, b) => b.name.split(".").length - a.name.split(".").length || b.name.length - a.name.length)[0];
  return best?.name ?? anchor.name;
}

// Image configs (the JSON blob a manifest's config descriptor names).

export interface ParsedConfig {
  platform: string;
  ports: ImagePort[];
  volumes: string[];
  env: { name: string; value: string }[];
  entrypoint: string[];
  cmd: string[];
  user: string;
  workingDir: string;
  healthcheck: ImageHealthcheck | null;
  labels: { name: string; value: string }[];
  createdAt: string | null;
}

const maxListed = 200;

function seconds(ns: unknown): number | null {
  return typeof ns === "number" && Number.isFinite(ns) && ns > 0 ? ns / 1e9 : null;
}

export function parsePorts(exposed: unknown): ImagePort[] {
  const out: ImagePort[] = [];
  for (const key of Object.keys(obj(exposed) ?? {})) {
    const m = /^(\d{1,5})(?:\/(tcp|udp|sctp))?$/i.exec(key.trim());
    if (!m) continue;
    const port = Number(m[1]);
    if (port < 1 || port > 65535) continue;
    const protocol = (m[2]?.toLowerCase() ?? "tcp") as ImagePort["protocol"];
    if (!out.some((p) => p.port === port && p.protocol === protocol)) out.push({ port, protocol });
  }
  return out.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol)).slice(0, maxListed);
}

export function parseConfig(body: unknown): ParsedConfig | null {
  const root = obj(body);
  if (!root) return null;
  const config = obj(root.config) ?? obj(root.container_config) ?? {};
  const health = obj(config.Healthcheck);
  const test = strings(health?.Test);
  const architecture = str(root.architecture);
  const variant = str(root.variant);
  return {
    platform: `${str(root.os) || "linux"}/${architecture || "unknown"}${variant ? `/${variant}` : ""}`,
    ports: parsePorts(config.ExposedPorts),
    volumes: Object.keys(obj(config.Volumes) ?? {})
      .filter((p) => p.startsWith("/"))
      .slice(0, maxListed),
    env: strings(config.Env)
      .slice(0, maxListed)
      .map((line) => {
        const at = line.indexOf("=");
        return at < 0 ? { name: line, value: "" } : { name: line.slice(0, at), value: line.slice(at + 1) };
      })
      .filter((e) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(e.name)),
    entrypoint: strings(config.Entrypoint),
    cmd: strings(config.Cmd),
    user: str(config.User),
    workingDir: str(config.WorkingDir),
    healthcheck:
      test.length > 0
        ? {
            test,
            intervalSeconds: seconds(health?.Interval),
            timeoutSeconds: seconds(health?.Timeout),
            startPeriodSeconds: seconds(health?.StartPeriod),
            retries: typeof health?.Retries === "number" && health.Retries >= 0 ? Math.floor(health.Retries) : null,
          }
        : null,
    labels: Object.entries(obj(config.Labels) ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .slice(0, maxListed)
      .map(([name, value]) => ({ name, value: value.slice(0, 2000) })),
    createdAt: timestamp(root.created),
  };
}

// Manifests.

export const manifestAccept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export type Manifest =
  | { kind: "index"; entries: { digest: string; platform: string | null }[] }
  | { kind: "image"; configDigest: string }
  | { kind: "unsupported" };

const digestRe = /^sha256:[a-f0-9]{64}$/;

export function parseManifest(body: unknown, contentType: string): Manifest {
  const root = obj(body);
  if (!root) return { kind: "unsupported" };
  const mediaType = str(root.mediaType) || contentType.split(";")[0]?.trim() || "";
  if (Array.isArray(root.manifests) && !mediaType.includes("manifest.v1+prettyjws")) {
    const entries = root.manifests.map(obj).flatMap((m) => {
      if (!m || !digestRe.test(str(m.digest))) return [];
      // Attestations (buildx provenance and SBOMs) sit in the index as "unknown/unknown".
      if (str(obj(m.annotations)?.["vnd.docker.reference.type"]) === "attestation-manifest") return [];
      return [{ digest: str(m.digest), platform: platformOf(obj(m.platform)) }];
    });
    return { kind: "index", entries };
  }
  const config = obj(root.config);
  if (config && digestRe.test(str(config.digest))) return { kind: "image", configDigest: str(config.digest) };
  return { kind: "unsupported" };
}

/** The entry for arch (any variant), else the other of amd64/arm64; null when neither ships. */
export function pickPlatform(
  entries: readonly { digest: string; platform: string | null }[],
  arch: "amd64" | "arm64",
): { digest: string; platform: string } | null {
  const order = arch === "arm64" ? ["arm64", "amd64"] : ["amd64", "arm64"];
  for (const want of order) {
    const hit = entries.find((e) => e.platform === `linux/${want}` || e.platform?.startsWith(`linux/${want}/`));
    if (hit?.platform) return { digest: hit.digest, platform: hit.platform };
  }
  return null;
}
