// Demo data for the service and database screens (every tab), in the same
// world as fixtures.ts: the acme-shop project on de-fsn-1 and us-ash-1.
// Shaped like the op contracts; Playwright transpiles this file without type
// checks, so the data is loosely typed.

import { ids as world } from "./fixtures";

type Input = Record<string, any>;

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;

export const ids = {
  project: world.acme,
  api: world.api,
  worker: world.worker,
  db: world.db,
  redis: world.redis,
  web: world.web,
  stack: "svcmonitoring0a6",
  // Not in the project list: opened by its URL only (databases.spec.ts, the connection screen).
  clickhouse: "svcevents0000c01",
  // Not in the project list either (console.spec.ts): a plain git URL to a private
  // GitHub repo with no credential, whose only deploy failed at Clone, so nothing runs.
  privateApi: "svcprivapi0000d1",
  box: "svcbox000000000a",
  cron: "svcreports00000b",
  nodeDe: world.de,
  nodeUs: world.us,
};

const de = { id: ids.nodeDe, name: "de-fsn-1" };
const us = { id: ids.nodeUs, name: "us-ash-1" };

const baseService = (over: Input) => ({
  projectId: ids.project,
  parentId: null,
  status: "running",
  source: { type: "github", label: "acme/shop-api", branch: "main", builder: "railpack" },
  address: null,
  placements: [{ nodeId: de.id, nodeName: de.name, replicas: 1 }],
  cpuPercent: 7,
  memoryBytes: 241_000_000,
  memoryLimitBytes: null,
  liveDeployment: { id: "d000000000000001", label: "7f02b1d", createdAt: ago(2 * hour) },
  lastDeployedAt: ago(2 * hour),
  protected: false,
  templateSlug: null,
  createdAt: ago(30 * day),
  updatedAt: ago(hour),
  stopped: false,
  generation: 42,
  sourceConfig: { type: "github", installationId: "i000000000000001", repo: "acme/shop-api", branch: "main", deployOnPush: true },
  build: {
    builder: "railpack",
    contextPath: "",
    dockerfilePath: "Dockerfile",
    inlineDockerfile: null,
    targetStage: "",
    buildNodeId: null,
    startCommand: "",
    installCommand: "",
    buildCommand: "",
  },
  container: { command: [], entrypoint: [], workingDir: "", user: "", stopSignal: "", stopGraceSeconds: 10 },
  ports: [{ containerPort: 3000, protocol: "tcp" }],
  healthCheck: {
    probe: { type: "http", port: 3000, path: "/health", host: "", expectedStatus: 0 },
    intervalSeconds: 5,
    timeoutSeconds: 3,
    startPeriodSeconds: 10,
    failureThreshold: 3,
  },
  crashPolicy: { restart: true, stopAfterCrashes: 0 },
  restartDelaySeconds: 5,
  resources: { memoryLimitBytes: null, memoryReservationBytes: null, cpuWeight: null, pidsLimit: null },
  deploy: { mode: "rolling", healthTimeoutSeconds: 60 },
  cron: null,
  stickySessions: false,
  entryNodeId: null,
  notes: "## Runbook\n\n- Stripe webhooks retry 5 times.\n- `cache:stats` in the console prints cache hits.\n",
  members: [],
  volumes: [
    { id: "v000000000000001", name: "uploads", mountPath: "/app/uploads", kind: "volume", readOnly: false, sharedWith: [] },
    { id: "v000000000000002", name: "config.yml", mountPath: "/app/config.yml", kind: "file", readOnly: true, sharedWith: [] },
  ],
  watchPaths: [],
  ...over,
});

export const servicesById = {
  [ids.api]: baseService({ id: ids.api, name: "api", kind: "app", address: "api.de1.example.com" }),
  [ids.worker]: baseService({
    id: ids.worker,
    name: "worker",
    kind: "app",
    status: "deploying",
    ports: [],
    source: { type: "github", label: "acme/shop-worker", branch: "main", builder: "railpack" },
    sourceConfig: { type: "github", installationId: "i000000000000001", repo: "acme/shop-worker", branch: "main", deployOnPush: true },
    placements: [{ nodeId: us.id, nodeName: us.name, replicas: 1 }],
    liveDeployment: { id: "d000000000000011", label: "3b8d2aa", createdAt: ago(2 * hour) },
  }),
  [ids.db]: baseService({
    id: ids.db,
    name: "db",
    kind: "postgres",
    source: { type: "database", label: "postgres:17", branch: null, builder: null },
    sourceConfig: { type: "image", image: "postgres:17.6", registryId: null },
    ports: [{ containerPort: 5432, protocol: "tcp" }],
    address: "db:5432",
    liveDeployment: null,
  }),
  [ids.redis]: baseService({ id: ids.redis, name: "redis", kind: "redis", address: "redis:6379" }),
  [ids.clickhouse]: baseService({
    id: ids.clickhouse,
    name: "events",
    kind: "clickhouse",
    source: { type: "database", label: "clickhouse/clickhouse-server:26.8.36.3", branch: null, builder: null },
    sourceConfig: { type: "image", image: "clickhouse/clickhouse-server:26.8.36.3", registryId: null },
    ports: [{ containerPort: 9000, protocol: "tcp" }],
    address: "events:9000",
    liveDeployment: null,
  }),
  [ids.privateApi]: baseService({
    id: ids.privateApi,
    name: "private-api",
    kind: "app",
    status: "idle",
    source: { type: "git", label: "github.com/acme/private-api", branch: "main", builder: "railpack" },
    sourceConfig: { type: "git", url: "https://github.com/acme/private-api.git", branch: "main", credentialId: null, deployOnPush: false },
    cpuPercent: null,
    memoryBytes: null,
    liveDeployment: null,
    lastDeployedAt: null,
    generation: 1,
  }),
  [ids.web]: baseService({ id: ids.web, name: "web", kind: "app", address: "shop.example.com" }),
  [ids.box]: baseService({ id: ids.box, name: "box", kind: "box", ports: [], liveDeployment: null }),
  [ids.cron]: baseService({
    id: ids.cron,
    name: "reports",
    kind: "cron",
    ports: [],
    cron: { schedule: "0 6 * * 1-5", timeZone: "Europe/Berlin", command: ["bun", "run", "reports"], timeoutSeconds: 900, concurrency: "forbid" },
  }),
  [ids.stack]: baseService({
    id: ids.stack,
    name: "monitoring",
    kind: "compose",
    source: { type: "compose", label: "compose.yml", branch: null, builder: null },
    members: [
      { id: "s000000000000007", name: "grafana", status: "running" },
      { id: "s000000000000008", name: "prometheus", status: "unhealthy" },
    ],
  }),
};

const step = (key: string, status: string, node: unknown, detail: string, durationMs: number | null) => ({ key, status, node, detail, durationMs });

const deployments = [
  {
    id: "d000000000000010",
    serviceId: ids.worker,
    generation: 18,
    status: "building",
    live: false,
    trigger: "push",
    actor: "octo-dev",
    commit: { sha: "9c41e07aa", message: "Retry failed webhooks", branch: "main", author: "octo-dev" },
    source: "main",
    builder: "railpack",
    builtOn: de,
    shippedTo: [us],
    image: null,
    steps: [
      step("clone", "ok", null, "main at 9c41e07", 2000),
      step("build", "running", de, "", null),
      step("ship", "pending", us, "", null),
      step("health", "pending", null, "", null),
      step("switch", "pending", null, "", null),
    ],
    durationMs: null,
    canRollback: false,
    rollbackOf: null,
    error: null,
    createdAt: ago(40_000),
    startedAt: ago(34_000),
    finishedAt: null,
  },
  ...[
    ["3b8d2aa", "Queue retries with backoff", "push", "octo-dev", 2 * hour, 38, false, true],
    ["e17f0c4", "Bump bullmq to 5.40", "push", "octo-dev", day, 12, false, false],
    ["5a2c9d1", "Switch to Bun 1.3.14", "push", "octo-dev", 2 * day, 36, true, false],
    ["c88e1f9", "Add Sentry", "manual", "you@example.com", 4 * day, 41, false, false],
    ["0f6e2b4", "Initial deploy", "manual", "you@example.com", 12 * day, 121, false, false],
  ].map(([sha, message, trigger, actor, age, mb, failed, live], i) => ({
    id: `d00000000000001${i + 1}`,
    serviceId: ids.worker,
    generation: 17 - i,
    status: failed ? "failed" : live ? "live" : "superseded",
    live,
    trigger,
    actor,
    commit: { sha: `${sha}00`, message, branch: "main", author: actor },
    source: "main",
    builder: "railpack",
    builtOn: de,
    shippedTo: [us],
    image: { reference: "registry.local/worker", digest: `sha256:4be1a9${i}7c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e07c3`, sizeBytes: 121_000_000, shippedBytes: mb * 1_000_000 },
    steps: [
      step("clone", "ok", null, `main at ${sha}`, 2000),
      step("build", "ok", de, "Railpack, 121 MB image", 41_000),
      step("ship", "ok", us, `${mb} MB`, 6000),
      failed ? step("health", "failed", null, "No answer on port 3001 in 60s", 60_000) : step("health", "ok", null, "GET /health 200 in 3s", 3000),
      failed ? step("switch", "skipped", null, "Skipped, previous version kept", null) : step("switch", "ok", null, "Old container stopped", 1000),
    ],
    durationMs: failed ? 110_000 : 53_000,
    canRollback: !live && !failed,
    rollbackOf: null,
    error: failed ? "No answer on port 3001 within 60s. The previous version stayed live." : null,
    createdAt: ago(age),
    startedAt: ago(age),
    finishedAt: ago(age - 53_000),
  })),
];

/**
 * private-api's only deploy: git could not fetch the private repository
 * (exit 128) before there was a commit, so the panel knows only the branch
 * it tried and the image it was going to push, an address in its own
 * registry relay.
 */
const cloneFailed = "fetching the source failed: could not fetch main - check the address, the branch and the credentials (exit status 128)";
export const privateApiDeploy = {
  id: "d0000000000000f1",
  serviceId: ids.privateApi,
  generation: 1,
  status: "failed",
  live: false,
  trigger: "manual",
  actor: "you@example.com",
  commit: null,
  source: "main",
  builder: "railpack",
  builtOn: de,
  shippedTo: [],
  image: { reference: `127.0.0.1:5755/${ids.privateApi}:1`, digest: null, sizeBytes: null, shippedBytes: null },
  steps: [
    step("clone", "failed", de, cloneFailed, 1400),
    step("build", "pending", de, "", null),
    step("ship", "pending", null, "", null),
    step("health", "pending", null, "", null),
    step("switch", "pending", null, "", null),
  ],
  durationMs: 2000,
  canRollback: false,
  rollbackOf: null,
  error: cloneFailed,
  createdAt: ago(5 * min),
  startedAt: ago(5 * min),
  finishedAt: ago(5 * min - 2000),
};

const logLines = (deploymentId: string) => {
  if (deploymentId === privateApiDeploy.id) {
    const t0 = Date.parse(privateApiDeploy.createdAt);
    return [
      ["clone", "Building on de-fsn-1."],
      ["clone", "Fetching https://github.com/acme/private-api.git (main)"],
      ["clone", "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
      ["clone", `\u001b[31m${cloneFailed}\u001b[0m`],
    ].map(([s, text], i) => ({ seq: i, ts: new Date(t0 + i * 400).toISOString(), step: s, text, error: i >= 2 }));
  }
  const d = deployments.find((x) => x.id === deploymentId) ?? deployments[1];
  const t0 = Date.parse(d.startedAt ?? d.createdAt);
  const raw = [
    ["clone", "acme/shop-worker@main (9c41e07) via the GitHub App"],
    ["build", "us-ash-1 cannot build, using de-fsn-1"],
    ["build", "railpack: Bun 1.3.14 detected, start: bun src/worker.ts"],
    ["build", "#6 [install] bun install --frozen-lockfile   2.8s"],
    ["build", "#8 [build] bun run build                     4.1s"],
    ["build", "#9 exporting layers                          1.2s"],
    ["build", "image sha256:61c0f2…e9a2 · 121 MB · 38 MB new"],
    ["ship", "pushing to the panel registry …"],
    ["ship", "us-ash-1 will pull 38 MB, then start generation 18"],
  ];
  if (d.status === "failed") raw.push(["health", "\u001b[31mno answer on port 3001 after 60s, giving up\u001b[0m"], ["switch", "skipped, the previous version stays live"]);
  else if (d.status !== "building") raw.push(["health", "200 OK in 3s"], ["switch", "traffic moved, previous container drained"]);
  return raw.map(([s, text], i) => ({ seq: i, ts: new Date(t0 + i * 3000).toISOString(), step: s, text, error: text.includes("giving up") }));
};

const series = (n: number, base: number, amp: number, step: number) =>
  Array.from({ length: n }, (_, i) => ({
    t: now - (n - i) * step,
    cpuPercent: Math.max(0, base + Math.sin(i / 4) * amp + Math.sin(i / 1.7) * 1.5),
    cpuPercentMax: base + amp + 10,
    memoryBytes: Math.round(220_000_000 + Math.sin(i / 6) * 20_000_000 + i * 300_000),
    memoryBytesMax: 268_000_000,
    networkRxBytesPerSec: 600_000 + Math.sin(i / 3) * 200_000,
    networkTxBytesPerSec: 400_000 + Math.cos(i / 5) * 150_000,
  }));

const envText = `# worker runs on us-ash-1
NODE_ENV=production
QUEUE_CONCURRENCY=8
DATABASE_URL=postgres://app:s3cr3tpass@db:5432/shop?sslmode=disable
API_URL=\${{api.URL}}
REDIS_URL=\${{redis.INTERNAL_URL}}
STRIPE_SECRET_KEY=sk_live_51HxQ2mAbCdEf
SENTRY_DSN=https://abc@o4507.ingest.sentry.io/4507
LOG_LEVEL=info
SMTP_HOST=\${{project.SMTP_HOST}}
`;

const refs = {
  self: { serviceId: ids.worker, name: "worker", nodes: [us] },
  targets: [
    {
      name: "db",
      kind: "service",
      serviceId: ids.db,
      serviceKind: "postgres",
      nodes: [de],
      internalHost: "db",
      exposed: true,
      variables: [
        { name: "EXPOSED_URL", value: "postgres://postgres:pw@203.0.113.10:15432/shop?sslmode=require", scope: "public", sensitive: true, description: "exposed URL" },
        { name: "EXPOSED_HOST", value: "203.0.113.10", scope: "public", sensitive: false, description: "exposed host" },
        { name: "EXPOSED_PORT", value: "15432", scope: "public", sensitive: false, description: "exposed port" },
        { name: "INTERNAL_URL", value: "postgres://postgres:pw@db:5432/shop", scope: "internal", sensitive: true, description: "internal URL" },
      ],
    },
    {
      name: "redis",
      kind: "service",
      serviceId: ids.redis,
      serviceKind: "redis",
      nodes: [de],
      internalHost: "redis",
      exposed: false,
      variables: [{ name: "INTERNAL_URL", value: "redis://redis:6379", scope: "internal", sensitive: false, description: "internal URL" }],
    },
    {
      name: "api",
      kind: "service",
      serviceId: ids.api,
      serviceKind: "app",
      nodes: [de],
      internalHost: "api",
      exposed: true,
      variables: [
        { name: "URL", value: "https://api.de1.example.com", scope: "public", sensitive: false, description: "public URL" },
        { name: "DOMAIN", value: "api.de1.example.com", scope: "public", sensitive: false, description: "domain" },
        { name: "INTERNAL_URL", value: "http://api:3000", scope: "internal", sensitive: false, description: "internal URL" },
      ],
    },
    {
      name: "project",
      kind: "shared",
      serviceId: null,
      serviceKind: null,
      nodes: [],
      internalHost: null,
      exposed: true,
      variables: [
        { name: "SMTP_HOST", value: "smtp.example.com", scope: "plain", sensitive: false, description: "" },
        { name: "SMTP_USER", value: "mailer", scope: "plain", sensitive: false, description: "" },
        { name: "SMTP_PASS", value: "pw", scope: "plain", sensitive: true, description: "" },
      ],
    },
  ],
};

const domain = (over: Input) => ({
  serviceId: ids.web,
  pathPrefix: "/",
  stripPrefix: false,
  targetPort: 3000,
  https: "acme",
  redirectToHttps: true,
  auto: false,
  primary: false,
  forward: null,
  middlewares: { basicAuth: null, ipAllowList: [], rateLimit: null, redirects: [] },
  dnsStatus: "ok",
  dnsCheckedAt: ago(min),
  // domains.list: what the records point at (the service's node).
  pointsTo: ["203.0.113.10"],
  certificate: { status: "valid", expiresAt: new Date(now + 80 * day).toISOString(), issuer: "Let's Encrypt (R11)", error: null },
  liveAt: ago(2 * day),
  createdAt: ago(10 * day),
  updatedAt: ago(day),
  ...over,
});

const domains: Input[] = [
  // Behind Cloudflare's proxy, and the panel's origin check reached the node through it.
  domain({ id: "m000000000000001", host: "shop.example.com", primary: true, url: "https://shop.example.com", dnsStatus: "proxied", origin: "node", originCheckedAt: ago(min), certificate: { status: "valid", expiresAt: new Date(now + 90 * day).toISOString(), issuer: "Cloudflare", error: null } }),
  domain({ id: "m000000000000002", host: "web.de1.example.com", auto: true, url: "https://web.de1.example.com" }),
  domain({ id: "m000000000000003", host: "www.example.com", url: "https://www.example.com", forward: { url: "https://shop.example.com", permanent: true, keepPath: true } }),
  domain({
    id: "m000000000000004",
    host: "admin.example.com",
    pathPrefix: "/admin",
    url: "https://admin.example.com/admin",
    dnsStatus: "missing",
    liveAt: null,
    // Nothing asks Let's Encrypt until the record is there (the certificate waits for DNS).
    certificate: { status: "pending", expiresAt: null, issuer: null, error: null, waitingForDns: true },
    middlewares: { basicAuth: { usernames: ["ops"] }, ipAllowList: ["198.51.100.24", "10.0.0.0/8"], rateLimit: null, redirects: [] },
  }),
  // Proxied too, but its record in Cloudflare still points at the old host: the origin check reached another server.
  domain({
    id: "m000000000000005",
    host: "api.example.com",
    url: "https://api.example.com",
    dnsStatus: "proxied",
    origin: "elsewhere",
    originCheckedAt: ago(min),
    liveAt: null,
    certificate: { status: "pending", expiresAt: null, issuer: null, error: null, waitingForDns: true },
    createdAt: ago(2 * hour),
  }),
];

/** domains.checkDns for a demo domain: what its row shows (the record to create, the origin check). */
function checkDns(input: Input) {
  const d = domains.find((x) => x.id === input.domainId) ?? domains[3];
  const name = String(d.host).replace(/\.example\.com$/, "");
  return {
    domainId: input.domainId,
    host: d.host,
    status: d.dnsStatus,
    message: d.dnsStatus === "missing" ? `No A record for ${d.host} yet` : `${d.host} is proxied by Cloudflare, so the panel cannot see where it points.`,
    expected: [{ type: "A", name, value: "203.0.113.10" }],
    found: d.dnsStatus === "proxied" ? [{ type: "A", name, value: "104.16.1.1" }] : [],
    zone: "example.com",
    cloudflareManaged: true,
    cloudflareDnsUrl: "https://dash.cloudflare.com/?to=/:account/example.com/dns",
    ...(d.origin ? { origin: d.origin } : {}),
    checkedAt: ago(min),
  };
}

const logEntries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    time: new Date(now - (n - i) * 1000).toISOString(),
    stream: i % 17 === 0 ? "stderr" : i % 23 === 0 ? "system" : "stdout",
    nodeId: de.id,
    containerId: "c0ffee",
    generation: 42,
    line: i % 17 === 0 ? `\u001b[33mwarn\u001b[0m: Stripe webhook retry ${i % 5}/5 for evt_${i}` : `GET /v1/products?page=${i % 9} 200 ${(i * 7) % 90}ms`,
  }));

const fileEntry = (name: string, isDir: boolean, size: number) => ({
  name,
  path: name,
  isDir,
  size,
  mode: isDir ? 0o755 : 0o644,
  modifiedAt: ago(3 * hour),
  symlinkTarget: null,
  uid: 1000,
  gid: 1000,
});

const run = (i: number, status: string) => ({
  id: `r00000000000000${i}`,
  kind: "backup",
  serviceId: ids.db,
  policyId: "b000000000000001",
  destinationId: "x000000000000001",
  target: "database",
  volumeId: null,
  sourceRunId: null,
  status,
  objectKey: `db/2026-11-0${5 - i}.sql.zst`,
  sizeBytes: 18_400_000 - i * 300_000,
  error: status === "failed" ? "S3 said: SignatureDoesNotMatch" : null,
  deletedAt: null,
  startedAt: ago(i * day + 3 * hour),
  finishedAt: ago(i * day + 3 * hour - 12_000),
});

export const handlers: Record<string, (input: Input) => unknown> = {
  "services.get": (input: Input) => servicesById[input.serviceId] ?? servicesById[ids.api],
  "deployments.list": (input: Input) => {
    const all: { status: string }[] =
      input.serviceId === ids.privateApi
        ? [privateApiDeploy]
        : input.serviceId === ids.worker
          ? deployments
          : deployments.slice(1).map((d, i) => ({ ...d, serviceId: input.serviceId, status: i === 0 ? "live" : d.status }));
    // active: as the panel answers it, only queued and running deploys, oldest first.
    const active = input.active === true || input.active === "true";
    return {
      deployments: active ? all.filter((d) => ["queued", "building", "deploying"].includes(d.status)).reverse() : all,
      nextCursor: null,
      keptImages: input.serviceId === ids.privateApi ? 0 : 5,
    };
  },
  "deployments.get": (input: Input) => ({
    deployment: input.deploymentId === privateApiDeploy.id ? privateApiDeploy : (deployments.find((d) => d.id === input.deploymentId) ?? deployments[1]),
    logTopic: `deployment:${input.deploymentId}`,
  }),
  "deployments.log": (input: Input) => {
    const running = deployments.find((d) => d.id === input.deploymentId)?.status === "building";
    return { lines: (input.afterSeq ?? -1) >= 0 ? [] : logLines(input.deploymentId), done: !running };
  },
  "builds.getSettings": (input: Input) => ({
    settings: servicesById[input.serviceId]?.build ?? servicesById[ids.api].build,
    nodes: [
      { id: de.id, name: de.name, canBuild: true, online: true, hasBuildx: true, queued: 1 },
      { id: us.id, name: us.name, canBuild: false, online: true, hasBuildx: true, queued: 0 },
    ],
  }),
  "metrics.service": (input: Input) => {
    const n = { live: 30, "1h": 60, "24h": 288, "7d": 168, "30d": 120 }[input.range ?? "1h"] ?? 60;
    const stepMs = { live: 10_000, "1h": 60_000, "24h": 300_000, "7d": 3_600_000, "30d": 21_600_000 }[input.range ?? "1h"] ?? 60_000;
    return {
      range: input.range ?? "1h",
      stepSeconds: stepMs / 1000,
      current: [{ nodeId: de.id, at: ago(5000), cpuPercent: 7, memoryBytes: 241_000_000, memoryLimitBytes: null, networkRxBytesPerSec: 700_000, networkTxBytesPerSec: 500_000 }],
      peakMemoryBytes: 268_000_000,
      points: series(n, 8, 4, stepMs),
    };
  },
  "env.get": () => ({ text: envText, variables: [], sharedCount: 3, updatedAt: ago(day) }),
  "env.references": () => refs,
  "env.getShared": () => ({ text: "SMTP_HOST=smtp.example.com\nSMTP_USER=mailer\nSMTP_PASS=hunter2hunter2\n", variables: [], updatedAt: ago(day) }),
  // github.installations, github.repos and github.branches: repos.ts.
  "webhooks.getTrigger": () => ({ configured: true, hint: "x9Qa", lastUsedAt: ago(3 * hour), createdAt: ago(10 * day) }),
  "webhooks.listDeliveries": () => ({
    deliveries: [
      { id: "w000000000000001", source: "github", event: "push", outcome: "deployed", detail: "main at 9c41e07", deploymentId: "d000000000000010", canRedeliver: false, receivedAt: ago(40_000) },
      { id: "w000000000000002", source: "github", event: "push", outcome: "ignored", detail: "branch dev is not deployed", deploymentId: null, canRedeliver: false, receivedAt: ago(5 * hour) },
    ],
  }),
  "domains.list": () => ({ domains, autoDomainSuggestion: null }),
  "domains.checkDns": checkDns,
  "exposures.get": () => ({
    firstRun: {
      status: "closed",
      address: "203.0.113.10:41203",
      redirectTo: "https://shop.example.com",
      closeAt: null,
      domainLiveAt: ago(2 * day),
      closeWhenDomainLive: true,
      redirectToPrimary: true,
    },
    timed: [
      {
        id: "e000000000000001",
        serviceId: ids.web,
        nodeId: de.id,
        host: "203.0.113.10",
        port: 47011,
        targetPort: 3000,
        allowedCidrs: ["198.51.100.24/32"],
        expiresAt: new Date(now + 102 * min).toISOString(),
        openedBy: { kind: "mcp", name: "Claude" },
        createdAt: ago(18 * min),
      },
    ],
    database: null,
  }),
  "tunnels.get": () => ({
    serviceId: ids.web,
    enabled: false,
    mode: "token",
    state: "off",
    targetPort: 3000,
    url: null,
    hostname: "web-dev.example.com",
    tokenSource: "global",
    expiresAt: null,
    error: null,
  }),
  "maintenance.get": () => ({ serviceId: ids.web, enabled: false, message: "", html: null, pageSource: "global", globalEnabled: false, updatedAt: null }),
  "maintenance.preview": () => ({ html: "<!doctype html><html><body style='font-family:sans-serif;display:grid;place-items:center;height:90vh'><div><h1>Back soon</h1><p>We are updating shop.</p></div></body></html>" }),
  "logs.search": (input: Input) => ({ entries: input.query ? logEntries(40).filter((e) => e.line.includes(input.query)) : logEntries(300).reverse(), nextCursor: null, offlineNodeIds: [] }),
  "files.list": (input: Input) => ({
    nodeId: de.id,
    path: input.path ?? "",
    entries: (input.path ?? "") === "" ? [fileEntry("images", true, 0), fileEntry("cache", true, 0), fileEntry("settings.json", false, 812), fileEntry("README.md", false, 2100)] : [fileEntry("logo.png", false, 48_000)],
  }),
  "files.read": (input: Input) => ({ nodeId: de.id, info: fileEntry(input.path, false, 812), encoding: "utf8", content: '{\n  "theme": "light",\n  "uploads": { "maxMb": 20 }\n}\n' }),
  "backups.listPolicies": (input: Input) => ({
    policies: [
      {
        id: "b000000000000001",
        serviceId: input.serviceId,
        destinationId: "x000000000000001",
        destinationName: "acme-backups (R2)",
        target: "database",
        volumeId: null,
        volumeName: null,
        schedule: "0 3 * * *",
        keepLast: 14,
        stopService: false,
        enabled: true,
        nextRunAt: new Date(now + 9 * hour).toISOString(),
        lastRun: { id: "r000000000000000", status: "succeeded", finishedAt: ago(15 * hour) },
        createdAt: ago(20 * day),
      },
    ],
  }),
  "backups.listRuns": () => ({ runs: [run(0, "succeeded"), run(1, "succeeded"), run(2, "failed"), run(3, "succeeded")], hasMore: false }),
  "backups.listDestinations": () => ({ destinations: [], choices: [{ id: "x000000000000001", name: "acme-backups", provider: "r2", bucket: "acme-backups" }] }),
  "databases.get": (input: Input) => databaseOf(String(input.serviceId)),
  "databases.connection": (input: Input) => connectionOf(String(input.serviceId)),
  "databases.versionChoices": (input: Input) => versionChoicesOf(String(input.serviceId)),
  "databases.users": (input: Input) => usersOf(String(input.serviceId)),
  "previews.getSettings": () => ({ settings: { enabled: true, domainPattern: "", maxPreviews: 5 }, available: true, unavailableReason: null }),
  "previews.list": () => ({
    previews: [
      { id: "q000000000000001", prNumber: 42, prTitle: "New checkout flow", branch: "feat/checkout", commitSha: "a1b2c3d4", previewServiceId: "s000000000000009", url: "https://pr-42-web.de1.example.com", status: "live", closedAt: null, createdAt: ago(day) },
      { id: "q000000000000002", prNumber: 39, prTitle: "Fix cart totals", branch: "fix/cart", commitSha: "e5f6a7b8", previewServiceId: null, url: null, status: "superseded", closedAt: ago(3 * day), createdAt: ago(6 * day) },
    ],
  }),
  "cron.list": (input: Input) => ({
    jobs: [
      {
        id: "j000000000000001",
        serviceId: input.serviceId,
        name: "Nightly cleanup",
        schedule: "0 2 * * *",
        timeZone: "Europe/Berlin",
        command: "bun run cleanup",
        timeoutSeconds: 600,
        concurrency: "forbid",
        enabled: true,
        nextRunAt: new Date(now + 6 * hour).toISOString(),
        lastRun: { id: "c000000000000001", cronJobId: "j000000000000001", serviceId: input.serviceId, nodeId: de.id, result: "succeeded", manual: false, exitCode: 0, startedAt: ago(18 * hour), finishedAt: ago(18 * hour - 9000), durationMs: 9000 },
        createdAt: ago(10 * day),
        updatedAt: ago(day),
      },
    ],
  }),
  "cron.runs": (input: Input) => ({
    runs: [0, 1, 2].map((i) => ({ id: `c00000000000000${i + 1}`, cronJobId: "j000000000000001", serviceId: input.serviceId, nodeId: de.id, result: i === 1 ? "failed" : "succeeded", manual: i === 2, exitCode: i === 1 ? 1 : 0, startedAt: ago((i + 1) * 18 * hour), finishedAt: ago((i + 1) * 18 * hour - 9000), durationMs: 9000 })),
    nextCursor: null,
  }),
  "cron.run": (input: Input) => ({ run: { id: input.runId, cronJobId: "j000000000000001", serviceId: input.serviceId, nodeId: de.id, result: "failed", manual: false, exitCode: 1, startedAt: ago(36 * hour), finishedAt: ago(36 * hour - 9000), durationMs: 9000 }, command: "bun run cleanup", output: "cleaning sessions\nerror: connection refused\n", truncated: false }),
  "notifications.serviceAlerts": () => ({
    useDefaults: true,
    rules: [
      { event: "crash", enabled: true, channelIds: ["h000000000000001"] },
      { event: "deploy_failed", enabled: true, channelIds: ["h000000000000001"] },
    ],
    defaults: [
      { event: "crash", enabled: true, channelIds: ["h000000000000001"] },
      { event: "deploy_failed", enabled: true, channelIds: ["h000000000000001"] },
    ],
  }),
  "notifications.channels": () => ({ channels: [{ id: "h000000000000001", name: "Ops Discord", kind: "discord", enabled: true, isDefault: true, config: { kind: "discord" }, secretsSet: [], target: "discord.com", usedBy: { services: 3, defaults: 2 }, lastDelivery: null, createdAt: ago(day), updatedAt: ago(day) }] }),
  "uptime.list": () => ({
    checks: [{ id: "k000000000000001", serviceId: ids.web, projectId: ids.project, name: "Home page", url: "https://shop.example.com", method: "GET", expectedStatus: 0, intervalSeconds: 60, timeoutMs: 10000, failureThreshold: 3, enabled: true, status: "up", statusSince: ago(2 * day), lastCheckedAt: ago(20_000), lastStatusCode: 200, lastLatencyMs: 84, lastError: null, uptime24h: 99.93, createdAt: ago(9 * day), updatedAt: ago(day) }],
  }),
  "maintenance.getGlobal": () => ({ enabled: false, message: "", html: null, updatedAt: null }),
  "boxes.get": (input: Input) => ({ serviceId: input.serviceId, projectId: ids.project, name: "box", nodeId: de.id, nodeName: de.name, state: "sleeping", repository: "https://github.com/acme/shop-api", idleMinutes: 30, lastUsedAt: ago(5 * hour), createdAt: ago(5 * day) }),
  "compose.get": () => ({ stack: servicesById[ids.stack], source: { type: "inline", yaml: "services:\n  grafana:\n    image: grafana/grafana:11\n  prometheus:\n    image: prom/prometheus:v3\n" }, members: [] }),
  "logs.follow": () => ({ url: "/api/logs/follow?t=tk", ticket: "tk", expiresAt: ago(-min) }),
  "terminals.watchConsole": () => ({ url: "/api/terminal/console?t=tk", ticket: "tk", expiresAt: ago(-min), target: { nodeId: de.id, nodeName: de.name, containerId: null, generation: null }, idleTimeoutSeconds: 1800 }),
  "terminals.console": () => ({ url: "/api/terminal/console?t=tk", ticket: "tk", expiresAt: ago(-min), target: { nodeId: de.id, nodeName: de.name, containerId: null, generation: null }, idleTimeoutSeconds: 1800 }),
  "terminals.shell": () => ({ url: "/api/terminal/shell?t=tk", ticket: "tk", expiresAt: ago(-min), target: { nodeId: de.id, nodeName: de.name, containerId: null, generation: null }, idleTimeoutSeconds: 1800 }),
  "databases.openShell": (input: Input) => ({
    ticket: "tk",
    socketPath: "/api/terminal/db",
    client: databaseOf(String(input.serviceId)).shellClient,
    expiresAt: ago(-min),
  }),
};

const refused = (kind: string, reason: string, message: string) => ({ kind, allowed: false, reason, message });
/** A change setVersion takes with acceptRisk (0.2.11). */
const risky = (kind: string, risk: string, message: string) => ({ kind, allowed: true, risk, message });

/**
 * databases.versionChoices for the demo databases, as the panel's rules
 * answer them: Postgres takes its next major and older ones only as risks,
 * Redis takes the newer line. Both run the newest pinned image of their
 * line, and any other image of their repository (anyImage).
 * database-version.spec.ts adds a MongoDB and MySQL.
 */
export function versionChoicesOf(serviceId: string) {
  const base = {
    variant: null,
    pendingImage: null,
    blocked: null,
    anyImage: true,
    customOnCurrent: true,
    recentBackupAt: ago(15 * hour),
    backupFresh: true,
    nativePassword: null,
  };
  if (serviceId === ids.redis)
    return {
      ...base,
      engine: "redis",
      version: "7.4",
      image: "redis:7.4.5-alpine",
      release: "7.4.5",
      repository: "redis",
      choices: [
        { version: "8.2", image: "redis:8.2.1-alpine", kind: "major", allowed: true },
        { version: "7.4", image: "redis:7.4.5-alpine", ...refused("current", "current", "The database already runs redis:7.4.5-alpine: nothing to change.") },
      ],
    };
  const older = (version: string) =>
    risky("downgrade", "downgrade", `PostgreSQL ${version} is older than the 17 that runs: it may not open data files a newer version wrote.`);
  return {
    ...base,
    engine: "postgres",
    version: "17",
    image: "postgres:17.6-alpine",
    release: "17.6",
    repository: "postgres",
    choices: [
      {
        version: "18",
        image: "postgres:18.6-alpine",
        ...risky("major", "postgresMajor", "PostgreSQL 18 does not open PostgreSQL 17 data files without pg_upgrade or a dump and restore, which do not run here, so it will most likely not start."),
        risks: ["postgresMajor", "dataPath"],
      },
      { version: "17", image: "postgres:17.6-alpine", ...refused("current", "current", "The database already runs postgres:17.6-alpine: nothing to change.") },
      { version: "16", image: "postgres:16.10-alpine", ...older("16") },
      { version: "15", image: "postgres:15.14-alpine", ...older("15") },
    ],
  };
}

/** databases.get for the demo's Postgres, Redis and ClickHouse (events) databases; databases.spec.ts makes db a pgvector one. */
export function databaseOf(serviceId: string) {
  const exposure = {
    enabled: true,
    state: "open",
    host: "203.0.113.10",
    port: 15432,
    // The database's own user: exposing only opens the port, with TLS.
    user: "postgres",
    allowedCidrs: [],
    needsAllowedCidrs: false,
    tlsHostname: null,
    certificate: "selfSigned",
    certificateIssuer: null,
    certificateExpiresAt: null,
  };
  const base = {
    serviceId,
    projectId: ids.project,
    nodeId: de.id,
    nodeName: de.name,
    variant: null,
    exposure,
    webUi: { tool: "pgweb", idleMinutes: 15, running: true, lastActiveAt: ago(4 * min) },
    createdAt: ago(30 * day),
  };
  if (serviceId === ids.redis)
    return {
      ...base,
      name: "redis",
      engine: "redis",
      version: "7.4",
      internal: { host: "redis", port: 6379, database: "", user: "default", httpPort: null },
      exposure: { ...exposure, port: 16379, user: "default" },
      shellClient: "redis-cli",
      webUi: { ...base.webUi, tool: "Redis Commander" },
    };
  if (serviceId === ids.clickhouse)
    return {
      ...base,
      name: "events",
      engine: "clickhouse",
      version: "26.8",
      internal: { host: "events", port: 9000, database: "events", user: "ch_k3v9q2m8x1", httpPort: 8123 },
      exposure: { ...exposure, enabled: false, state: "off", host: null, port: null, user: "ch_k3v9q2m8x1", certificate: "none" },
      shellClient: "clickhouse-client",
      webUi: { ...base.webUi, tool: "ClickHouse Play", running: false, lastActiveAt: null },
    };
  return {
    ...base,
    name: "db",
    engine: "postgres",
    version: "17.6",
    internal: { host: "db", port: 5432, database: "shop", user: "postgres", httpPort: null },
    shellClient: "psql",
  };
}

/** databases.connection for the same databases. */
export function connectionOf(serviceId: string) {
  if (serviceId === ids.redis)
    return {
      internal: { url: "redis://default:Rk2mV7wTq9Lx4Pb8@redis:6379", host: "redis", port: 6379, database: "", user: "default", password: "Rk2mV7wTq9Lx4Pb8" },
      exposed: {
        url: "rediss://default:Rk2mV7wTq9Lx4Pb8@203.0.113.10:16379",
        host: "203.0.113.10",
        port: 16379,
        database: "",
        user: "default",
        password: "Rk2mV7wTq9Lx4Pb8",
        tlsParams: "",
      },
    };
  if (serviceId === ids.clickhouse)
    return {
      internal: {
        url: "clickhouse://ch_k3v9q2m8x1:Wd4nB8sKq1Pz7Hv2@events:9000/events",
        httpUrl: "http://ch_k3v9q2m8x1:Wd4nB8sKq1Pz7Hv2@events:8123/events",
        host: "events",
        port: 9000,
        database: "events",
        user: "ch_k3v9q2m8x1",
        password: "Wd4nB8sKq1Pz7Hv2",
      },
      exposed: null,
    };
  return {
    internal: {
      url: "postgres://postgres:Zq8vN3pXr7Lm2Kd9@db:5432/shop?sslmode=disable",
      host: "db",
      port: 5432,
      database: "shop",
      user: "postgres",
      password: "Zq8vN3pXr7Lm2Kd9",
    },
    exposed: {
      url: "postgres://postgres:Zq8vN3pXr7Lm2Kd9@203.0.113.10:15432/shop?sslmode=require",
      host: "203.0.113.10",
      port: 15432,
      database: "shop",
      user: "postgres",
      password: "Zq8vN3pXr7Lm2Kd9",
      tlsParams: "sslmode=require",
    },
  };
}

const can = (password: boolean, rename: boolean, del: boolean, makeMain: boolean) => ({ password, rename, delete: del, makeMain });
const dbUser = (over: Input) => ({
  host: null,
  authDatabase: null,
  main: false,
  system: false,
  access: "readWrite",
  roles: [],
  locked: false,
  ownsObjects: null,
  definerObjects: null,
  renameNeedsPassword: false,
  can: can(true, true, true, true),
  why: null,
  ...over,
});

/**
 * databases.users for the demo databases: Postgres with its main user, an
 * app user that owns tables and a read-only one; Redis with its one
 * default user; ClickHouse with its image's user and a SQL one.
 * database-users.spec.ts adds a MongoDB.
 */
export function usersOf(serviceId: string) {
  const base = { truncated: false, hosts: false, canCreate: true, notice: null, signIn: "ok", message: null };
  if (serviceId === ids.redis)
    return {
      ...base,
      engine: "redis",
      presets: [],
      canCreate: false,
      notice:
        "Redis has one user, default, and only its password changes here. Users made with ACL SETUSER live in memory only: Seylo starts Redis without an ACL file, so the next restart or deploy would remove them.",
      main: { user: "default", rename: "none", canSwitch: false },
      users: [dbUser({ name: "default", main: true, access: "serverAdmin", can: can(true, false, false, false), why: "Seylo signs in with this one. Make another user the main one first." })],
    };
  if (serviceId === ids.clickhouse)
    return {
      ...base,
      engine: "clickhouse",
      presets: ["readOnly", "readWrite", "databaseAdmin", "serverAdmin"],
      main: { user: "ch_k3v9q2m8x1", rename: "restart", canSwitch: false },
      users: [
        dbUser({ name: "ch_k3v9q2m8x1", main: true, access: "serverAdmin", can: can(true, true, false, false), why: "Seylo signs in with this one. Make another user the main one first." }),
        dbUser({ name: "grafana", access: "readOnly", roles: ["events.*: SELECT, SHOW"], can: can(true, true, true, false) }),
      ],
    };
  return {
    ...base,
    engine: "postgres",
    presets: ["readOnly", "readWrite", "serverAdmin"],
    main: { user: "postgres", rename: "inPlace", canSwitch: true },
    users: [
      dbUser({ name: "postgres", main: true, access: "serverAdmin", roles: ["SUPERUSER", "CREATEROLE", "CREATEDB"], ownsObjects: 0, can: can(true, true, false, false), why: "Seylo signs in with this one. Make another user the main one first." }),
      dbUser({ name: "shop_app", roles: ["pg_read_all_data", "pg_write_all_data"], ownsObjects: 12 }),
      dbUser({ name: "metabase", access: "readOnly", roles: ["pg_read_all_data"], ownsObjects: 0 }),
    ],
  };
}

export { logEntries };
