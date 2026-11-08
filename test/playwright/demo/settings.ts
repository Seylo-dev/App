// Demo data for the settings, activity and approvals screens, in the same
// world as fixtures.ts (nodes de-fsn-1, us-ash-1, il-tlv-1; projects
// acme-shop and personal). Shaped like the op contracts and loosely typed:
// Playwright transpiles this file without type checks.

import { viewer, ids as world } from "./fixtures";

type Input = Record<string, any>;
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const ahead = (min: number) => new Date(now + min * 60_000).toISOString();

const nodes = [
  { id: world.de, name: "de-fsn-1", status: "online" },
  { id: world.us, name: "us-ash-1", status: "online" },
  { id: world.il, name: "il-tlv-1", status: "offline" },
];

export const fixtures: Record<string, unknown> = {
  // Project settings > Internal git hosts.
  "git.listInternalHosts": {
    items: [
      { host: "gitea.lan:3000", approvedBy: { id: viewer.id, name: "You" }, createdAt: new Date(now - 86_400_000).toISOString(), usedBy: 2 },
      { host: "10.0.0.7", approvedBy: null, createdAt: new Date(now - 7 * 86_400_000).toISOString(), usedBy: 1 },
    ],
  },
  "settings.general": {
    name: "Acme Cloud",
    domain: "panel.acme.dev",
    domainStatus: { state: "active", message: "", checkedAt: ago(12), proxied: false },
    defaultNodeId: world.de,
    publicUrl: "https://panel.acme.dev",
    uptimeAllowInternalTargets: false,
    auditRetentionDays: 365,
    domainNodes: [],
  },
  // Check now on the Panel domain card: the demo domain is still active.
  "settings.checkDomain": () => ({ state: "active", message: "", checkedAt: new Date().toISOString(), proxied: false }),

  "updates.history": {
    runs: [
      {
        id: "run0000000000001",
        targetVersion: "0.9.3",
        trigger: "auto",
        status: "succeeded",
        startedBy: null,
        error: null,
        createdAt: ago(60 * 24 * 3),
        finishedAt: ago(60 * 24 * 3 - 4),
        doneSteps: 3,
        totalSteps: 3,
        steps: [
          { id: "s1", position: 0, target: "panel", nodeId: null, nodeName: null, fromVersion: "0.9.2", toVersion: "0.9.3", status: "succeeded", error: null, startedAt: null, finishedAt: null, retry: null, retryRunId: null, retryAt: null },
          { id: "s2", position: 1, target: "agent", nodeId: "a", nodeName: "de-fsn-1", fromVersion: "0.9.2", toVersion: "0.9.3", status: "succeeded", error: null, startedAt: null, finishedAt: null, retry: null, retryRunId: null, retryAt: null },
          { id: "s3", position: 2, target: "agent", nodeId: "b", nodeName: "us-ash-1", fromVersion: "0.9.2", toVersion: "0.9.3", status: "rolledBack", error: "health check failed", startedAt: null, finishedAt: null, retry: null, retryRunId: null, retryAt: null },
        ],
      },
    ],
    hasMore: false,
  },
  "users.list": {
    users: [
      { id: "user000000000001", email: "owner@example.com", name: "Owner", role: "owner", status: "active", twoFactor: true, passkeyCount: 2, githubLogin: "acme-ops", grantCount: 0, lastLoginAt: ago(3), createdAt: ago(60 * 24 * 90) },
      { id: "user000000000002", email: "lee@acme.dev", name: "Lee Park", role: "admin", status: "active", twoFactor: true, passkeyCount: 0, githubLogin: null, grantCount: 0, lastLoginAt: ago(60 * 5), createdAt: ago(60 * 24 * 40) },
      { id: "user000000000003", email: "contractor@studio.io", name: "", role: "member", status: "active", twoFactor: false, passkeyCount: 0, githubLogin: null, grantCount: 2, lastLoginAt: ago(60 * 24 * 2), createdAt: ago(60 * 24 * 10) },
      { id: "user000000000004", email: "old@acme.dev", name: "Former intern", role: "member", status: "disabled", twoFactor: false, passkeyCount: 0, githubLogin: null, grantCount: 1, lastLoginAt: null, createdAt: ago(60 * 24 * 200) },
    ],
  },
  "invites.list": {
    invites: [
      {
        id: "invite0000000001",
        email: "designer@studio.io",
        role: "member",
        grants: [
          { scopeType: "project", scopeId: world.acme, scopeName: "acme-shop", actions: ["*"] },
          { scopeType: "service", scopeId: "svc0000000000001", scopeName: "docs", actions: ["services.view", "logs.view"] },
        ],
        status: "pending",
        invitedBy: { id: "user000000000001", email: "owner@example.com", name: "Owner" },
        expiresAt: ahead(60 * 24 * 5),
        acceptedAt: null,
        createdAt: ago(60 * 24 * 2),
      },
    ],
  },

  "apiKeys.list": (input: Input) => {
    const kind = input.kind;
    if (kind === "mcp")
      return {
        keys: [
          { id: "key0000000000003", kind: "mcp", name: "Claude Code on laptop", prefix: "seylo_mcp_Xy7Q", actions: ["*"], projectIds: null, readOnly: true, mcpClient: null, owner: { id: "user000000000001", email: "owner@example.com" }, expiresAt: ahead(60 * 24 * 60), lastUsedAt: ago(12), revokedAt: null, createdAt: ago(60 * 24 * 30) },
          { id: "key0000000000004", kind: "mcp", name: "Claude Desktop", prefix: "seylo_mcp_Ab12", actions: ["*"], projectIds: null, readOnly: true, mcpClient: "Claude Desktop", owner: { id: "user000000000001", email: "owner@example.com" }, expiresAt: null, lastUsedAt: ago(60 * 26), revokedAt: null, createdAt: ago(60 * 24 * 8) },
        ],
      };
    return {
      keys: [
        { id: "key0000000000001", kind: "api", name: "github-actions", prefix: "seylo_key_Ab3d", actions: ["services.deploy", "services.view"], projectIds: [world.acme], readOnly: false, mcpClient: null, owner: { id: "user000000000001", email: "owner@example.com" }, expiresAt: ahead(60 * 24 * 300), lastUsedAt: ago(30), revokedAt: null, createdAt: ago(60 * 24 * 65) },
        { id: "key0000000000002", kind: "api", name: "grafana", prefix: "seylo_key_Qw9e", actions: ["metrics.view"], projectIds: null, readOnly: true, mcpClient: null, owner: { id: "user000000000001", email: "owner@example.com" }, expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: ago(60 * 24 * 5) },
      ],
    };
  },
  "mcp.info": {
    enabled: true,
    url: "https://panel.acme.dev/mcp",
    oauthMetadataUrl: "https://panel.acme.dev/.well-known/oauth-authorization-server",
    snippets: {
      "claude-code": "claude mcp add --transport http panel https://panel.acme.dev/mcp",
      "claude-desktop": '{\n  "mcpServers": {\n    "panel": { "url": "https://panel.acme.dev/mcp" }\n  }\n}',
      cursor: '{\n  "mcpServers": { "panel": { "url": "https://panel.acme.dev/mcp" } }\n}',
    },
    tools: { total: 148, readOnly: 71, destructive: 19 },
  },
  "mcp.clients": {
    clients: [{ id: "client0000000001", name: "Claude Desktop", redirectUris: ["https://claude.ai/api/mcp/auth_callback"], activeTokens: 1, lastUsedAt: ago(60 * 26), createdAt: ago(60 * 24 * 8) }],
  },
  "github.status": {
    app: { id: "ghapp00000000001", appId: 1234567, slug: "acme-seylo", name: "acme-seylo", ownerLogin: "acme", htmlUrl: "https://github.com/apps/acme-seylo", installUrl: "https://github.com/apps/acme-seylo/installations/new", createdAt: ago(60 * 24 * 60) },
    webhookUrl: "https://panel.acme.dev/api/hooks/github",
    deviceFlowAvailable: true,
    deviceAccount: null,
  },
  "github.installations": {
    installations: [
      { id: "inst000000000001", installationId: 55501, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", suspended: false, manageUrl: "https://github.com/organizations/acme/settings/installations/55501", createdAt: ago(60 * 24 * 59) },
      { id: "inst000000000002", installationId: 55502, accountLogin: "lee-park", accountType: "User", repositorySelection: "all", suspended: false, manageUrl: "https://github.com/settings/installations/55502", createdAt: ago(60 * 24 * 20) },
    ],
    installUrl: "https://github.com/apps/acme-seylo/installations/new",
  },
  "tunnels.getSettings": { tokenSet: true, updatedAt: ago(60 * 24 * 4) },
  "notifications.channels": {
    channels: [
      { id: "chan000000000001", name: "Ops email", kind: "smtp", enabled: true, isDefault: true, config: { kind: "smtp", host: "smtp.example.com", port: 587, security: "starttls", username: "alerts@example.com", from: "alerts@example.com", to: ["ops@example.com"] }, secretsSet: ["password"], target: "smtp.example.com -> ops@example.com", usedBy: { services: 7, defaults: true }, lastDelivery: { status: "sent", at: ago(90), error: null }, createdAt: ago(9000), updatedAt: ago(900) },
      { id: "chan000000000002", name: "#alerts", kind: "discord", enabled: true, isDefault: false, config: { kind: "discord" }, secretsSet: ["webhookUrl"], target: "discord.com/api/webhooks/1302...", usedBy: { services: 5, defaults: true }, lastDelivery: { status: "failed", at: ago(300), error: "404 Unknown Webhook" }, createdAt: ago(9000), updatedAt: ago(900) },
      { id: "chan000000000003", name: "n8n flow", kind: "webhook", enabled: true, isDefault: false, config: { kind: "webhook", url: "https://n8n.de1.example.com/webhook/seylo" }, secretsSet: ["signingSecret"], target: "POST https://n8n.de1.example.com/webhook/seylo · signed", usedBy: { services: 2, defaults: false }, lastDelivery: null, createdAt: ago(9000), updatedAt: ago(900) },
      { id: "chan000000000004", name: "My phone", kind: "telegram", enabled: false, isDefault: false, config: { kind: "telegram", chatId: "4417" }, secretsSet: ["botToken"], target: "Bot -> chat 4417...", usedBy: { services: 1, defaults: false }, lastDelivery: null, createdAt: ago(9000), updatedAt: ago(900) },
    ],
  },
  "notifications.defaults": {
    rules: [
      { event: "crash", enabled: true, channelIds: ["chan000000000001", "chan000000000002"] },
      { event: "crash_limit", enabled: true, channelIds: ["chan000000000001", "chan000000000004"] },
      { event: "deploy_failed", enabled: true, channelIds: ["chan000000000002"] },
      { event: "health_unhealthy", enabled: true, channelIds: ["chan000000000001"] },
      { event: "certificate_failed", enabled: true, channelIds: ["chan000000000001"] },
      { event: "disk_low", enabled: true, channelIds: ["chan000000000001"] },
      { event: "node_offline", enabled: true, channelIds: ["chan000000000004"] },
      { event: "uptime_down", enabled: true, channelIds: ["chan000000000002"] },
    ],
  },
  "backups.listDestinations": {
    destinations: [
      { id: "dest000000000001", name: "R2 backups", provider: "r2", endpoint: "https://abc123.r2.cloudflarestorage.com", region: "auto", bucket: "acme-backups", pathPrefix: "prod", pathStyle: false, accessKeyId: "AKIA...", policyCount: 6, createdAt: ago(9000), updatedAt: ago(900) },
      { id: "dest000000000002", name: "MinIO at home", provider: "minio", endpoint: "https://minio.home.example.com:9000", region: "us-east-1", bucket: "seylo", pathPrefix: "", pathStyle: true, accessKeyId: "minio", policyCount: 0, createdAt: ago(9000), updatedAt: ago(900) },
    ],
    choices: [],
  },
  "maintenance.getGlobal": { enabled: false, message: "We are upgrading our servers and will be back within the hour.", html: null, updatedAt: ago(60 * 24) },
  "maintenance.preview": {
    html: "<!doctype html><html><body style=\"font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f3f5f9;color:#0f172a\"><div style=\"text-align:center\"><h1>Back soon</h1><p>We are upgrading our servers and will be back within the hour.</p></div></body></html>",
  },
  "settings.appearance": { preset: "seylo", colorMode: "system", accent: null, customCss: "/* Tighter corners for the whole panel */\n:root {\n  --radius: 6px;\n}\n" },
  "settings.branding": { name: "Acme Cloud", logoLight: null, logoDark: null, favicon: null, loginMessage: "Acme internal panel. Ask an admin for access.", hidePoweredBy: true },
  "ai.settings": { enabled: true, keySet: true, keyHint: "x9Qa", routing: { mode: "auto", model: "sonnet", allowOpus: false }, monthlyBudgetUsd: 50, allowMembers: false },
  "ai.usage": (input: Input) => {
    const month = input.month ?? "2026-11";
    const byDay = [1, 2, 3, 4, 5].map((d) => ({ day: `${month}-0${d}`, costUsd: [0.42, 1.1, 0.05, 2.3, 0.8][d - 1] }));
    return {
      month,
      spentUsd: 4.67,
      projectedUsd: 28.02,
      budgetUsd: 50,
      budgetReached: false,
      byModel: [
        { model: "haiku", inputTokens: 120000, outputTokens: 9000, cacheReadTokens: 50000, cacheWriteTokens: 0, costUsd: 0.31, requests: 140 },
        { model: "sonnet", inputTokens: 600000, outputTokens: 70000, cacheReadTokens: 200000, cacheWriteTokens: 30000, costUsd: 4.36, requests: 61 },
      ],
      byDay,
      byUser: [
        { userId: "user000000000001", name: "Owner", costUsd: 3.9 },
        { userId: "user000000000002", name: "Lee Park", costUsd: 0.77 },
      ],
    };
  },
  "settings.telemetry": { enabled: false, installId: "7f3c2a9e-1b44-4f0a-9c1e-5d2b8a6f0c11", lastSentAt: null },
  "telemetry.preview": {
    enabled: false,
    endpoint: "https://seylo.dev/api/telemetry",
    intervalHours: 24,
    nextSendAt: null,
    payload: { installId: "7f3c2a9e-1b44-4f0a-9c1e-5d2b8a6f0c11", panelVersion: "0.9.3", agentVersions: { "0.9.3": 3 }, nodes: 3, projects: 2, services: { app: 4, postgres: 1 }, users: 4, features: ["mcp", "ai"], platforms: { "linux/amd64": 2, "linux/arm64": 1 }, wingsNodes: 1 },
  },
  "auth.security": {
    passwordSet: true,
    totp: { enabled: true, confirmedAt: ago(60 * 24 * 30) },
    recoveryCodesLeft: 8,
    passkeys: [
      { id: "pk00000000000001", name: "MacBook Touch ID", createdAt: ago(60 * 24 * 20), lastUsedAt: ago(60 * 3) },
      { id: "pk00000000000002", name: "YubiKey 5C", createdAt: ago(60 * 24 * 60), lastUsedAt: null },
    ],
    passkeysAvailable: true,
    github: { login: "acme-ops", repoAccess: false, linkedAt: ago(60 * 24 * 80) },
    githubAvailable: true,
  },
  "auth.listSessions": {
    sessions: [
      { id: "sess000000000001", current: true, ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", createdAt: ago(60 * 24), lastSeenAt: ago(0), expiresAt: ahead(60 * 24 * 29) },
      { id: "sess000000000002", current: false, ip: "198.51.100.23", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", createdAt: ago(60 * 24 * 6), lastSeenAt: ago(60 * 9), expiresAt: ahead(60 * 24 * 24) },
    ],
  },
  "audit.list": {
    entries: [
      { id: "1042", at: ago(2), actor: { type: "user", id: "user000000000001", label: "owner@example.com", credentialId: "sess000000000001" }, opId: "services.deploy", target: { type: "service", id: "svc0000000000001", label: "web" }, input: { serviceId: "svc0000000000001" }, outcome: "ok", errorCode: null, durationMs: 42, ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Macintosh) Chrome/130.0", approvalId: null },
      { id: "1041", at: ago(15), actor: { type: "mcp", id: "user000000000001", label: "owner@example.com via Claude Code on laptop", credentialId: "key0000000000003" }, opId: "projects.delete", target: { type: "project", id: world.personal, label: "docs" }, input: { projectId: world.personal }, outcome: "error", errorCode: "APPROVAL_REQUIRED", durationMs: 3, ip: "203.0.113.7", userAgent: null, approvalId: null },
      { id: "1040", at: ago(60), actor: { type: "apiKey", id: "user000000000001", label: "owner@example.com via key github-actions", credentialId: "key0000000000001" }, opId: "services.deploy", target: { type: "service", id: "svc0000000000002", label: "api" }, input: { serviceId: "svc0000000000002" }, outcome: "ok", errorCode: null, durationMs: 51, ip: "140.82.112.4", userAgent: "curl/8.4.0", approvalId: null },
      { id: "1039", at: ago(60 * 3), actor: { type: "user", id: "user000000000002", label: "lee@acme.dev", credentialId: "sess0000000000x2" }, opId: "notifications.createChannel", target: null, input: { name: "#alerts", config: { kind: "discord", webhookUrl: "[redacted]" } }, outcome: "ok", errorCode: null, durationMs: 220, ip: "198.51.100.23", userAgent: "Mozilla/5.0 Firefox/132.0", approvalId: null },
      { id: "1038", at: ago(60 * 26), actor: { type: "anonymous", id: null, label: "anonymous", credentialId: null }, opId: "auth.login", target: null, input: { email: "admin@acme.dev", password: "[redacted]" }, outcome: "error", errorCode: "UNAUTHENTICATED", durationMs: 310, ip: "45.33.12.9", userAgent: "python-requests/2.32", approvalId: null },
    ],
    nextCursor: "1038",
  },
  "approvals.list": {
    approvals: [
      { id: "appr000000000001", opId: "projects.delete", opSummary: "Delete a project", opKind: "destructive", inputPreview: { projectId: world.personal }, via: "mcp", requestedBy: { userId: "user000000000001", userName: "Owner", clientName: "Claude Code on laptop" }, reason: "You asked me to clean up the unused docs project; it has no deploys in 90 days.", target: { type: "project", id: world.personal, name: "docs" }, status: "pending", decidedBy: null, decidedAt: null, error: null, expiresAt: ahead(60 * 23), createdAt: ago(15) },
      { id: "appr000000000002", opId: "services.restart", opSummary: "Restart a service", opKind: "mutation", inputPreview: { serviceId: "svc0000000000002" }, via: "ai", requestedBy: { userId: "user000000000002", userName: "Lee Park", clientName: "AI assistant" }, reason: "The api service is answering 502 and its memory is at the limit.", target: { type: "service", id: "svc0000000000002", name: "api" }, status: "pending", decidedBy: null, decidedAt: null, error: null, expiresAt: ahead(60 * 20), createdAt: ago(40) },
    ],
    nextCursor: null,
    pendingCount: 2,
  },
};
