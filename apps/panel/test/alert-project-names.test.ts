// Alerts about a service name its project (0.2.18): with many projects that
// each have an "api" or a "web", "api crashed" did not say which one. Every
// source titles them "<project> / <service> ..." ("<project> / <stack> /
// <member>" for a compose member) and sets projectId; node alerts stay as
// they were. alerts.list carries the current names of the ids
// (projectName, serviceName, stackName), while a title keeps the names it
// was raised with when a project or service is renamed later. Web Push
// opens the service of an alert that has no link of its own. A service
// moved to another project is linked where it is now (serviceProjectId),
// while the alert keeps the project it happened in.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { alerts as alertOps } from "@seylo/ops";
import {
  BackupResultSchema,
  BuildProgressSchema,
  BuildStage,
  CrashAction,
  CrashReportSchema,
  DeployProgressSchema,
  DeployStage,
  EventSchema,
  HealthChangedSchema,
  HealthState,
  NodeAlertKind,
  NodeAlertSchema,
  RouteState,
} from "@seylo/proto";
import { eq } from "drizzle-orm";
import {
  alerts,
  backupRuns,
  builds,
  deployments,
  domains,
  nodes,
  projects,
  servicePlacements,
  services,
  uptimeChecks,
} from "../src/db/schema";
import { currentAlertLink, serviceProjectIdOf } from "../src/modules/alerts/subject";
import { sweepStaleBackups } from "../src/modules/backups/runs";
import { applyRouteStatus } from "../src/modules/domains/tracking";
import { alertNotice } from "../src/modules/notifications/deliver";
import { alertMessage } from "../src/modules/push/send";
import { applyResult } from "../src/modules/uptime/checks";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
let cookie: string;
let nodeId: string;
let projectId: string;
let api: string;
let stack: string;
let member: string;

beforeEach(async () => {
  panel = testPanel();
  ({ cookie } = await createUser(panel, "owner"));
  nodeId = panel.deps.db
    .insert(nodes)
    .values({ name: "node-a", publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) })
    .returning()
    .get().id;
  projectId = panel.deps.db.insert(projects).values({ name: "acme-shop", nameKey: "acme-shop" }).returning().get().id;
  const service = (name: string, kind: "app" | "compose" = "app", parentId: string | null = null) =>
    panel.deps.db.insert(services).values({ projectId, name, nameKey: name, kind, parentId, spec: {} }).returning().get().id;
  api = service("api");
  stack = service("shop", "compose");
  member = service("shop-web", "app", stack);
  // The node may report only on services it runs.
  for (const serviceId of [api, member]) panel.deps.db.insert(servicePlacements).values({ serviceId, nodeId }).run();
  // Another project with its own "api": the title is what tells them apart.
  const other = panel.deps.db.insert(projects).values({ name: "blog", nameKey: "blog" }).returning().get().id;
  panel.deps.db.insert(services).values({ projectId: other, name: "api", nameKey: "api", kind: "app", spec: {} }).run();
});
afterEach(() => panel.close());

const emit = (payload: MessageInitShape<typeof EventSchema>["payload"], at = Date.now()) =>
  panel.deps.agents.emitEvent(nodeId, create(EventSchema, { time: timestampFromMs(at), payload }));

let crashes = 0;
const crash = (serviceId: string, streak: number, action: CrashAction, at: number) => {
  crashes += 1;
  panel.deps.agents.emitCrash(
    nodeId,
    create(CrashReportSchema, { serviceId, exitCode: 137, oomKilled: true, streak, action, exitedAt: timestampFromMs(at) }),
    { outboxId: String(crashes), crashId: String(crashes) },
  );
};

/** The service's alerts of one event as [title, projectId], oldest first. */
const raised = (serviceId: string, event: string) =>
  panel.deps.db
    .select()
    .from(alerts)
    .where(eq(alerts.serviceId, serviceId))
    .all()
    .filter((a) => a.event === event)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.eventKey.localeCompare(b.eventKey))
    .map((a) => [a.title, a.projectId]);

test("crashes and the crash limit name the project; a compose member names its stack too", () => {
  const t0 = Date.now() - 60_000;
  crash(api, 1, CrashAction.RESTARTING, t0);
  crash(api, 2, CrashAction.GAVE_UP, t0 + 10_000);
  expect(raised(api, "crash")).toEqual([["acme-shop / api crashed", projectId]]);
  expect(raised(api, "crash_limit")).toEqual([["acme-shop / api was stopped after 2 crashes", projectId]]);
  crash(member, 1, CrashAction.RESTARTING, t0);
  expect(raised(member, "crash")).toEqual([["acme-shop / shop / shop-web crashed", projectId]]);
});

test("deploy results, health and the agent's build and backup failures name the project", () => {
  emit({
    case: "deployProgress",
    value: create(DeployProgressSchema, { serviceId: api, generation: 3n, stage: DeployStage.FAILED, message: "x" }),
  });
  emit({ case: "deployProgress", value: create(DeployProgressSchema, { serviceId: api, generation: 4n, stage: DeployStage.SUCCEEDED }) });
  expect(raised(api, "deploy_failed")).toEqual([["acme-shop / api failed to deploy", projectId]]);
  expect(raised(api, "deploy_succeeded")).toEqual([["acme-shop / api deployed", projectId]]);

  emit({
    case: "healthChanged",
    value: create(HealthChangedSchema, {
      serviceId: api,
      previous: HealthState.HEALTHY,
      current: HealthState.UNHEALTHY,
      probeOutput: "503",
    }),
  });
  emit({
    case: "healthChanged",
    value: create(HealthChangedSchema, { serviceId: api, previous: HealthState.UNHEALTHY, current: HealthState.HEALTHY }),
  });
  expect(raised(api, "health_unhealthy")).toEqual([["acme-shop / api is unhealthy", projectId]]);
  expect(raised(api, "health_recovered")).toEqual([["acme-shop / api is healthy again", projectId]]);

  const deployment = panel.deps.db
    .insert(deployments)
    .values({ serviceId: member, generation: 2, trigger: "manual", status: "failed" })
    .returning()
    .get();
  const build = panel.deps.db.insert(builds).values({ deploymentId: deployment.id, nodeId, builder: "dockerfile" }).returning().get();
  emit({ case: "buildProgress", value: create(BuildProgressSchema, { buildId: build.id, stage: BuildStage.FAILED, message: "exit 2" }) });
  expect(raised(member, "build_failed")).toEqual([["acme-shop / shop / shop-web failed to build", projectId]]);

  const run = panel.deps.db
    .insert(backupRuns)
    .values({ serviceId: api, nodeId, target: "volume", status: "running", startedAt: new Date() })
    .returning()
    .get();
  emit({ case: "backupResult", value: create(BackupResultSchema, { runId: run.id, success: false, error: "disk full" }) });
  expect(raised(api, "backup_failed")).toEqual([["acme-shop / api: backup failed", projectId]]);
});

test("a backup that never reported, an uptime check and a certificate name the project", () => {
  const now = new Date();
  panel.deps.db
    .insert(backupRuns)
    .values({ serviceId: member, nodeId, target: "volume", status: "running", startedAt: new Date(now.getTime() - 13 * 3600_000) })
    .run();
  expect(sweepStaleBackups(panel.deps, now)).toBe(1);
  expect(raised(member, "backup_failed")).toEqual([["acme-shop / shop / shop-web: backup failed", projectId]]);

  const check = panel.deps.db
    .insert(uptimeChecks)
    .values({ serviceId: api, name: "Homepage", url: "https://api.example.com/", failureThreshold: 1 })
    .returning()
    .get();
  const down = applyResult(panel.deps, check, { ok: false, statusCode: 503, latencyMs: 20, error: "HTTP 503" }, now);
  applyResult(panel.deps, down, { ok: true, statusCode: 200, latencyMs: 20, error: null }, new Date(now.getTime() + 60_000));
  expect(raised(api, "uptime_down")).toEqual([["acme-shop / api: Homepage is down", projectId]]);
  expect(raised(api, "uptime_up")).toEqual([["acme-shop / api: Homepage is up again", projectId]]);

  const domain = panel.deps.db.insert(domains).values({ serviceId: api, host: "api.example.com", targetPort: 80 }).returning().get();
  applyRouteStatus(panel.deps, {
    serviceId: api,
    routes: [{ routeId: domain.id, state: RouteState.CERTIFICATE_FAILED, message: "acme: rateLimited" }],
  } as never);
  expect(raised(api, "certificate_failed")).toEqual([["acme-shop / api: no certificate for api.example.com", projectId]]);
});

test("node alerts stay as they were: the node's name, no project", async () => {
  emit({ case: "nodeAlert", value: create(NodeAlertSchema, { kind: NodeAlertKind.DISK_LOW, message: "Disk / is 91% full" }) });
  const row = panel.deps.db.select().from(alerts).where(eq(alerts.nodeId, nodeId)).get();
  expect(row).toMatchObject({ event: "disk_low", title: "node-a: Disk / is 91% full", projectId: null, serviceId: null });
  const listed = (await callOp(panel, alertOps.list, { nodeId }, { cookie })).body.alerts;
  expect(listed).toMatchObject([{ title: "node-a: Disk / is 91% full", projectName: null, serviceName: null, stackName: null }]);
});

test("alerts.list names the ids as they are now; titles keep the names they were raised with", async () => {
  const t0 = Date.now() - 60_000;
  crash(api, 1, CrashAction.RESTARTING, t0);
  crash(member, 1, CrashAction.RESTARTING, t0);
  let listed = (await callOp(panel, alertOps.list, { projectId }, { cookie })).body.alerts;
  expect(listed).toHaveLength(2);
  const byService = (serviceId: string) => listed.find((a: { serviceId: string }) => a.serviceId === serviceId);
  expect(byService(api)).toMatchObject({ title: "acme-shop / api crashed", projectName: "acme-shop", serviceName: "api", stackName: null });
  expect(byService(member)).toMatchObject({
    title: "acme-shop / shop / shop-web crashed",
    projectName: "acme-shop",
    serviceName: "shop-web",
    stackName: "shop",
  });

  // Renamed later: the alerts already sent keep their text, the names follow the ids.
  panel.deps.db.update(projects).set({ name: "acme", nameKey: "acme" }).where(eq(projects.id, projectId)).run();
  panel.deps.db.update(services).set({ name: "backend", nameKey: "backend" }).where(eq(services.id, api)).run();
  panel.deps.db.update(services).set({ name: "store", nameKey: "store" }).where(eq(services.id, stack)).run();
  listed = (await callOp(panel, alertOps.list, { projectId }, { cookie })).body.alerts;
  expect(byService(api)).toMatchObject({ title: "acme-shop / api crashed", projectName: "acme", serviceName: "backend" });
  expect(byService(member)).toMatchObject({ title: "acme-shop / shop / shop-web crashed", projectName: "acme", stackName: "store" });

  // The next alert is raised with the new names.
  crash(api, 1, CrashAction.RESTARTING, t0 + 30_000);
  expect(raised(api, "crash").at(-1)).toEqual(["acme / backend crashed", projectId]);
});

test("a push about a service without a link of its own opens the service; its title names the project", () => {
  crash(api, 1, CrashAction.RESTARTING, Date.now() - 1000);
  const row = panel.deps.db.select().from(alerts).where(eq(alerts.serviceId, api)).get();
  if (!row) throw new Error("no crash alert");
  expect(alertMessage(row)).toMatchObject({ title: "acme-shop / api crashed", url: `/p/${projectId}/s/${api}` });
  // cron_failed alerts are raised with link null: before 0.2.18 the push opened "/".
  expect(alertMessage({ ...row, link: null }).url).toBe(`/p/${projectId}/s/${api}`);
  // An absolute link the service worker may not open, or no service at all: the dashboard, as before.
  expect(alertMessage({ ...row, link: "https://example.com/x" }).url).toBe("/");
  expect(alertMessage({ ...row, link: null, serviceId: null, projectId: null }).url).toBe("/");
});

test("a service moved to another project is linked where it is now; the alert keeps the project it happened in", async () => {
  crash(api, 1, CrashAction.RESTARTING, Date.now() - 60_000);
  const ops = panel.deps.db.insert(projects).values({ name: "ops", nameKey: "ops" }).returning().get().id;
  panel.deps.db.update(services).set({ projectId: ops }).where(eq(services.id, api)).run();

  const listed = (await callOp(panel, alertOps.list, { serviceId: api }, { cookie })).body.alerts;
  expect(listed).toMatchObject([
    {
      title: "acme-shop / api crashed",
      projectId,
      projectName: "acme-shop",
      serviceProjectId: ops,
      link: `/p/${ops}/s/${api}`,
    },
  ]);
  // A service that stayed: serviceProjectId is its project, the link as stored.
  crash(member, 1, CrashAction.RESTARTING, Date.now() - 60_000);
  const stayed = (await callOp(panel, alertOps.list, { serviceId: member }, { cookie })).body.alerts;
  expect(stayed).toMatchObject([{ projectId, serviceProjectId: projectId, link: `/p/${projectId}/s/${member}` }]);
  // A node alert is about no service.
  emit({ case: "nodeAlert", value: create(NodeAlertSchema, { kind: NodeAlertKind.DISK_LOW, message: "Disk / is 91% full" }) });
  // The node's crash alerts are listed too, and one raised in the same millisecond may come first.
  const nodeAlerts = (await callOp(panel, alertOps.list, { nodeId }, { cookie })).body.alerts;
  expect(nodeAlerts.find((a: { serviceId: string | null }) => a.serviceId === null)).toMatchObject({
    serviceProjectId: null,
    link: "/nodes",
  });

  // The stored row is left as it was raised; channels and pushes link the service where it is now.
  const row = panel.deps.db.select().from(alerts).where(eq(alerts.serviceId, api)).get();
  if (!row) throw new Error("no crash alert");
  expect(row.link).toBe(`/p/${projectId}/s/${api}`);
  const notice = alertNotice(panel.deps, row);
  expect(notice.link).toEndWith(`/p/${ops}/s/${api}`);
  expect(notice.serviceUrl).toEndWith(`/p/${ops}/s/${api}`);
  expect(notice.projectName).toBe("acme-shop");
  expect(alertMessage(row, ops).url).toBe(`/p/${ops}/s/${api}`);
  expect(alertMessage({ ...row, link: null }, ops).url).toBe(`/p/${ops}/s/${api}`);
});

test("the current link: only a link to the alert's service's pages moves, and only when the service did", () => {
  const row = { projectId: "projold000000001", serviceId: "svcapi0000000001", link: "/p/projold000000001/s/svcapi0000000001" };
  const now = "projnew000000001";
  expect(currentAlertLink(row, now)).toBe(`/p/${now}/s/svcapi0000000001`);
  // A page under the service, with its query and hash.
  expect(currentAlertLink({ ...row, link: `${row.link}/deployments?d=x#log` }, now)).toBe(
    `/p/${now}/s/svcapi0000000001/deployments?d=x#log`,
  );
  // Not the service's pages: another service whose id starts the same, another page, an absolute link.
  expect(currentAlertLink({ ...row, link: `${row.link}2` }, now)).toBe(`${row.link}2`);
  expect(currentAlertLink({ ...row, link: "/settings/security" }, now)).toBe("/settings/security");
  expect(currentAlertLink({ ...row, link: "https://example.com/x" }, now)).toBe("https://example.com/x");
  // Not moved, no link, no service: as stored.
  expect(currentAlertLink(row, row.projectId)).toBe(row.link);
  expect(currentAlertLink({ ...row, link: null }, now)).toBeNull();
  expect(currentAlertLink({ ...row, serviceId: null }, now)).toBe(row.link);

  // The service's project now; the alert's own when the service is gone; null when it is about no service.
  const services = new Map([["svcapi0000000001", { projectId: now } as never]]);
  expect(serviceProjectIdOf(row, services)).toBe(now);
  expect(serviceProjectIdOf(row, new Map())).toBe(row.projectId);
  expect(serviceProjectIdOf({ projectId: null, serviceId: null }, services)).toBeNull();
});
