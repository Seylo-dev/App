// Any image of a database engine (0.2.11): the repository each engine's
// images come from, and what an image of it says, read from its tag: the
// release, the version line it is recorded as in service_databases.version
// (the catalog's line, a line the catalog does not have, or "custom" when
// the tag names none, such as latest or a digest), whether the tag floats
// (latest, "8.2": the bytes behind it can change on the next deploy) and
// where the line keeps its data. databases.create and databases.setVersion
// take any tag or digest of that repository; version.ts judges the change.

import { OpError } from "@seylo/ops";
import type { DatabaseEngine } from "../../db/schema";
import { type EngineVersion, engines, engineVersion, engineVersions } from "./engines";

/** The version recorded for an image whose tag names no release: latest, a digest, "alpine". */
export const customLine = "custom";

/** The image repositories of KeyDB and Dragonfly: neither has an official Docker Hub image. */
const ownRepositories: Partial<Record<DatabaseEngine, string>> = {
  keydb: "eqalpha/keydb",
  dragonfly: "ghcr.io/dragonflydb/dragonfly",
};

const officialRepositories: Partial<Record<DatabaseEngine, string>> = {
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongo",
  redis: "redis",
  valkey: "valkey/valkey",
  clickhouse: "clickhouse/clickhouse-server",
};

/**
 * The repository a database's images come from: the engine's official one
 * (pgvector's for that variant), or KeyDB's and Dragonfly's own. Null for a
 * variant without one. Seylo's env, data folder, health check and command
 * are made for these images, so no other repository is taken.
 */
export function engineRepository(engine: DatabaseEngine, variant: string | null): string | null {
  if (engine === "postgres") return variant === "pgvector" ? "pgvector/pgvector" : variant ? null : "postgres";
  if (variant) return null;
  return officialRepositories[engine] ?? ownRepositories[engine] ?? null;
}

/** Whether the engine has an official Docker Hub repository (KeyDB and Dragonfly do not). */
export function hasOfficialRepository(engine: DatabaseEngine): boolean {
  return engine === "postgres" || officialRepositories[engine] !== undefined;
}

export interface EngineImage {
  /** As stored and deployed: docker.io/ and library/ left out, a bare repository as :latest. */
  image: string;
  tag: string | null;
  /** sha256:... when the image names one. */
  digest: string | null;
  /** The release the tag names ("8.2.12", "17.6", pgvector's "0.8.7"); null when it names none. */
  release: string | null;
  /** The line recorded in service_databases.version: the catalog's, else the tag's, else customLine. */
  version: string;
  /** The tag names no exact release and no digest pins it: what it points at can change. */
  floating: boolean;
  /** Where the line keeps its data (dataPathOf). */
  dataPath: string;
}

/**
 * Reads an image of the engine (and variant): any tag or digest of its
 * repository (engineRepository), with or without docker.io/ (and
 * library/). Another repository, or no repository, is a BAD_REQUEST
 * (field image, reason customImage).
 */
export function engineImage(engine: DatabaseEngine, variant: string | null, image: string): EngineImage {
  const repo = engineRepository(engine, variant);
  const label = engines[engine].label;
  const field = { field: "image", reason: "customImage" };
  if (!repo) throw new OpError("BAD_REQUEST", `${label}${variant ? ` with ${variant}` : ""} takes the catalog's image only.`, field);
  const name = image.trim().replace(/^docker\.io\//, "");
  const bare = repo.includes("/") ? name : name.replace(/^library\//, "");
  const match = /^([a-z0-9][a-z0-9._/-]*?)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(sha256:[a-f0-9]{64}))?$/.exec(bare);
  if (!match || match[1] !== repo) {
    throw new OpError(
      "BAD_REQUEST",
      `Use an image of ${repo}, ${label}'s ${hasOfficialRepository(engine) ? "official image" : "own image"}: Seylo's settings for ${label} (its environment, data folder, health check and command) are made for it. Any tag or digest of it works, for example ${repo}:latest.`,
      field,
    );
  }
  const digest = match[3] ?? null;
  const tag = match[2] ?? (digest ? null : "latest");
  const stored = `${repo}${tag ? `:${tag}` : ""}${digest ? `@${digest}` : ""}`;
  const release = tag ? tagRelease(tag) : null;
  const catalog = engineVersions(engine, variant) ?? [];
  const pgLine = variant === "pgvector" && tag ? (/(?:^|-)pg(\d+)(?:-|$)/.exec(tag)?.[1] ?? null) : null;
  const parsed = variant === "pgvector" ? pgLine : release ? lineOfRelease(engine, release) : null;
  const version = catalog.find((v) => v.image === stored)?.version ?? parsed ?? customLine;
  const exact =
    variant === "pgvector"
      ? tag !== null && /^\d+\.\d+\.\d+-pg\d+(-|$)/.test(tag)
      : release !== null && release.split(".").length >= exactParts(engine, release);
  return {
    image: stored,
    tag,
    digest,
    release,
    version,
    floating: digest === null && !exact && !catalog.some((v) => v.image === stored),
    dataPath: dataPathOf(engine, version, variant),
  };
}

/** An image as databases.create runs it: the line its tag names, as a catalog version is (engineImage). */
export function imageVersion(engine: DatabaseEngine, variant: string | null, image: string): EngineVersion {
  const parsed = engineImage(engine, variant, image);
  return { version: parsed.version, image: parsed.image, dataPath: parsed.dataPath };
}

/**
 * The version an imported database starts on: the catalog line, else (a
 * line the catalog does not have, or customLine) the image the file ran,
 * when it is one of the engine's repository that names that line.
 */
export function importedVersion(engine: DatabaseEngine, version: string, variant: string | null, ran: string | null): EngineVersion | null {
  const line = engineVersion(engine, version, variant);
  if (line || !ran) return line;
  try {
    const parsed = imageVersion(engine, variant, ran);
    return parsed.version === version ? parsed : null;
  } catch {
    return null;
  }
}

/** The tag of an image reference ("8.0.38" of "mongo:8.0.38@sha256:..."); null for a digest only or none. */
export function imageTag(image: string): string | null {
  const name = image.replace(/@.*$/, "");
  const colon = name.lastIndexOf(":");
  return colon < 0 || name.indexOf("/", colon) >= 0 ? null : name.slice(colon + 1);
}

/**
 * The release at the start of a tag ("8.2.12" of "8.2.12-noble", "2.0.2" of
 * "v2.0.2"), or after an underscore with a dot in it (KeyDB's
 * "x86_64_v6.3.4"); null when the tag names none (latest, alpine).
 */
export function tagRelease(tag: string): string | null {
  return /^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1] ?? /_v?(\d+(?:\.\d+)+)/.exec(tag)?.[1] ?? null;
}

/**
 * The version line of a release: major.minor ("8.2" of 8.2.12, ClickHouse's
 * "26.8" of 26.8.36.3), Postgres its major from 10 on ("17" of 17.6, "9.6"
 * of 9.6.24). Null when the release has too few numbers to say ("8").
 */
export function lineOfRelease(engine: DatabaseEngine, release: string): string | null {
  const [major, minor] = release.split(".");
  if (engine === "postgres" && Number(major) >= 10) return major ?? null;
  return minor === undefined ? null : `${major}.${minor}`;
}

/** How many numbers an exact release has: Postgres 17.6 (9.6.24 before 10), ClickHouse 26.8.36.3, the others 8.2.12. */
function exactParts(engine: DatabaseEngine, release: string): number {
  if (engine === "postgres") return Number(release.split(".")[0]) >= 10 ? 2 : 3;
  return engine === "clickhouse" ? 4 : 3;
}

/**
 * Where a version line keeps its data: the catalog line's folder, else the
 * engine's own for a line the catalog does not have (Postgres moved it in
 * 18; customLine counts as the newest).
 */
export function dataPathOf(engine: DatabaseEngine, version: string, variant: string | null): string {
  const line = engineVersion(engine, version, variant);
  if (line) return line.dataPath;
  if (engine === "postgres") {
    const major = Number(version.split(".")[0]);
    if (version !== customLine && Number.isFinite(major) && major < 18) return "/var/lib/postgresql/data";
    return "/var/lib/postgresql";
  }
  return (engineVersions(engine, variant) ?? engines[engine].versions)[0]?.dataPath ?? "/data";
}

/**
 * The base system a Postgres tag is built on: what follows its release
 * ("-alpine" of "17.6-alpine", "-trixie" of pgvector's "0.8.7-pg17-trixie",
 * "" for Debian's default), Alpine's own version left out (one C library,
 * musl, whatever its release).
 */
export function baseOfTag(tag: string): string {
  const rest = tag === "latest" ? "" : tag.replace(/^v?\d+(?:\.\d+)*/, "").replace(/^-?pg\d+/, "");
  const base = rest === "" || rest.startsWith("-") ? rest : `-${rest}`;
  return base.replace(/-alpine[\d.]*/, "-alpine");
}
