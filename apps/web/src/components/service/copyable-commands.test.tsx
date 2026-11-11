import { expect, test } from "bun:test";
import { cron, databases } from "@seylo/ops";
import { KeyValue } from "@seylo/ui/components/key-value";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../i18n/t";
import { renderStatic } from "../../test/render";
import { CronJobsPage } from "./cron/cron-page";
import { ConnectionPage } from "./database/connection-page";
import { OverviewPage } from "./overview/overview-page";
import type { ServiceDetail } from "./use-service";

const copy = `aria-label="${t("kit.copy")}`;

/** The <span data-slot="copy-code"> chip that holds `code`, or "" when there is none. */
function chipOf(out: string, code: string): string {
  const at = out.indexOf(`>${code}</code>`);
  if (at < 0) return "";
  const start = out.lastIndexOf('<span data-slot="copy-code"', at);
  return start < 0 ? "" : out.slice(start, out.indexOf("</span></span>", at) + 14);
}

const db = {
  serviceId: "svc-db",
  projectId: "prj-1",
  nodeId: "node-1",
  nodeName: "de-fsn-1",
  name: "events",
  engine: "clickhouse",
  version: "26.8",
  variant: null,
  internal: { host: "events", port: 9000, database: "events", user: "ch_k3v9q2m8x1", httpPort: 8123 },
  exposure: {
    enabled: false,
    host: null,
    port: null,
    user: "ch_k3v9q2m8x1",
    allowedCidrs: [],
    needsAllowedCidrs: false,
    tlsHostname: null,
    certificate: "none",
    certificateIssuer: null,
    certificateExpiresAt: null,
  },
  shellClient: "clickhouse-client",
  webUi: { tool: "ClickHouse Play", idleMinutes: 15, running: false, lastActiveAt: null },
  createdAt: "2026-11-01T10:00:00.000Z",
};
const dbService = { id: "svc-db", projectId: "prj-1", name: "events", kind: "clickhouse" } as unknown as ServiceDetail;

test("the pgvector hint's SQL can be copied", async () => {
  const out = await renderStatic(
    () => <ConnectionPage service={dbService} />,
    [[databases.get, { serviceId: "svc-db" }, { ...db, engine: "postgres", version: "17.6", variant: "pgvector" }]],
  );
  // Before: a plain <code> chip in the sentence, no copy control.
  expect(chipOf(out, "CREATE EXTENSION vector;")).toContain(copy);
});

test("database tiles wrap a long value instead of cutting it off", async () => {
  const out = await renderStatic(() => <ConnectionPage service={dbService} />, [[databases.get, { serviceId: "svc-db" }, db]]);
  const tile = out.match(/<span class="([^"]*)">ch_k3v9q2m8x1<\/span>/);
  expect(tile?.[1]).toBeDefined();
  expect(tile?.[1]).not.toMatch(/\btruncate\b/);
  expect(tile?.[1]).toContain("[overflow-wrap:anywhere]");
});

test("KeyValue grid values wrap instead of ending in an ellipsis", () => {
  const out = renderToStaticMarkup(
    <KeyValue layout="grid" items={[{ key: "repo", label: "Repository", value: "https://github.com/acme/shop-api", mono: true }]} />,
  );
  const dd = out.match(/<dd class="([^"]*)">/)?.[1] ?? "";
  expect(dd).not.toMatch(/\btruncate\b/);
  expect(dd).toContain("[overflow-wrap:anywhere]");
});

const job = {
  id: "j000000000000001",
  serviceId: "svc-app",
  name: "cleanup",
  schedule: "0 3 * * *",
  timeZone: "UTC",
  command: "bun run scripts/cleanup-sessions.ts --older-than 30d",
  timeoutSeconds: 600,
  concurrency: "forbid",
  enabled: true,
  lastRun: null,
  nextRunAt: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
};

test("a cron job's command in the job list can be copied and is not cut off", async () => {
  const app = { id: "svc-app", projectId: "prj-1", name: "api", kind: "app" } as unknown as ServiceDetail;
  const out = await renderStatic(
    () => <CronJobsPage service={app} />,
    [
      [cron.list, { serviceId: "svc-app" }, { jobs: [job] }],
      [cron.runs, { serviceId: "svc-app" }, { runs: [], nextCursor: null }],
    ],
  );
  const chip = chipOf(out, job.command);
  expect(chip).toContain(copy);
  expect(chip).not.toMatch(/\btruncate\b/);
});

test("a cron service's command on its overview can be copied", async () => {
  const service = {
    id: "svc-cron",
    projectId: "prj-1",
    name: "reports",
    kind: "cron",
    cron: { schedule: "0 3 * * *", timeZone: "UTC", command: ["bun", "run", "report"], timeoutSeconds: 600, concurrency: "forbid" },
  } as unknown as ServiceDetail;
  const out = await renderStatic(() => <OverviewPage service={service} />);
  expect(chipOf(out, "bun run report")).toContain(copy);
});
