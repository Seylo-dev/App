// A new setting of a service must not silently miss exports: every column
// of every table that hangs off a service (a foreign key to services.id, or
// a scope id that names one), and every key of the service spec, is listed
// here as exported (in service.json or secrets.enc) or left out with a
// reason. A migration that adds a column fails this test until someone
// decides which.

import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../src/db/schema";
import { ServiceSpecJson } from "../src/modules/services/spec";

type Decision = "exported" | `out: ${string}`;
const runtime = "out: runtime state of this panel";
const history = "out: history, panel-local";
const local = "out: a panel-local id or person";
const time = "out: timestamps of this panel";

const columns: Record<string, Record<string, Decision>> = {
  services: {
    id: local,
    project_id: "out: the import picks the project",
    name: "exported",
    name_key: "out: derived from the name",
    kind: "exported",
    parent_id: "out: compose members are not exported yet",
    spec: "exported",
    generation: runtime,
    live_deployment_id: "out: live.commitSha and imageDigest go instead",
    target_deployment_id: runtime,
    stopped: "exported",
    notes: "exported",
    compose_file_sealed: "out: compose stacks are not exported yet",
    protected: "out: protected services are refused",
    template_slug: "exported",
    created_by: local,
    created_at: time,
    updated_at: time,
  },
  service_placements: { service_id: local, node_id: "exported", replicas: "exported", created_at: time },
  volumes: {
    id: local,
    service_id: local,
    name: "exported",
    mount_path: "exported",
    kind: "exported",
    read_only: "exported",
    owner_service_id: "out: compose shared volumes are not exported yet",
    content_sealed: "exported",
    created_at: time,
  },
  service_env: { service_id: local, content_sealed: "exported", updated_by: local, updated_at: time },
  service_secrets: { service_id: local, name: "exported", value_sealed: "exported", updated_at: time },
  service_databases: {
    service_id: local,
    engine: "exported",
    version: "exported",
    variant: "exported",
    database_name: "exported",
    admin_user: "exported",
    exposed_user: "exported",
    tls_hostname: "out: a host name of the old node's edge; the listener uses a self-signed certificate until one is set",
    web_ui_idle_minutes: "exported",
    created_at: time,
  },
  service_boxes: { service_id: local, repository: "exported", idle_minutes: "exported", last_used_at: runtime, created_at: time },
  domains: {
    id: local,
    service_id: local,
    host: "exported",
    path_prefix: "exported",
    strip_prefix: "exported",
    target_port: "exported",
    https: "exported",
    redirect_to_https: "exported",
    certificate_sealed: "exported",
    auto: "exported",
    middlewares: "exported",
    is_primary: "exported",
    forward: "exported",
    cert_status: runtime,
    cert_expires_at: runtime,
    cert_issuer: runtime,
    cert_error: runtime,
    dns_status: runtime,
    dns_checked_at: runtime,
    origin_status: runtime,
    origin_checked_at: runtime,
    acme_released_at: "out: the import checks the domain's DNS against its node again, as domains.add does",
    live_at: runtime,
    created_at: time,
    updated_at: time,
  },
  service_access: { service_id: local, close_when_domain_live: "exported", redirect_to_primary: "exported", updated_at: time },
  port_exposures: {
    id: local,
    service_id: local,
    node_id: "out: the import's node",
    kind: "exported",
    mode: runtime,
    redirect_url: runtime,
    listen_port: "exported",
    target_port: "out: derived from the engine",
    allowed_cidrs: "exported",
    tls: "exported",
    expires_at: "out: timed exposures are not exported",
    close_at: runtime,
    created_by: local,
    opened_via: local,
    opened_by_label: local,
    created_at: time,
  },
  cloudflare_tunnels: {
    service_id: local,
    enabled: "out: imported switched off",
    mode: "exported",
    token_sealed: "exported",
    url: runtime,
    target_port: "exported",
    hostname: "exported",
    expires_at: runtime,
    updated_by: local,
    updated_at: time,
  },
  maintenance_pages: { service_id: local, enabled: "exported", message: "exported", html: "exported", updated_at: time },
  cron_jobs: {
    id: local,
    service_id: local,
    name: "exported",
    schedule: "exported",
    time_zone: "exported",
    command: "exported",
    timeout_seconds: "exported",
    concurrency: "exported",
    enabled: "exported",
    created_at: time,
    updated_at: time,
  },
  uptime_checks: {
    id: local,
    service_id: local,
    name: "exported",
    url: "exported",
    method: "exported",
    expected_status: "exported",
    interval_seconds: "exported",
    timeout_ms: "exported",
    failure_threshold: "exported",
    keyword: "exported",
    max_latency_ms: "exported",
    enabled: "exported",
    state: runtime,
    state_since: runtime,
    consecutive_failures: runtime,
    last_checked_at: runtime,
    last_status_code: runtime,
    last_latency_ms: runtime,
    last_error: runtime,
    created_at: time,
    updated_at: time,
  },
  backup_policies: {
    id: local,
    service_id: local,
    destination_id: "exported",
    target: "exported",
    volume_id: "exported",
    schedule: "exported",
    keep_last: "exported",
    stop_service: "exported",
    enabled: "exported",
    next_run_at: runtime,
    created_at: time,
    updated_at: time,
  },
  deploy_triggers: {
    id: local,
    service_id: local,
    token_hash: "out: stored hashed; the import makes a new trigger (deployTrigger: true)",
    hint: "out: belongs to the old token",
    created_by: local,
    last_used_at: runtime,
    created_at: time,
  },
  source_uploads: {
    id: local,
    service_id: local,
    file_name: "exported",
    size_bytes: "exported",
    sha256: "exported",
    uploaded_by: local,
    created_at: time,
  },
  alert_rules: {
    id: local,
    scope_type: "exported",
    scope_id: local,
    event: "exported",
    enabled: "exported",
    channel_ids: "exported",
    created_at: time,
    updated_at: time,
  },
};

/** Tables that hang off a service but are left out whole. */
const tablesLeftOut: Record<string, string> = {
  alerts: history,
  backup_runs: "out: backups taken stay in the bucket; history",
  crash_reports: history,
  cron_runs: history,
  deployments: "out: deploy history; live.commitSha and imageDigest go instead",
  git_provider_webhooks: "out: the import creates its own repository webhook",
  github_repo_webhooks: "out: the import creates its own repository webhook",
  previews: "out: preview services are not portable",
  service_copies: runtime,
  service_exports: runtime,
  service_imports: runtime,
  source_polls: runtime,
  webhook_deliveries: history,
  alert_mutes: "out: mutes are a person's choice on this panel",
  grants: "out: accounts differ between panels",
};

/** Tables whose rows name a service in a scope column instead of a foreign key. */
const scopeTables = ["alert_rules", "alert_mutes", "grants"];

/** Keys of ServiceSpecJson and of its settings objects. */
const specKeys: Record<string, Decision> = {
  source: "exported",
  build: "exported",
  "build.builder": "exported",
  "build.contextPath": "exported",
  "build.dockerfilePath": "exported",
  "build.inlineDockerfile": "exported",
  "build.targetStage": "exported",
  "build.buildNodeId": "exported",
  "build.startCommand": "exported",
  "build.installCommand": "exported",
  "build.buildCommand": "exported",
  container: "exported",
  "container.command": "exported",
  "container.entrypoint": "exported",
  "container.workingDir": "exported",
  "container.user": "exported",
  "container.stopSignal": "exported",
  "container.stopGraceSeconds": "exported",
  ports: "exported",
  healthCheck: "exported",
  crashPolicy: "exported",
  "crashPolicy.restart": "exported",
  "crashPolicy.stopAfterCrashes": "exported",
  resources: "exported",
  "resources.memoryLimitBytes": "exported",
  "resources.memoryReservationBytes": "exported",
  "resources.cpuWeight": "exported",
  "resources.pidsLimit": "exported",
  deploy: "exported",
  "deploy.mode": "exported",
  "deploy.healthTimeoutSeconds": "exported",
  cron: "exported",
  stickySessions: "exported",
  entryNodeId: "out: one node on import",
  previews: "exported",
  "previews.enabled": "out: imported off",
  "previews.domainPattern": "out: names the old panel's wildcard domain",
  "previews.maxPreviews": "exported",
  member: "out: compose members are not exported yet",
  stack: "out: compose stacks are not exported yet",
  preview: "out: previews are refused",
  watchPaths: "exported",
  portEnv: "out: no longer read (spec.ts)",
};

const tables = (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable)).map((t) => getTableConfig(t));

test("every table that hangs off a service is decided", () => {
  const offService = tables.filter(
    (t) => t.foreignKeys.some((fk) => getTableConfig(fk.reference().foreignTable).name === "services") || scopeTables.includes(t.name),
  );
  const names = offService.map((t) => t.name).sort();
  const decided = [...Object.keys(columns), ...Object.keys(tablesLeftOut)].sort();
  expect(names.filter((n) => !decided.includes(n))).toEqual([]);
  expect(decided.filter((n) => !names.includes(n))).toEqual([]);
});

test("every column of an exported table is exported or left out with a reason", () => {
  for (const [table, decisions] of Object.entries(columns)) {
    const config = tables.find((t) => t.name === table);
    const actual = (config?.columns ?? []).map((c) => c.name).sort();
    expect(`${table}: ${actual.filter((c) => !(c in decisions)).join(", ")}`).toBe(`${table}: `);
    expect(
      `${table}: ${Object.keys(decisions)
        .filter((c) => !actual.includes(c))
        .join(", ")}`,
    ).toBe(`${table}: `);
  }
});

test("every key of the service spec and its settings is decided", () => {
  const keys: string[] = [];
  for (const [key, schema] of Object.entries(ServiceSpecJson.properties)) {
    keys.push(key);
    const props = (schema as { properties?: Record<string, unknown> }).properties;
    if (props && ["build", "container", "crashPolicy", "resources", "deploy", "previews"].includes(key)) {
      for (const inner of Object.keys(props)) keys.push(`${key}.${inner}`);
    }
  }
  expect(keys.filter((k) => !(k in specKeys))).toEqual([]);
  expect(Object.keys(specKeys).filter((k) => !keys.includes(k))).toEqual([]);
});
