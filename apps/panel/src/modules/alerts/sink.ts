// deps.alerts: the one way anything in the panel records an alert. raise()
// writes the feed row (once per incident key), checks mutes, and queues a
// delivery job per channel the matching rule names. resolve() closes the
// open incident and can record the good news as a feed-only alert.
//
//   deps.alerts.raise({ event: "backup_failed", key: `backup:${runId}`, title: "Backup of db failed", serviceId })
//   deps.alerts.resolve(`uptime-down:${checkId}:`, { event: "uptime_up", key: `uptime-up:${checkId}:${now}`, title: ... })
//
// Keys are "<incident kind>:<subject>:<start>" so the next incident of the
// same subject gets a new row; resolve() and isOpen() take the prefix
// without the start.

import type { alerts as alertOps } from "@seylo/ops";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { alertMutes, alerts, notificationChannels, services } from "../../db/schema";
import type { JobQueue } from "../../jobs/queue";
import type { LiveHub } from "../../live/hub";
import type { Logger } from "../../logger";
import { effectiveRule } from "../notifications/rules";

export type AlertEventName = alertOps.AlertEventName;
export type AlertSeverity = alertOps.AlertSeverity;

export interface RaiseAlert {
  event: AlertEventName;
  /** Identifies the incident; a second raise with the same key is ignored. */
  key: string;
  title: string;
  message?: string;
  /** Defaults by event (crash is error, node_online is ok, ...). */
  severity?: AlertSeverity;
  serviceId?: string | null;
  /** Taken from the service when left out. */
  projectId?: string | null;
  nodeId?: string | null;
  /** In-app path ("/p/<id>/s/<id>") or absolute URL; defaults to the service or node page. */
  link?: string | null;
}

export interface AlertSink {
  /** Returns the new alert's id, or null when the key was already recorded. */
  raise(alert: RaiseAlert): string | null;
  /**
   * Marks open alerts whose key starts with `keyPrefix` resolved. When one
   * was open, `recovered` is recorded as a feed-only alert (it never notifies).
   */
  resolve(keyPrefix: string, recovered?: RaiseAlert): void;
  /** Whether an unresolved alert whose key starts with `keyPrefix` exists. */
  isOpen(keyPrefix: string): boolean;
}

/** Job that delivers one alert to one channel (notifications module). */
export const deliverJobType = "notifications.deliver";

export interface DeliverPayload {
  alertId: string;
  channelId: string;
}

export const defaultSeverity: Record<AlertEventName, AlertSeverity> = {
  crash: "error",
  crash_limit: "error",
  deploy_failed: "error",
  deploy_succeeded: "ok",
  build_failed: "error",
  health_unhealthy: "warning",
  certificate_failed: "error",
  uptime_down: "error",
  backup_failed: "error",
  cron_failed: "warning",
  node_offline: "error",
  node_health_check_failed: "warning",
  disk_low: "warning",
  update_available: "info",
  update_failed: "error",
  approval_requested: "info",
  security_change: "warning",
  node_online: "ok",
  uptime_up: "ok",
  health_recovered: "ok",
  domain_live: "ok",
};

const feedOnly = new Set<string>(["node_online", "uptime_up", "health_recovered", "domain_live"]);

function keyStartsWith(prefix: string) {
  return sql`substr(${alerts.eventKey}, 1, ${prefix.length}) = ${prefix}`;
}

export function createAlertSink(parts: { db: PanelDb; jobs: JobQueue; live: LiveHub; logger: Logger }): AlertSink {
  const { db, jobs, live, logger } = parts;

  const muted = (event: AlertEventName, scope: { projectId: string | null; serviceId: string | null; nodeId: string | null }) => {
    const now = new Date();
    const scopes = [and(eq(alertMutes.scopeType, "global"))];
    if (scope.projectId) scopes.push(and(eq(alertMutes.scopeType, "project"), eq(alertMutes.scopeId, scope.projectId)));
    if (scope.serviceId) scopes.push(and(eq(alertMutes.scopeType, "service"), eq(alertMutes.scopeId, scope.serviceId)));
    if (scope.nodeId) scopes.push(and(eq(alertMutes.scopeType, "node"), eq(alertMutes.scopeId, scope.nodeId)));
    return (
      db
        .select({ id: alertMutes.id })
        .from(alertMutes)
        .where(
          and(
            or(...scopes),
            or(isNull(alertMutes.event), eq(alertMutes.event, event)),
            or(isNull(alertMutes.until), gt(alertMutes.until, now)),
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  };

  const publish = (serviceId: string | null, projectId: string | null) => {
    const event = { type: "invalidate" as const, ops: ["alerts.list"] };
    live.publish("panel", event);
    if (projectId) live.publish(`project:${projectId}`, event);
    if (serviceId) live.publish(`service:${serviceId}`, event);
  };

  const insert = (alert: RaiseAlert, notify: boolean): string | null => {
    const serviceId = alert.serviceId ?? null;
    let projectId = alert.projectId ?? null;
    if (serviceId && !projectId) {
      projectId = db.select({ projectId: services.projectId }).from(services).where(eq(services.id, serviceId)).get()?.projectId ?? null;
    }
    const nodeId = alert.nodeId ?? null;
    const isMuted = notify && muted(alert.event, { projectId, serviceId, nodeId });
    const link =
      alert.link !== undefined ? alert.link : serviceId && projectId ? `/p/${projectId}/s/${serviceId}` : nodeId ? "/nodes" : null;
    const row = db
      .insert(alerts)
      .values({
        event: alert.event,
        severity: alert.severity ?? defaultSeverity[alert.event],
        title: alert.title.slice(0, 200),
        message: (alert.message ?? "").slice(0, 1000),
        projectId,
        serviceId,
        nodeId,
        link,
        eventKey: alert.key,
        muted: isMuted,
      })
      .onConflictDoNothing()
      .returning({ id: alerts.id })
      .get();
    if (!row) return null;
    publish(serviceId, projectId);
    if (!notify || isMuted || feedOnly.has(alert.event)) return row.id;

    const rule = effectiveRule(db, alert.event as alertOps.AlertRuleEventName, serviceId);
    if (!rule.enabled || rule.channelIds.length === 0) return row.id;
    const enabled = db
      .select({ id: notificationChannels.id, enabled: notificationChannels.enabled })
      .from(notificationChannels)
      .all()
      .filter((channel) => channel.enabled && rule.channelIds.includes(channel.id));
    for (const channel of enabled) {
      jobs.enqueue(deliverJobType, { alertId: row.id, channelId: channel.id } satisfies DeliverPayload, {
        dedupeKey: `deliver:${row.id}:${channel.id}`,
        maxAttempts: 4,
      });
    }
    return row.id;
  };

  return {
    raise(alert) {
      try {
        return insert(alert, true);
      } catch (error) {
        // Recording an alert must never break the code that noticed the problem.
        logger.error({ err: error, alertEvent: alert.event }, "recording an alert failed");
        return null;
      }
    },
    resolve(keyPrefix, recovered) {
      try {
        const open = db
          .update(alerts)
          .set({ resolvedAt: new Date() })
          .where(and(keyStartsWith(keyPrefix), isNull(alerts.resolvedAt)))
          .returning({ serviceId: alerts.serviceId, projectId: alerts.projectId })
          .all();
        if (open.length === 0) return;
        for (const row of open) publish(row.serviceId, row.projectId);
        if (recovered) insert(recovered, false);
      } catch (error) {
        logger.error({ err: error }, "resolving an alert failed");
      }
    },
    isOpen(keyPrefix) {
      return (
        db
          .select({ id: alerts.id })
          .from(alerts)
          .where(and(keyStartsWith(keyPrefix), isNull(alerts.resolvedAt)))
          .get() !== undefined
      );
    },
  };
}
