// Demo data for visual checks and screenshots (the landing page hero, the
// design comparison). It mirrors the approved boards: three nodes, three
// projects, a deploy in progress. Only screens.spec.ts uses it (through
// demo/routes.ts), by answering op requests in the browser; the smoke spec never does.

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;
const gb = 1024 ** 3;
const mb = 1024 ** 2;

export const ids = {
  de: "nodedefsn1000001",
  us: "nodeusash1000002",
  il: "nodeiltlv1000003",
  acme: "projacmeshop0001",
  personal: "projpersonal0002",
  panel: "projpanel0000003",
  web: "svcweb000000001a",
  api: "svcapi000000002a",
  db: "svcdb0000000003a",
  redis: "svcredis00000004",
  worker: "svcworker0000005",
  blog: "svcblog000000006",
  uptime: "svcuptime0000007",
  panelSvc: "svcpanel00000008",
  registry: "svcregistry00009",
} as const;

const nodeBase = {
  publicIpv6: null,
  maxParallelBuilds: 2,
  parallelBuildsAuto: false,
  gamesFirstCpu: false,
  lastSeenAt: iso(5_000),
  createdAt: iso(40 * day),
  updatedAt: iso(day),
  canBuildWarning: null,
};

function facts(hostname: string, cores: number, memory: number, disk: number) {
  return {
    hostname,
    os: "ubuntu 24.04",
    kernel: "6.8.0-48-generic",
    arch: "amd64",
    cpuCores: cores,
    memoryTotalBytes: memory,
    diskTotalBytes: disk,
    diskFreeBytes: disk * 0.55,
    dockerVersion: "29.0.1",
    cgroupVersion: 2,
    bootTime: iso(12 * day),
  };
}

function usage(cpu: number, memUsed: number, memTotal: number, diskUsed: number, diskTotal: number, net: number) {
  return {
    at: iso(4_000),
    cpuPercent: cpu,
    memoryUsedBytes: memUsed,
    memoryTotalBytes: memTotal,
    diskUsedBytes: diskUsed,
    diskTotalBytes: diskTotal,
    networkRxBytesPerSec: net * 0.6,
    networkTxBytesPerSec: net * 0.4,
    load1: cpu / 25,
  };
}

export const nodes = [
  {
    ...nodeBase,
    id: ids.de,
    name: "de-fsn-1",
    location: "Falkenstein, Germany",
    tags: [],
    status: "online",
    isPanelNode: true,
    publicIpv4: "203.0.113.10",
    wildcardDomain: "de1.example.com",
    agentVersion: "0.9.4",
    updateAvailable: false,
    canBuild: true,
    wings: { detected: false, version: null, sharedProxy: false },
    facts: facts("de-fsn-1", 8, 16 * gb, 240 * gb),
    // The agent's own Docker check found nothing newer (added in 0.2.5).
    docker: { version: "29.0.1", latest: "29.0.1", updateAvailable: false, checkedAt: iso(2 * hour), reason: null },
    usage: usage(23, 6.2 * gb, 16 * gb, 98 * gb, 240 * gb, 4.1 * mb),
    serviceCount: 6,
    health: { checkedAt: iso(2 * hour), worst: "pass" },
  },
  {
    ...nodeBase,
    id: ids.us,
    name: "us-ash-1",
    location: "Ashburn, United States",
    tags: [],
    status: "online",
    isPanelNode: false,
    publicIpv4: "198.51.100.7",
    wildcardDomain: "us1.example.com",
    agentVersion: "0.9.4",
    updateAvailable: false,
    canBuild: false,
    canBuildWarning: "too small",
    wings: { detected: false, version: null, sharedProxy: false },
    facts: facts("us-ash-1", 2, 8 * gb, 80 * gb),
    // A newer Docker Engine is there; il-tlv-1's older agent reports nothing.
    docker: { version: "29.0.1", latest: "29.0.2", updateAvailable: true, checkedAt: iso(5 * hour), reason: null },
    usage: usage(12, 2.4 * gb, 8 * gb, 17.6 * gb, 80 * gb, 0.8 * mb),
    serviceCount: 3,
    health: { checkedAt: iso(3 * hour), worst: "warn" },
  },
  {
    ...nodeBase,
    id: ids.il,
    name: "il-tlv-1",
    location: "Tel Aviv, Israel",
    tags: ["games"],
    status: "online",
    isPanelNode: false,
    publicIpv4: "192.0.2.44",
    wildcardDomain: "il1.example.com",
    agentVersion: "0.9.3",
    updateAvailable: true,
    canBuild: true,
    gamesFirstCpu: true,
    wings: { detected: true, version: "1.11.13", sharedProxy: true },
    facts: facts("il-tlv-1", 16, 64 * gb, 960 * gb),
    usage: usage(64, 48 * gb, 64 * gb, 682 * gb, 960 * gb, 12.6 * mb),
    serviceCount: 0,
    health: { checkedAt: iso(day), worst: "pass" },
  },
];

/** A smooth, deterministic wave so the graphs look alive and stay the same between runs. */
function wave(seed: number, base: number, swing: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const x = i / 4;
    return Math.max(0, base + swing * (Math.sin(x + seed) * 0.6 + Math.sin(x * 2.3 + seed * 2) * 0.3 + Math.sin(x * 0.7 + seed) * 0.4));
  });
}

/** Per node: wave seed, CPU %, CPU swing, memory in use, network bytes per second. */
const shapes: Record<string, [number, number, number, number, number]> = {
  [ids.de]: [1, 23, 3, 6.2 * gb, 4.1 * mb],
  [ids.us]: [2, 12, 2, 2.4 * gb, 0.8 * mb],
  [ids.il]: [3, 61, 4, 47 * gb, 12.6 * mb],
};

/**
 * One node's usage at a moment of the Live graphs, a smooth function of
 * the time (a swing about every two minutes): the panel's 10-second
 * points (range live) and the 2-second samples on node-live:<id> both
 * come from it, so they join up.
 */
export function liveUsage(nodeId: string, t: number) {
  const node = nodes.find((n) => n.id === nodeId) ?? (nodes[0] as (typeof nodes)[number]);
  const [seed, cpu, cpuSwing, mem, net] = shapes[node.id] as [number, number, number, number, number];
  const x = t / 20_000;
  const w = (s: number, base: number, swing: number) =>
    Math.max(0, base + swing * (Math.sin(x + s) * 0.6 + Math.sin(x * 2.3 + s * 2) * 0.3 + Math.sin(x * 0.7 + s) * 0.4));
  const network = w(seed + 2, net, net * 0.35);
  return {
    t,
    cpuPercent: w(seed, cpu, cpuSwing * 2),
    memoryUsedBytes: Math.round(w(seed + 1, mem, mem * 0.03)),
    memoryTotalBytes: node.usage.memoryTotalBytes,
    networkRxBytesPerSec: network * 0.6,
    networkTxBytesPerSec: network * 0.4,
  };
}

export function metricsNodes(range = "1h") {
  if (range === "live") {
    // The last 5 minutes at 10 s, up to now (not the module's load time: a run takes minutes).
    const end = Math.floor(Date.now() / 10_000) * 10_000;
    return {
      range,
      stepSeconds: 10,
      nodes: nodes.map((node) => ({
        nodeId: node.id,
        name: node.name,
        online: true,
        latest: node.usage,
        points: Array.from({ length: 30 }, (_, i) => ({ ...liveUsage(node.id, end - (29 - i) * 10_000), diskUsedBytes: node.usage.diskUsedBytes })),
      })),
    };
  }
  const count = 60;
  const step = range === "1h" ? 60 : range === "24h" ? 1440 : 10080;
  const start = Math.floor(now / 60_000) * 60_000 - count * step * 1000;
  return {
    range,
    stepSeconds: step,
    nodes: nodes.map((node) => {
      const [seed, cpu, cpuSwing, mem, net] = shapes[node.id] as [number, number, number, number, number];
      const cpuValues = wave(seed, cpu, cpuSwing, count);
      const memValues = wave(seed + 1, mem, mem * 0.02, count);
      const netValues = wave(seed + 2, net, net * 0.35, count);
      return {
        nodeId: node.id,
        name: node.name,
        online: true,
        latest: node.usage,
        points: cpuValues.map((value, i) => ({
          t: start + i * step * 1000,
          cpuPercent: value,
          memoryUsedBytes: Math.round(memValues[i] ?? 0),
          memoryTotalBytes: node.usage.memoryTotalBytes,
          diskUsedBytes: node.usage.diskUsedBytes,
          networkRxBytesPerSec: (netValues[i] ?? 0) * 0.6,
          networkTxBytesPerSec: (netValues[i] ?? 0) * 0.4,
        })),
      };
    }),
  };
}

function project(id: string, name: string, serviceCount: number, nodeCount: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: "",
    protected: false,
    serviceCount,
    nodeCount,
    guestCount: 0,
    networkName: `seylo-p-${id}`,
    collapsed: false,
    dashboardCollapsed: false,
    position: null,
    imageUrl: null,
    createdAt: iso(30 * day),
    updatedAt: iso(day),
    ...extra,
  };
}

export const projects = [
  project(ids.acme, "acme-shop", 5, 2, { guestCount: 2, position: 0 }),
  project(ids.personal, "personal", 2, 1, { position: 1 }),
  project(ids.panel, "Panel", 2, 1, { protected: true, position: 2, collapsed: true, dashboardCollapsed: true }),
];

type Kind = "app" | "postgres" | "redis";

function service(
  id: string,
  projectId: string,
  name: string,
  kind: Kind,
  status: string,
  source: { type: string; label: string; branch: string | null; builder: string | null },
  address: string | null,
  nodeId: string,
  cpu: number | null,
  memory: number | null,
  live: { label: string; ago: number } | null,
  extra: Record<string, unknown> = {},
) {
  const node = nodes.find((n) => n.id === nodeId);
  return {
    id,
    projectId,
    name,
    kind,
    parentId: null,
    status,
    buildWaiting: false,
    source,
    address,
    placements: [{ nodeId, nodeName: node?.name ?? "", replicas: 1 }],
    cpuPercent: cpu,
    memoryBytes: memory,
    memoryLimitBytes: null,
    liveDeployment: live ? { id: `dep${id.slice(3)}`.slice(0, 16), label: live.label, createdAt: iso(live.ago) } : null,
    lastDeployedAt: live ? iso(live.ago) : null,
    protected: false,
    templateSlug: null,
    createdAt: iso(12 * day),
    updatedAt: iso(hour),
    ...extra,
  };
}

const gh = (label: string, builder: string) => ({ type: "github", label, branch: "main", builder });
const img = (label: string) => ({ type: "image", label, branch: null, builder: null });
const dbSrc = (label: string) => ({ type: "database", label, branch: null, builder: null });

export const services: Record<string, unknown[]> = {
  [ids.acme]: [
    service(ids.web, ids.acme, "web", "app", "running", gh("acme/shop-web", "railpack"), "shop.example.com", ids.de, 4, 182 * mb, {
      label: "a1c9e2f",
      ago: 2 * hour,
    }),
    service(ids.api, ids.acme, "api", "app", "running", gh("acme/shop-api", "dockerfile"), "api.de1.example.com", ids.de, 7, 241 * mb, {
      label: "7f02b1d",
      ago: 3 * min,
    }),
    service(ids.db, ids.acme, "db", "postgres", "running", dbSrc("postgres:17"), "db:5432", ids.de, 2, 96 * mb, null),
    service(ids.redis, ids.acme, "redis", "redis", "running", dbSrc("redis:7.4"), "redis:6379", ids.de, 1, 12 * mb, null),
    service(ids.worker, ids.acme, "worker", "app", "building", gh("acme/shop-worker", "railpack"), null, ids.us, null, null, null),
  ],
  [ids.personal]: [
    service(ids.blog, ids.personal, "blog", "app", "running", { type: "upload", label: "blog.tar.gz", branch: null, builder: "dockerfile" }, "blog.us1.example.com", ids.us, 1, 64 * mb, {
      label: "upload",
      ago: day,
    }),
    service(ids.uptime, ids.personal, "uptime", "app", "running", img("louislam/uptime-kuma:2.0"), "status.example.com", ids.us, 1, 88 * mb, {
      label: "2.0",
      ago: 5 * day,
    }, { templateSlug: "uptime-kuma" }),
  ],
  [ids.panel]: [
    service(ids.panelSvc, ids.panel, "panel", "app", "running", img("seylo/panel:0.9.4"), "panel.example.com", ids.de, 2, 118 * mb, {
      label: "0.9.4",
      ago: 3 * day,
    }, { protected: true }),
    service(ids.registry, ids.panel, "registry", "app", "running", img("distribution 3.0"), null, ids.de, 0.2, 21 * mb, {
      label: "3.0",
      ago: 12 * day,
    }, { protected: true }),
  ],
};

const deNode = { id: ids.de, name: "de-fsn-1" };
const usNode = { id: ids.us, name: "us-ash-1" };

function recent(
  id: string,
  serviceId: string,
  projectId: string,
  serviceName: string,
  status: string,
  ago: number,
  node: { id: string; name: string },
  version: { sha?: string; image?: string },
) {
  return {
    id,
    serviceId,
    projectId,
    serviceName,
    generation: 1,
    status,
    live: status === "live",
    trigger: version.sha ? "push" : "manual",
    actor: null,
    commit: version.sha ? { sha: version.sha.padEnd(40, "0"), message: "", branch: "main", author: null } : null,
    source: version.sha ? "main" : null,
    builder: null,
    builtOn: version.sha ? node : null,
    buildWait: null,
    shippedTo: [node],
    image: version.image ? { reference: version.image, digest: null, sizeBytes: null, shippedBytes: null } : null,
    steps: [],
    durationMs: null,
    canRollback: false,
    rollbackOf: null,
    error: null,
    createdAt: iso(ago),
    startedAt: iso(ago),
    finishedAt: status === "building" ? null : iso(ago),
  };
}

export const recentDeployments = {
  deployments: [
    recent("deploy0000000001", ids.worker, ids.acme, "worker", "building", 0, usNode, { sha: "c3d41aa" }),
    recent("deploy0000000002", ids.api, ids.acme, "api", "live", 3 * min, deNode, { sha: "7f02b1d" }),
    recent("deploy0000000003", ids.web, ids.acme, "web", "live", 2 * hour, deNode, { sha: "a1c9e2f" }),
    recent("deploy0000000004", ids.blog, ids.personal, "blog", "live", day, usNode, {}),
    recent("deploy0000000005", ids.uptime, ids.personal, "uptime", "live", 5 * day, usNode, { image: "louislam/uptime-kuma:2.0" }),
  ],
};

export const alerts = {
  alerts: [
    {
      id: "alert00000000001",
      event: "service.crashed",
      severity: "warning",
      title: "worker crashed",
      message: "Exit 137, out of memory - restarted after 5s",
      projectId: ids.acme,
      serviceId: ids.worker,
      nodeId: ids.us,
      link: null,
      resolvedAt: null,
      muted: false,
      createdAt: iso(40 * min),
    },
    {
      id: "alert00000000002",
      event: "domain.live",
      severity: "info",
      title: "shop.example.com is live",
      message: "IP:port access closed automatically",
      projectId: ids.acme,
      serviceId: ids.web,
      nodeId: null,
      link: null,
      resolvedAt: null,
      muted: false,
      createdAt: iso(3 * hour),
    },
    {
      id: "alert00000000003",
      event: "node.online",
      severity: "ok",
      title: "us-ash-1 back online",
      message: "Was offline for 2 min",
      projectId: null,
      serviceId: null,
      nodeId: ids.us,
      link: null,
      resolvedAt: iso(5 * hour),
      muted: false,
      createdAt: iso(5 * hour),
    },
  ],
  nextCursor: null,
};

export const updateStatus = {
  autoUpdate: true,
  channel: "stable",
  canChangeChannel: true,
  panel: {
    currentVersion: "0.9.4",
    latestVersion: "0.9.4",
    updateAvailable: false,
    offeredVersion: null,
    latestIsPrerelease: false,
    changelogUrl: "https://seylo.dev/changelog",
  },
  lastCheckedAt: iso(hour),
  checkError: null,
  nodes: nodes.map((node) => ({ nodeId: node.id, name: node.name, online: true, version: node.agentVersion, updateAvailable: node.updateAvailable })),
  activeRun: {
    id: "run0000000000001",
    targetVersion: "0.9.4",
    trigger: "auto",
    status: "running",
    startedBy: null,
    error: null,
    createdAt: iso(10 * min),
    finishedAt: null,
    doneSteps: 2,
    totalSteps: 3,
    steps: [],
  },
};

const tpl = (slug: string, name: string, category: string, description: string, creates: string) => ({
  slug,
  name,
  description,
  category,
  tags: [],
  logoUrl: null,
  creates,
  builtIn: true,
});

export const templates = {
  templates: [
    tpl("n8n", "n8n", "Automation", "Workflow automation with a visual editor.", "App + Postgres"),
    tpl("plausible", "Plausible", "Analytics", "Simple, privacy-friendly site analytics.", "Compose · 3 services"),
    tpl("umami", "Umami", "Analytics", "Lightweight web analytics without cookies.", "App + Postgres"),
    tpl("uptime-kuma", "Uptime Kuma", "Monitoring", "Uptime checks with status pages and alerts.", "App"),
    tpl("ghost", "Ghost", "CMS", "Publishing platform for blogs and newsletters.", "App + MySQL"),
    tpl("gitea", "Gitea", "Developer tools", "Lightweight self-hosted Git service.", "App + Postgres"),
    tpl("minio", "MinIO", "Storage", "S3-compatible object storage.", "App"),
    tpl("metabase", "Metabase", "Analytics", "Dashboards and questions on your data.", "App + Postgres"),
    tpl("directus", "Directus", "CMS", "Headless CMS and API on any SQL database.", "App + Postgres"),
    tpl("mailpit", "Mailpit", "Developer tools", "Catch and inspect outgoing emails.", "App"),
    tpl("meilisearch", "Meilisearch", "Developer tools", "Fast, typo-tolerant search engine.", "App"),
    tpl("supabase", "Supabase", "Databases", "Postgres with auth, storage and realtime APIs.", "Compose · 9 services"),
  ],
  categories: ["Automation", "Analytics", "Monitoring", "Storage", "CMS", "Developer tools"],
};

export const n8nDetail = {
  ...templates.templates[0],
  body: "Workflow automation with a visual editor and 400+ integrations. Self-hosted, your data stays on your node.",
  links: [
    { label: "Website", url: "https://n8n.io" },
    { label: "Docs", url: "https://docs.n8n.io" },
    { label: "GitHub", url: "https://github.com/n8n-io/n8n" },
  ],
  fields: [
    {
      key: "version",
      label: "Version",
      description: null,
      type: "select",
      required: true,
      default: "2.21.0",
      options: [
        { value: "2.21.0", label: "2.21.0 (latest)" },
        { value: "2.18.7", label: "2.18.7" },
      ],
    },
    { key: "domain", label: "Domain", description: null, type: "domain", required: false, default: null, options: [] },
  ],
};

export const n8nPreview = {
  services: [
    {
      name: "n8n",
      kind: "app",
      image: "n8nio/n8n:2.21.0",
      ports: [5678],
      internalOnly: false,
      domains: ["n8n.de1.example.com"],
      envKeys: [],
      volumes: [],
      conflict: false,
    },
    { name: "n8n-db", kind: "postgres", image: "postgres:17", ports: [5432], internalOnly: true, domains: [], envKeys: [], volumes: [], conflict: false },
  ],
  warnings: [],
};

export const healthReport = {
  nodeId: ids.us,
  checkedAt: iso(3 * hour),
  summary: { pass: 7, warn: 1, fail: 1, skipped: 1 },
  results: [
    { id: "docker.reachable", title: "Docker is reachable", status: "pass", detail: "Docker 29.0.1, cgroup v2", fixHint: "" },
    { id: "disk.free", title: "Free disk space", status: "warn", detail: "12% free on /var/lib/seylo", fixHint: "Run a cleanup in Settings > Cleanup or grow the disk." },
    { id: "ports.443", title: "Port 443 is reachable", status: "fail", detail: "Connection from the panel timed out", fixHint: "Open TCP 443 in the provider's firewall and in ufw: ufw allow 443/tcp" },
    { id: "clock.sync", title: "Clock is in sync", status: "pass", detail: "Off by 12 ms", fixHint: "" },
    { id: "dns.resolve", title: "DNS works", status: "pass", detail: "Resolves github.com and the panel", fixHint: "" },
    { id: "wings.coexist", title: "Wings", status: "skipped", detail: "Wings is not installed here", fixHint: "" },
  ],
};

export function nodeDetail(nodeId: string) {
  const node = nodes.find((n) => n.id === nodeId) ?? nodes[0];
  const placed = Object.values(services)
    .flat()
    .filter((s) => (s as { placements: { nodeId: string }[] }).placements[0]?.nodeId === node?.id) as {
    id: string;
    name: string;
    projectId: string;
  }[];
  return {
    ...node,
    capabilities: ["state.sync.v1", "logs.follow.v1", "logs.search.v1", "metrics.read.v1", "terminal.console.v1", "terminal.shell.v1", "fs.basic.v1"],
    logRetention: { maxBytesPerService: 100 * mb, maxAgeDays: 14 },
    services: placed.map((s) => ({
      serviceId: s.id,
      serviceName: s.name,
      projectId: s.projectId,
      projectName: projects.find((p) => p.id === s.projectId)?.name ?? "",
      replicas: 1,
      phase: "running",
    })),
    desiredRevision: 42,
    appliedRevision: 42,
    // The panel node dials loopback; the others moved to the panel's domain.
    panelAddress: node?.status === "offline" ? null : node?.isPanelNode ? "http://127.0.0.1:3000" : "https://panel.acme.dev",
  };
}

export function metricsNode(nodeId: string, range = "1h") {
  const all = metricsNodes(range);
  return { range, stepSeconds: all.stepSeconds, series: all.nodes.find((n) => n.nodeId === nodeId) ?? all.nodes[0] };
}

/**
 * Generated faces of the demo people, drawn by the real panel the run
 * started (/api/avatars/<style>/<seed>.svg). The contractor has none, so the
 * initials show.
 */
export const avatars = {
  owner: "/api/avatars/notionists/acme-owner.svg",
  lee: "/api/avatars/lorelei/lee-park.svg",
  intern: "/api/avatars/notionists/former-intern.svg",
};

export const viewer = { id: "user000000000001", email: "you@example.com", name: "", role: "owner", avatarUrl: avatars.owner };

export const systemInfo = { name: "Seylo", version: "0.9.4", panelId: "demo", startedAt: iso(3 * day), nodes: { total: 3, online: 3 } };

/** The node sheet's Cleanup view: a daily schedule with a disk line, and a few runs. */
export function cleanupSchedule(nodeId: string) {
  return {
    nodeId,
    schedule: {
      enabled: true,
      cron: "0 4 * * *",
      diskPercent: 80,
      kinds: { images: true, buildCache: true, stoppedContainers: true, unusedVolumes: false },
    },
    timeZone: "Europe/Berlin",
    nextRunAt: iso(-9 * hour),
    supported: true,
  };
}

export function cleanupRuns(nodeId: string) {
  const run = (id: string, msAgo: number, extra: Record<string, unknown>) => ({
    id,
    nodeId,
    status: "succeeded",
    error: null,
    lines: [],
    diskPercent: null,
    startedBy: null,
    startedAt: iso(msAgo),
    finishedAt: iso(msAgo - 40_000),
    ...extra,
  });
  return {
    runs: [
      run("cleanuprun000001", 5 * hour, {
        trigger: "schedule",
        bytesFreed: 3.2 * gb,
        removedCount: 3,
        lines: [
          "image registry/acme/api:41 (1.4 GiB): older than the newest 3",
          "image registry/acme/web:17 (1.1 GiB): older than the newest 3",
          "container seylo-svcworker0000005-11 (12.0 MiB): old generation 11",
        ],
      }),
      run("cleanuprun000002", 2 * day, { trigger: "disk", diskPercent: 87, bytesFreed: 6.8 * gb, removedCount: 9 }),
      run("cleanuprun000003", 4 * day, { trigger: "manual", startedBy: "you@example.com", bytesFreed: 412 * mb, removedCount: 2 }),
      run("cleanuprun000004", 6 * day, {
        trigger: "schedule",
        status: "failed",
        error: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        bytesFreed: 0,
        removedCount: 0,
      }),
    ],
    bytesFreed30d: 10.4 * gb,
  };
}

/** The node sheet's Shell view: allowed on the node, one shell open. */
export function hostShellStatus(nodeId: string) {
  return {
    nodeId,
    enabled: true,
    available: true,
    canOpen: true,
    canEnable: true,
    maxSessions: 2,
    idleTimeoutSeconds: 900,
    sessions: [{ id: "hostsession00001", userId: viewer.id, openedBy: "you@example.com", openedAt: iso(4 * min) }],
  };
}
