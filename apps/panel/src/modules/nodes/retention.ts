// What the panel keeps in panel.db, pruned every hour (schedule
// "nodes.pruneReports"). Every one of these tables grows with time or with
// what nodes and the internet send, and panel.db is copied on every panel
// update: durable agent events and crash reports (also capped per node, so
// one node cannot fill the disk; agent-hub/report-budget.ts bounds a day of
// them as they arrive), webhook deliveries,
// notification deliveries, resolved alerts, finished jobs (every schedule
// run leaves one) and the build and deploy output of old deployments. Deployments themselves stay (they are the history and
// the rollback targets); only their log lines go.

import { and, desc, eq, inArray, isNotNull, lt, notInArray, or, sql } from "drizzle-orm";
import { reportLaneSql } from "../../agent-hub/report-budget";
import type { PanelDb } from "../../db/client";
import { pruneFinishedJobs } from "../../jobs/queue";
import {
  agentReports,
  alerts,
  crashReports,
  deploymentLogs,
  deployments,
  notificationDeliveries,
  services,
  webhookBodies,
  webhookDeliveries,
} from "../../db/schema";
import { maxRememberedBodies, replayWindowMs } from "../webhooks/replay";

const day = 24 * 3600 * 1000;

export const retention = {
  agentReportsMs: 30 * day,
  crashReportsMs: 30 * day,
  /** Newest crash reports kept per service, whatever their age. */
  crashReportsPerService: 200,
  /** Newest durable events kept per node and report lane (general, cron; see agent-hub/report-budget.ts). */
  agentReportsPerNode: 75_000,
  /** Stored bytes kept per node, newest first: event JSON in agent_reports (per lane), crash lines in crash_reports. */
  reportBytesPerNode: 32 * 1024 * 1024,
  /** The same for the results lane (backup, cleanup and update results). */
  resultReportsPerNode: 10_000,
  resultReportBytesPerNode: 8 * 1024 * 1024,
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
  // Per node and lane: the newest rows up to a count and a size, so one node's reports stay
  // bounded and a flood in one lane (crash loops, alerts) does not push out another's rows.
  db.run(sql`
    delete from ${agentReports} where ${agentReports.id} in (
      select id from (
        select id, lane,
          row_number() over newest as n,
          sum(size) over newest as total
        from (select id, node_id, created_at, length(event) as size, ${reportLaneSql(agentReports.kind)} as lane from ${agentReports})
        window newest as (partition by node_id, lane order by created_at desc, id desc rows unbounded preceding)
      ) where case lane
        when 'results' then n > ${retention.resultReportsPerNode} or total > ${retention.resultReportBytesPerNode}
        else n > ${retention.agentReportsPerNode} or total > ${retention.reportBytesPerNode}
      end
    )`);
  db.run(sql`
    delete from ${crashReports} where ${crashReports.id} in (
      select id from (
        select id, sum(length(last_lines) + length(container_id)) over (
          partition by node_id order by occurred_at desc, id desc rows unbounded preceding
        ) as total
        from ${crashReports} where node_id is not null
      ) where total > ${retention.reportBytesPerNode}
    )`);
  db.delete(webhookDeliveries)
    .where(
      or(
        lt(webhookDeliveries.receivedAt, before(retention.webhookDeliveriesMs)),
        and(eq(webhookDeliveries.outcome, "rejected"), lt(webhookDeliveries.receivedAt, before(retention.rejectedDeliveriesMs))),
      ),
    )
    .run();
  // Replay protection only needs the last 3 days of signed bodies, and at most the newest 10,000.
  db.delete(webhookBodies)
    .where(lt(webhookBodies.seenAt, before(replayWindowMs)))
    .run();
  db.run(sql`
    delete from ${webhookBodies} where rowid in (
      select rowid from ${webhookBodies} order by seen_at desc limit -1 offset ${maxRememberedBodies}
    )`);
  db.delete(notificationDeliveries)
    .where(lt(notificationDeliveries.createdAt, before(retention.notificationDeliveriesMs)))
    .run();
  db.delete(alerts)
    .where(and(isNotNull(alerts.resolvedAt), lt(alerts.resolvedAt, before(retention.resolvedAlertsMs))))
    .run();
  pruneFinishedJobs(db, now);

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
