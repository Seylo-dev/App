// Demo answers for the Docker Hub tab and the image form: a gitea search,
// gitea's newest tags (28.3.0 is the version latest points at) and image
// configs shaped like what dockerHub.inspect reads from the registry.

type Input = Record<string, any>;

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const hour = 3_600_000;
const day = 24 * hour;
const digest = (c: string) => `sha256:${c.repeat(64)}`;

const result = (repository: string, publisher: string, badge: string, pullCount: number, stars: number, description: string) => ({
  repository,
  publisher,
  description,
  pullCount,
  stars,
  badge,
  updatedAt: ago(2 * day),
  architectures: ["amd64", "arm64"],
});

const giteaResults = [
  result("bitnamicharts/gitea", "VMware", "verified", 1_065_102, 0, "Bitnami Helm chart for Gitea"),
  result("sbx/gitea", "Docker, Inc", "verified", 2_845, 0, "Gitea in a sandbox"),
  result("gitea/gitea", "gitea", "none", 393_711_408, 1_190, "Git with a cup of tea - A painless self-hosted Git service."),
  result("vulhub/gitea", "VulHub", "openSource", 12_730, 1, "Gitea images for vulnerability research"),
  result("gitea/act_runner", "gitea", "none", 11_233_048, 64, "A runner for Gitea Actions"),
];

const platforms = [
  { platform: "linux/amd64", sizeBytes: 64_000_000 },
  { platform: "linux/arm64", sizeBytes: 61_000_000 },
];

const tag = (name: string, d: string, ageMs: number) => ({ name, digest: d, updatedAt: ago(ageMs), platforms });

const giteaTags = [
  tag("main-nightly-rootless", digest("1"), 6 * hour),
  tag("main-nightly", digest("2"), 6 * hour),
  tag("latest-rootless", digest("3"), 5 * day),
  tag("28.3.0-rootless", digest("3"), 5 * day),
  tag("latest", digest("8"), 5 * day),
  tag("28.3", digest("8"), 5 * day),
  tag("28", digest("8"), 5 * day),
  tag("28.3.0", digest("8"), 5 * day),
  tag("28.2.0", digest("4"), 19 * day),
  tag("1.22.6", digest("5"), 80 * day),
];

function config(repository: string, tagName: string, arch: string) {
  const gitea = repository === "gitea/gitea";
  return {
    repository,
    tag: tagName,
    digest: gitea && tagName === "28.3.0" ? digest("8") : digest("9"),
    platform: `linux/${arch}`,
    platforms: ["linux/amd64", "linux/arm64"],
    ports: gitea
      ? [
          { port: 22, protocol: "tcp" },
          { port: 3000, protocol: "tcp" },
        ]
      : [{ port: 3001, protocol: "tcp" }],
    volumes: gitea ? ["/data"] : ["/app/data"],
    env: [
      { name: "PATH", value: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      { name: "USER", value: "git" },
      { name: gitea ? "GITEA_CUSTOM" : "APP_DATA", value: gitea ? "/data/gitea" : "/app/data" },
      { name: "SECRET_KEY", value: "changeme" },
    ],
    entrypoint: gitea ? ["/usr/bin/entrypoint"] : ["/usr/bin/dumb-init", "--"],
    cmd: gitea ? ["/usr/bin/s6-svscan", "/etc/s6"] : ["node", "server/server.js"],
    user: "",
    workingDir: "/",
    healthcheck: gitea
      ? null
      : { test: ["CMD-SHELL", "extra/healthcheck"], intervalSeconds: 60, timeoutSeconds: 30, startPeriodSeconds: 180, retries: 5 },
    labels: [{ name: "org.opencontainers.image.source", value: `https://github.com/${repository}` }],
    createdAt: ago(5 * day),
    private: false,
  };
}

export const handlers: Record<string, (input: Input) => unknown> = {
  "dockerHub.search": (input) => {
    const query = String(input.query ?? "").toLowerCase();
    const results = giteaResults.filter((r) => r.repository.includes(query) || query === "git");
    return { results: Number(input.page ?? 1) === 1 ? results : [], page: Number(input.page ?? 1), hasMore: false };
  },
  "dockerHub.tags": (input) => {
    const filter = String(input.filter ?? "");
    const tags = giteaTags.filter((t) => t.name.includes(filter));
    return { tags, suggested: filter ? null : "28.3.0", page: 1, hasMore: false };
  },
  "dockerHub.inspect": (input) => config(String(input.repository), String(input.tag), String(input.arch ?? "amd64")),
};
