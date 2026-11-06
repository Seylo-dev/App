// What the panel keeps in panel.db, pruned once a day (schedule
// "nodes.pruneReports"). Every one of these tables grows with time or with
// what nodes and the internet send, and panel.db is copied on every panel
// update: durable agent events and crash reports, webhook deliveries,
// notification deliveries, resolved alerts and the build and deploy output
// of old deployments. Deployments themselves stay (they are the history and
// the rollback targets); only their log lines go.

import { and, desc, eq, inArray, isNotNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import {
  agentReports,
  alerts,
  crashReports,
  deploymentLogs,
  deployments,
  notificationDeliveries,
  services,
  webhookDeliveries,
} from "../../db/schema";

const day = 24 * 3600 * 1000;

export const retention = {
  agentReportsMs: 30 * day,
  crashReportsMs: 30 * day,
  /** Newest crash reports kept per service, whatever their age. */
  crashReportsPerService: 200,
  webhookDeliveriesMs: 30 * day,
  /** Unsigned or unknown requests are kept a day, to see that something knocked. */
  rejectedDeliveriesMs: day,
  notificationDeliveriesMs: 30 * day,
  resolvedAlertsMs: 180 * day,
  deploymentLogsMs: 30 * day,
  /** The newest deployments of a service keep their logs, whatever their age. */
  deploymentLogsKeep: 20,
};

export function pruneTables(db: PanelDb, now = Date.now()): void {
  const before = (ms: number) => new Date(now - ms);
  db.delete(agentReports)
    .where(lt(agentReports.createdAt, before(retention.agentReportsMs)))
    .run();
  db.delete(crashReports)
    .where(lt(crashReports.occurredAt, before(retention.crashReportsMs)))
    .run();
  // A crash-looping service writes a report every few seconds: keep its newest ones only.
  db.run(sql`
    delete from ${crashReports} where ${crashReports.id} in (
      select id from (
        select id, row_number() over (partition by service_id order by occurred_at desc) as n from ${crashReports}
      ) where n > ${retention.crashReportsPerService}
    )`);
  db.delete(webhookDeliveries)
    .where(
      or(
        lt(webhookDeliveries.receivedAt, before(retention.webhookDeliveriesMs)),
        and(eq(webhookDeliveries.outcome, "rejected"), lt(webhookDeliveries.receivedAt, before(retention.rejectedDeliveriesMs))),
      ),
    )
    .run();
  db.delete(notificationDeliveries)
    .where(lt(notificationDeliveries.createdAt, before(retention.notificationDeliveriesMs)))
    .run();
  db.delete(alerts)
    .where(and(isNotNull(alerts.resolvedAt), lt(alerts.resolvedAt, before(retention.resolvedAlertsMs))))
    .run();

  // Log lines of old deployments, except each service's newest ones and the one it runs.
  const keep = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      sql`${deployments.id} in (
        select id from (
          select id, row_number() over (partition by service_id order by created_at desc) as n from ${deployments}
        ) where n <= ${retention.deploymentLogsKeep}
      )`,
    )
    .all()
    .map((r) => r.id);
  const live = db
    .select({ id: services.targetDeploymentId })
    .from(services)
    .where(isNotNull(services.targetDeploymentId))
    .all()
    .flatMap((r) => (r.id ? [r.id] : []));
  const old = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        lt(deployments.createdAt, before(retention.deploymentLogsMs)),
        inArray(deployments.status, ["failed", "cancelled", "superseded"]),
        ...(keep.length + live.length > 0 ? [notInArray(deployments.id, [...keep, ...live])] : []),
      ),
    )
    .orderBy(desc(deployments.createdAt))
    .all()
    .map((r) => r.id);
  for (let i = 0; i < old.length; i += 500) {
    db.delete(deploymentLogs)
      .where(inArray(deploymentLogs.deploymentId, old.slice(i, i + 500)))
      .run();
  }
}
