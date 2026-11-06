// Docker Hub as a template source. Any image already deploys as a "Docker
// image" app; these ops add finding one (search, newest tags) and reading
// what its image config says (ports, volumes, env defaults, entrypoint,
// user, health check, labels) so the create form comes prefilled. The
// panel only talks to Docker Hub's own hosts, caches answers and keeps to
// its rate limits; dockerHub.create makes a normal app service that people
// change afterwards like any other.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";
import { ServiceDetail, ServiceName } from "./services";

/**
 * A Docker Hub repository as people type it: "nginx" for an official image
 * (the panel adds "library/"), "louislam/uptime-kuma" otherwise.
 */
export const Repository = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^(?:[a-z0-9]+(?:[_-][a-z0-9]+)*/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$",
  description: 'A Docker Hub repository: "nginx" (official image) or "namespace/name". Never another registry: a namespace has no dots.',
});

export const Tag = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$" });

/** official = Docker Official Image; verified = Verified Publisher; openSource = Docker-Sponsored Open Source. */
export const Badge = Type.Union([Type.Literal("official"), Type.Literal("verified"), Type.Literal("openSource"), Type.Literal("none")]);

export const SearchResult = Type.Object({
  repository: Repository,
  /** "NGINX Inc.", "Grafana Labs"; "Docker" for official images. */
  publisher: Type.String(),
  description: Type.String(),
  pullCount: Type.Integer({ minimum: 0 }),
  stars: Type.Integer({ minimum: 0 }),
  badge: Badge,
  updatedAt: Type.Union([Timestamp, Type.Null()]),
  /** Linux CPU architectures the repository ships ("amd64", "arm64"); empty when Docker Hub does not say. */
  architectures: Type.Array(Type.String()),
});

/** "linux/amd64", "linux/arm64/v8", with the compressed size Docker Hub reports. */
export const TagPlatform = Type.Object({
  platform: Type.String(),
  sizeBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

export const TagInfo = Type.Object({
  name: Tag,
  /** Digest the tag points at right now (the manifest list for multi-platform images). */
  digest: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.Union([Timestamp, Type.Null()]),
  /** Linux platforms only. */
  platforms: Type.Array(TagPlatform),
});

export const ImagePort = Type.Object({
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  protocol: Type.Union([Type.Literal("tcp"), Type.Literal("udp"), Type.Literal("sctp")]),
});

export const ImageHealthcheck = Type.Object({
  /** As in the image: ["CMD-SHELL", "curl -f http://localhost/"], ["CMD", ...] or ["NONE"]. */
  test: Type.Array(Type.String()),
  intervalSeconds: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  timeoutSeconds: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  startPeriodSeconds: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  retries: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

/** What an image's config says, read from the registry for one platform. */
export const ImageConfig = Type.Object({
  repository: Repository,
  tag: Tag,
  /** What the tag resolves to now (manifest list or single manifest): `docker pull <repository>:<tag>` gets this. */
  digest: Type.String(),
  /** The platform the config was read for, for example "linux/amd64". */
  platform: Type.String(),
  /** Every Linux platform the tag ships. */
  platforms: Type.Array(Type.String()),
  /** EXPOSE lines. */
  ports: Type.Array(ImagePort),
  /** VOLUME paths. */
  volumes: Type.Array(Type.String()),
  /** ENV defaults, in image order. */
  env: Type.Array(Type.Object({ name: Type.String(), value: Type.String() })),
  entrypoint: Type.Array(Type.String()),
  cmd: Type.Array(Type.String()),
  user: Type.String(),
  workingDir: Type.String(),
  healthcheck: Type.Union([ImageHealthcheck, Type.Null()]),
  labels: Type.Array(Type.Object({ name: Type.String(), value: Type.String() })),
  createdAt: Type.Union([Timestamp, Type.Null()]),
  /** Only readable with the panel's Docker Hub login (people who manage registries see these). */
  private: Type.Boolean(),
});

const projectScope = (input: { projectId: string }) => input.projectId;

export const search = defineOp({
  id: "dockerHub.search",
  kind: "query",
  summary: "Search Docker Hub",
  description:
    "Searches Docker Hub for images by name or description, with pull counts, stars and badges. Images named exactly what was searched for lead (the official one, then by pulls), then official images and verified publishers, then the rest in Docker Hub's order. Several words are also looked up as one hyphenated name. Answers are cached for 10 minutes.",
  input: Type.Object({
    query: Type.String({ minLength: 1, maxLength: 100 }),
    /** 1-based; 25 results a page. */
    page: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  }),
  output: Type.Object({
    results: Type.Array(SearchResult),
    page: Type.Integer({ minimum: 1 }),
    hasMore: Type.Boolean(),
  }),
  // Public data, like the template catalog.
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const tags = defineOp({
  id: "dockerHub.tags",
  kind: "query",
  summary: "List an image's tags",
  description:
    "Lists a Docker Hub repository's tags, newest first, with the Linux platforms and sizes each one ships, and suggests a tag to pin: the most specific version tag that points at the same image as latest. Answers are cached for 30 minutes.",
  input: Type.Object({
    repository: Repository,
    /** Only tags whose name contains this text. */
    filter: Type.Optional(Type.String({ maxLength: 100 })),
    /** 1-based; 100 tags a page. */
    page: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }),
  output: Type.Object({
    tags: Type.Array(TagInfo),
    /** The tag the form should preselect; null when there are no tags. */
    suggested: Type.Union([Tag, Type.Null()]),
    page: Type.Integer({ minimum: 1 }),
    hasMore: Type.Boolean(),
  }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const inspect = defineOp({
  id: "dockerHub.inspect",
  kind: "query",
  summary: "Read an image's config",
  description:
    "Reads an image's config from Docker Hub's registry for linux/amd64 or linux/arm64 (whichever the image ships, preferring arch): exposed ports, VOLUME paths, ENV defaults, entrypoint and command, user, health check and labels, with the digest the tag points at. Costs at most one pull from Docker Hub's rate limit, none when the digest was read before.",
  input: Type.Object({
    repository: Repository,
    tag: Tag,
    /** The CPU of the node the service will run on; defaults to amd64. */
    arch: Type.Optional(Type.Union([Type.Literal("amd64"), Type.Literal("arm64")])),
  }),
  output: ImageConfig,
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const create = defineOp({
  id: "dockerHub.create",
  kind: "mutation",
  summary: "Create an app from a Docker Hub image",
  description:
    "Creates an app service that runs a Docker Hub image pinned to a tag, with its main port, a volume per mount path and a .env, then deploys it unless deployNow is false. A public main port gets the node's automatic domain when the node has a wildcard domain, otherwise IP:port until a domain is added. Use dockerHub.inspect first to read the image's ports, volumes and env defaults.",
  input: Type.Object({
    projectId: Id,
    name: ServiceName,
    nodeId: Id,
    repository: Repository,
    tag: Tag,
    /** A Docker Hub login (registries.list) for private images or a higher pull limit on the node; null pulls anonymously. */
    registryId: Type.Optional(Type.Union([Id, Type.Null()])),
    /** The TCP port the app serves on; null for none. */
    port: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()])),
    /** Reach the main port from outside (automatic domain or IP:port); false keeps it on the project network. Default true. */
    public: Type.Optional(Type.Boolean()),
    /** One volume per path; the name comes from the path when left out. */
    volumes: Type.Optional(
      Type.Array(
        Type.Object({
          mountPath: Type.String({ minLength: 2, maxLength: 500, pattern: "^/\\S*$" }),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 60, pattern: "^[a-z0-9][a-z0-9_-]*$" })),
        }),
        { maxItems: 20 },
      ),
    ),
    /** Replaces the image's CMD (its entrypoint stays), for images that need arguments such as "server /data". */
    command: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100 })),
    /** .env text, as the Environment tab saves it. */
    env: Type.Optional(Type.String({ maxLength: 100_000 })),
    deployNow: Type.Optional(Type.Boolean({ default: true })),
  }),
  output: ServiceDetail,
  permission: permission.project("services.create", projectScope),
  sensitive: { input: ["env"] },
  mcp: true,
  audit: true,
});

/** The image reference a service pulls: "nginx:1.27", "louislam/uptime-kuma:2". */
export function imageRef(repository: string, tag: string): string {
  return `${repository.replace(/^library\//, "")}:${tag}`;
}
