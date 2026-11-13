// Turns agent events into alerts. Durable results (deploys, builds,
// backups, node alerts, updates) arrive through the agent hub's onEvent;
// crashes through onCrash. A node going offline
// alerts only when it is still offline a minute later, so agent restarts
// and short network blips stay quiet.

import { timestampMs } from "@bufbuild/protobuf/wkt";
import { BuildStage, CrashAction, type CrashReport, DeployStage, type Event, HealthState, NodeAlertKind, UpdateTarget } from "@seylo/proto";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { inspectedKeyMark } from "../../agent-hub/panel-address";
import { alerts, backupRuns, builds, crashReports, deployments, nodes, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { getSetting } from "../../settings";
import { splitLastOutput } from "../deployments/failure";
import { arrivalGraceMs } from "../panelMove/keys";
import { keyStartsWith, type RaiseAlert } from "./sink";

/** Grace period before a disconnected node counts as offline. */
export const nodeOfflineGraceMs = 60_000;

export const nodeOfflineJobType = "alerts.nodeOffline";

const nodeName = (deps: Deps, nodeId: string) => deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name;

const serviceName = (deps: Deps, serviceId: string) =>
  deps.db.select({ name: services.name }).from(services).where(eq(services.id, serviceId)).get()?.name;

/** Only alert about services the panel knows; a removed service's late events are dropped. */
function forService(deps: Deps, serviceId: string, build: (name: string) => RaiseAlert): void {
  const name = serviceName(deps, serviceId);
  if (name !== undefined) deps.alerts.raise(build(name));
}

export const nodeOfflineJob = defineJob<{ nodeId: string; since: string }>({
  type: nodeOfflineJobType,
  maxAttempts: 2,
  async run(payload, ctx) {
    if (ctx.agents.isOnline(payload.nodeId)) return;
    // Right after the panel moved, nodes find their way to it one by one: only one still away after the grace alerts.
    const moved = getSetting(ctx.db, "panelMoveDone");
    const graceEnds = moved ? moved.at + arrivalGraceMs : 0;
    if (Date.now() < graceEnds) {
      ctx.jobs.enqueue(nodeOfflineJobType, payload, {
        runAt: new Date(graceEnds + 1000),
        dedupeKey: `node-offline-after-move:${payload.nodeId}`,
      });
      return;
    }
    const name = nodeName(ctx, payload.nodeId);
    if (name === undefined) return; // removed in the meantime
    ctx.alerts.raise({
      event: "node_offline",
      key: `node-offline:${payload.nodeId}:${payload.since}`,
      title: `${name} is offline`,
      message: "The node's agent has not been connected for a minute. Its services keep running, but the panel cannot reach them.",
      nodeId: payload.nodeId,
    });
  },
});

const crashPrefix = (serviceId: string) => `crash:${serviceId}:`;

/** When an event happened, by its node's clock (Event.time), or now when it has none. */
const happenedAt = (event: Event) => (event.time ? timestampMs(event.time) : Date.now());

/**
 * Good news about a service (its deploy succeeded, it is healthy again)
 * ends its crash alert only when it came after the latest crash: a report
 * from before that crash arriving late says nothing about it. A deploy of a
 * newer generation than the one that crashed ends it whatever the clocks say.
 */
function resolveCrashes(deps: Deps, serviceId: string, at: number, generation?: number): void {
  const latest = deps.db
    .select({ at: crashReports.occurredAt, generation: crashReports.generation })
    .from(crashReports)
    .where(eq(crashReports.serviceId, serviceId))
    .orderBy(desc(crashReports.occurredAt))
    .get();
  if (latest && latest.at.getTime() >= at && !(generation !== undefined && generation > latest.generation)) return;
  deps.alerts.resolve(crashPrefix(serviceId));
}

/**
 * The key of the crash alert of the streak a crash continues: the node's
 * newest crash alert for the service, when it was raised since the node's
 * latest streak 1 crash and the panel holds as many of the node's crashes
 * since then as the streak counts. Null otherwise (reports that never
 * arrived, a full outbox say, may hide the start of a new streak): the crash
 * raises an alert of its own.
 */
function streakAlertKey(deps: Deps, serviceId: string, nodeId: string, streak: number, at: number): string | null {
  const ofNode = and(eq(crashReports.serviceId, serviceId), eq(crashReports.nodeId, nodeId));
  const began = deps.db
    .select({ at: crashReports.occurredAt })
    .from(crashReports)
    .where(and(ofNode, lte(crashReports.streak, 1), lte(crashReports.occurredAt, new Date(at))))
    .orderBy(desc(crashReports.occurredAt))
    .get()?.at;
  if (!began) return null;
  const held = deps.db
    .select({ n: count() })
    .from(crashReports)
    .where(and(ofNode, gte(crashReports.occurredAt, began), lte(crashReports.occurredAt, new Date(at))))
    .get()?.n;
  if (held !== streak) return null;
  const prefix = crashPrefix(serviceId);
  const newest = deps.db
    .select({ key: alerts.eventKey })
    .from(alerts)
    .where(and(keyStartsWith(prefix), eq(alerts.nodeId, nodeId)))
    .orderBy(desc(alerts.createdAt))
    .get();
  // Panels before 0.2.16 rounded the exit time in the key down; crash_reports rounds it to the nearest millisecond.
  return newest && Number(newest.key.slice(prefix.length)) >= began.getTime() - 1 ? newest.key : null;
}

/**
 * Records a crash: one alert per streak (streak 1 starts a new one), and one
 * when the agent gave up. Good news between two crashes of a streak (a
 * restarted container passed its health check before it crashed again)
 * may have resolved the streak's alert: the next crash opens that one
 * again instead of raising another.
 */
export function recordCrash(deps: Deps, nodeId: string, report: CrashReport): void {
  const serviceId = report.serviceId;
  // As crash_reports.occurred_at holds it.
  const at = report.exitedAt ? timestampMs(report.exitedAt) : Date.now();
  const cause = report.oomKilled ? "out of memory" : `exit code ${report.exitCode}`;
  const after =
    report.action === CrashAction.RESTARTING
      ? "restarting in a few seconds"
      : report.action === CrashAction.GAVE_UP
        ? `stopped after ${report.streak} crashes in a row`
        : "left stopped";
  const prefix = crashPrefix(serviceId);
  const raise = () =>
    forService(deps, serviceId, (name) => ({
      event: "crash",
      key: `${prefix}${at}`,
      title: `${name} crashed`,
      message: `${cause[0]?.toUpperCase()}${cause.slice(1)}, ${after}.`,
      serviceId,
      nodeId,
    }));
  if (report.streak <= 1) {
    deps.alerts.resolve(prefix);
    raise();
  } else if (!deps.alerts.isOpen(prefix)) {
    const key = streakAlertKey(deps, serviceId, nodeId, report.streak, at);
    if (!key || !deps.alerts.reopen(key)) raise();
  }
  if (report.action === CrashAction.GAVE_UP) {
    forService(deps, serviceId, (name) => ({
      event: "crash_limit",
      key: `crash-limit:${serviceId}:${at}`,
      title: `${name} was stopped after ${report.streak} crashes`,
      message: `Last exit: ${cause}. Fix the problem and start or redeploy the service.`,
      serviceId,
      nodeId,
    }));
  }
}

const nodeAlertEvent: Partial<Record<NodeAlertKind, RaiseAlert["event"]>> = {
  [NodeAlertKind.DISK_LOW]: "disk_low",
  [NodeAlertKind.MEMORY_LOW]: "node_health_check_failed",
  [NodeAlertKind.DOCKER_DOWN]: "node_health_check_failed",
  [NodeAlertKind.TRAEFIK_DOWN]: "node_health_check_failed",
  [NodeAlertKind.CLOCK_SKEW]: "node_health_check_failed",
  [NodeAlertKind.HEALTH_CHECK_FAILED]: "node_health_check_failed",
  [NodeAlertKind.CERTIFICATE_EXPIRING]: "certificate_failed",
  [NodeAlertKind.UPDATE_FAILED]: "update_failed",
  // The node could not move to the panel domain and keeps its old address.
  [NodeAlertKind.PANEL_MOVE_FAILED]: "node_health_check_failed",
};

export function subscribeAgentEvents(deps: Deps): void {
  const { agents } = deps;

  agents.onConnection((nodeId, online) => {
    if (online) {
      const name = nodeName(deps, nodeId) ?? "A node";
      deps.alerts.resolve(`node-offline:${nodeId}:`, {
        event: "node_online",
        key: `node-online:${nodeId}:${Date.now()}`,
        title: `${name} is back online`,
        nodeId,
      });
      return;
    }
    deps.jobs.enqueue(
      nodeOfflineJobType,
      { nodeId, since: String(Date.now()) },
      { runAt: new Date(Date.now() + nodeOfflineGraceMs), dedupeKey: `node-offline:${nodeId}` },
    );
  });

  agents.onEvent("deployProgress", (nodeId, progress, event) => {
    const { serviceId, generation } = progress;
    if (progress.stage === DeployStage.FAILED) {
      forService(deps, serviceId, (name) => ({
        event: "deploy_failed",
        key: `deploy-failed:${serviceId}:${generation}:${nodeId}`,
        title: `Deploy of ${name} failed`,
        // The reason alone: an agent before 0.2.16 appends the new container's output after "last output:".
        message: splitLastOutput(progress.message).reason || "The new version never became healthy. The previous version is still serving.",
        serviceId,
        nodeId,
      }));
    } else if (progress.stage === DeployStage.SUCCEEDED) {
      resolveCrashes(deps, serviceId, happenedAt(event), Number(generation));
      forService(deps, serviceId, (name) => ({
        event: "deploy_succeeded",
        key: `deploy-ok:${serviceId}:${generation}:${nodeId}`,
        title: `${name} deployed`,
        message: progress.message,
        serviceId,
        nodeId,
      }));
    }
  });

  agents.onEvent("buildProgress", (nodeId, progress) => {
    if (progress.stage !== BuildStage.FAILED) return;
    const row = deps.db
      .select({ serviceId: deployments.serviceId })
      .from(builds)
      .innerJoin(deployments, eq(deployments.id, builds.deploymentId))
      .where(eq(builds.id, progress.buildId))
      .get();
    if (!row) return;
    forService(deps, row.serviceId, (name) => ({
      event: "build_failed",
      key: `build-failed:${progress.buildId}`,
      title: `Build of ${name} failed`,
      message: progress.message || "See the deploy log for the build output.",
      serviceId: row.serviceId,
      nodeId,
    }));
  });

  agents.onEvent("healthChanged", (nodeId, change, event) => {
    const { serviceId } = change;
    if (change.current === HealthState.UNHEALTHY && change.previous !== HealthState.UNHEALTHY) {
      if (deps.alerts.isOpen(`health:${serviceId}:`)) return;
      forService(deps, serviceId, (name) => ({
        event: "health_unhealthy",
        key: `health:${serviceId}:${Date.now()}`,
        title: `${name} is unhealthy`,
        message:
          change.probeOutput
            .split("\n")
            .find((line) => line.trim())
            ?.slice(0, 300) ?? "The health check fails.",
        serviceId,
        nodeId,
      }));
    } else if (change.current === HealthState.HEALTHY) {
      const name = serviceName(deps, serviceId);
      if (name === undefined) return;
      resolveCrashes(deps, serviceId, happenedAt(event));
      deps.alerts.resolve(`health:${serviceId}:`, {
        event: "health_recovered",
        key: `health-ok:${serviceId}:${Date.now()}`,
        title: `${name} is healthy again`,
        serviceId,
        nodeId,
      });
    }
  });

  agents.onEvent("backupResult", (nodeId, result) => {
    if (result.success) return;
    const run = deps.db.select({ serviceId: backupRuns.serviceId }).from(backupRuns).where(eq(backupRuns.id, result.runId)).get();
    if (!run) return;
    forService(deps, run.serviceId, (name) => ({
      event: "backup_failed",
      key: `backup-failed:${result.runId}`,
      title: `Backup of ${name} failed`,
      message: result.error.slice(0, 500),
      serviceId: run.serviceId,
      nodeId,
    }));
  });

  agents.onEvent("nodeAlert", (nodeId, alert) => {
    const event = nodeAlertEvent[alert.kind];
    if (!event) return;
    const prefix = `node-alert:${nodeId}:${alert.kind}:`;
    const name = nodeName(deps, nodeId) ?? "A node";
    if (alert.resolved) {
      deps.alerts.resolve(prefix);
      if (alert.kind === NodeAlertKind.PANEL_MOVE_FAILED) deps.live.publish(`node:${nodeId}`, { type: "invalidate", ops: ["nodes.get"] });
      return;
    }
    if (deps.alerts.isOpen(prefix)) return;
    // A move that failed on an inspected certificate keeps the node on its address while it is open
    // (agent-hub/panel-address.ts): the key says so.
    const inspected = alert.kind === NodeAlertKind.PANEL_MOVE_FAILED && alert.inspectedCertificate ? inspectedKeyMark : "";
    deps.alerts.raise({
      event,
      key: `${prefix}${inspected}${Date.now()}`,
      title: `${name}: ${alert.message.split("\n")[0]?.slice(0, 160) || event.replaceAll("_", " ")}`,
      message: alert.message.slice(0, 1000),
      nodeId,
    });
    if (alert.kind === NodeAlertKind.PANEL_MOVE_FAILED) deps.live.publish(`node:${nodeId}`, { type: "invalidate", ops: ["nodes.get"] });
  });

  agents.onEvent("updateResult", (nodeId, result) => {
    if (result.success) return;
    const name = nodeName(deps, nodeId) ?? "A node";
    // modules/updates/rollbacks.ts: automatic runs do not install a rolled-back release again.
    const held = !result.rolledBack
      ? ""
      : result.target === UpdateTarget.PANEL
        ? " Automatic updates wait for a newer release; updating the panel by hand installs this one."
        : " Automatic updates leave this node out until a newer release; Update now installs this one.";
    deps.alerts.raise({
      event: "update_failed",
      key: `update-failed:${result.updateId || `${nodeId}:${Date.now()}`}`,
      title: `Update to ${result.toVersion || "the new version"} failed on ${name}`,
      message: `${result.error || "No reason given."}${result.rolledBack ? ` Rolled back to ${result.fromVersion}.` : ""}${held}`,
      nodeId,
    });
  });

  // Crash reports are durable reports of their own (PanelService.ReportCrash), deduped by the hub.
  agents.onCrash((nodeId, report) => recordCrash(deps, nodeId, report));
}
