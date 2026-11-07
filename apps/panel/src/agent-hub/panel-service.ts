// The panel's side of PanelService (panel_service.proto), the calls agents
// make to the panel:
//
//   ReportCrash, ReportEvent  durable reports from the agent's outbox. Fields
//                             capped, stored first (crash_reports, a smaller
//                             copy in agent_reports), deduped by (node, outbox
//                             id), then fanned out to modules through
//                             hub.onCrash / hub.onEvent, then acked. Past the
//                             node's daily budget (report-budget.ts) a report
//                             is acked but neither stored nor fanned out.
//   GetDesiredState           the node's current DesiredState, unless the agent
//                             already has that revision.
//   RegistryTunnel            relays a Docker pull/push from the agent's
//                             127.0.0.1:5755 to the registry container, through
//                             the panel node's agent (Tunnel with RegistryTarget).

import { clone, create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import {
  CrashAction,
  type DesiredState,
  EventSchema,
  GetDesiredStateRequestSchema,
  GetDesiredStateResponseSchema,
  PanelService,
  RegistryTunnelResponseSchema,
  ReportCrashRequestSchema,
  ReportCrashResponseSchema,
  ReportEventRequestSchema,
  ReportEventResponseSchema,
  StatusCode,
} from "@seylo/proto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import {
  agentReports,
  builds,
  crashReports,
  deployments,
  nodes,
  type CrashAction as StoredCrashAction,
  servicePlacements,
  services,
} from "../db/schema";
import type { Logger } from "../logger";
import { createRateLimiter } from "../ops/rate-limit";
import type { AgentHub } from "./hub";
import { type IncomingStream, PanelServiceError, type PanelServiceHandlers } from "./panel-service-types";
import { capReportFields, createReportBudget, storedReportLimits, storedReportsSince } from "./report-budget";

export interface PanelServiceDeps {
  db: PanelDb;
  hub: AgentHub;
  logger: Logger;
  /** The node's current desired state, or null when `knownRevision` is already current. */
  desiredState(nodeId: string, knownRevision: bigint): DesiredState | null;
  /** A node passed its daily report budget (report-budget.ts); called once per node and day. */
  reportBudgetExceeded?(nodeId: string): void;
}

const wire = (name: string) => `/${PanelService.typeName}/${name}`;

/** Every PanelService method this panel serves, by capability. */
export const panelCapabilities = ["panel.report.v1", "panel.desired.v1", "panel.registry-tunnel.v1"] as const;

const crashActions: Record<CrashAction, StoredCrashAction> = {
  [CrashAction.UNSPECIFIED]: "restarting",
  [CrashAction.RESTARTING]: "restarting",
  [CrashAction.LEFT_STOPPED]: "left_stopped",
  [CrashAction.GAVE_UP]: "gave_up",
};

/**
 * Kinds an agent sends through its durable outbox (state.Reporter): final
 * deploy and build results, cron runs, backup results, node alerts, update
 * results and scheduled cleanup runs. Progress, state, metrics and facts
 * are best-effort EVENTs.
 */
const durableKinds = new Set(["deployProgress", "buildProgress", "cronRun", "backupResult", "nodeAlert", "updateResult", "cleanupRun"]);
/** The agent's own cap on one outbox entry (state.MaxOutboxEntryBytes). */
export const maxReportBytes = 1 << 20;
const maxCrashLines = 100;
const maxCrashLineLength = 2000;
/** Docker container ids are 64 hex characters. */
const maxContainerIdLength = 128;
/** Reports per node: a burst after an outage drains, a flood is told to back off. */
const reportBurst = 600;
const reportsPerSecond = 10;

export function createPanelService(deps: PanelServiceDeps): PanelServiceHandlers {
  const { db, hub, logger } = deps;
  const reportLimiter = createRateLimiter({
    standard: { burst: reportBurst, refillPerSecond: reportsPerSecond },
    strict: { burst: reportBurst, refillPerSecond: reportsPerSecond },
  });

  const budget = createReportBudget({
    storedSince: (nodeId, since) => storedReportsSince(db, nodeId, since),
    onExceeded: (nodeId) => {
      logger.warn({ nodeId }, "node passed its daily report budget; further reports are acknowledged and dropped");
      deps.reportBudgetExceeded?.(nodeId);
    },
  });

  /** Size and rate limits shared by both Report calls. */
  const admitReport = (nodeId: string, bytes: Uint8Array) => {
    if (bytes.length > maxReportBytes) {
      throw new PanelServiceError(StatusCode.INVALID_ARGUMENT, `A report may be at most ${maxReportBytes} bytes.`);
    }
    if (reportLimiter.take(`node:${nodeId}`, "standard") > 0) {
      throw new PanelServiceError(StatusCode.RESOURCE_EXHAUSTED, "Too many reports. Retry later.");
    }
  };

  const reportCrash = (nodeId: string, bytes: Uint8Array): Uint8Array => {
    admitReport(nodeId, bytes);
    const request = fromBinary(ReportCrashRequestSchema, bytes);
    const report = request.report;
    const outboxId = request.outboxId.toString();
    if (!report) throw new PanelServiceError(StatusCode.INVALID_ARGUMENT, "report is missing");
    const service = db.select({ id: services.id }).from(services).where(eq(services.id, report.serviceId)).get();
    if (!service) {
      // A crash of a service the panel no longer knows: nothing to attach it to.
      logger.info({ nodeId, serviceId: report.serviceId }, "crash report for an unknown service dropped");
      return toBinary(ReportCrashResponseSchema, create(ReportCrashResponseSchema));
    }
    if (!hub.mayReport(nodeId, report.serviceId)) {
      // A node may report crashes of its own services only.
      throw new PanelServiceError(StatusCode.INVALID_ARGUMENT, "This service does not run on this node.");
    }
    capReportFields(report);
    report.lastLines = report.lastLines.slice(-maxCrashLines).map((line) => line.slice(0, maxCrashLineLength));
    report.containerId = report.containerId.slice(0, maxContainerIdLength);
    const size = JSON.stringify(report.lastLines).length + report.containerId.length;
    // Over the node's budget: acked (the agent drops it) but not stored or fanned out.
    if (!budget.allows(nodeId, size)) return toBinary(ReportCrashResponseSchema, create(ReportCrashResponseSchema));
    const row = db
      .insert(crashReports)
      .values({
        serviceId: report.serviceId,
        nodeId,
        outboxId,
        generation: Number(report.generation),
        containerId: report.containerId,
        exitCode: report.exitCode,
        oomKilled: report.oomKilled,
        streak: report.streak,
        action: crashActions[report.action] ?? "restarting",
        lastLines: report.lastLines,
        occurredAt: report.exitedAt ? timestampDate(report.exitedAt) : new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: crashReports.id })
      .get();
    if (row) {
      budget.spend(nodeId, size);
      hub.emitCrash(nodeId, report, { outboxId, crashId: row.id });
    }
    return toBinary(ReportCrashResponseSchema, create(ReportCrashResponseSchema));
  };

  const reportEvent = (nodeId: string, bytes: Uint8Array): Uint8Array => {
    admitReport(nodeId, bytes);
    const request = fromBinary(ReportEventRequestSchema, bytes);
    const event = request.event;
    if (!event) throw new PanelServiceError(StatusCode.INVALID_ARGUMENT, "event is missing");
    // Only durable kinds are stored; INVALID_ARGUMENT makes the agent drop the entry.
    if (!durableKinds.has(event.payload.case ?? "")) {
      throw new PanelServiceError(StatusCode.INVALID_ARGUMENT, `${event.payload.case ?? "this event"} is not a durable report.`);
    }
    const serviceId = event.payload.case === "deployProgress" || event.payload.case === "cronRun" ? event.payload.value.serviceId : null;
    if (serviceId && !hub.mayReport(nodeId, serviceId)) {
      throw new PanelServiceError(StatusCode.INVALID_ARGUMENT, "This service does not run on this node.");
    }
    const outboxId = request.outboxId.toString();
    capReportFields(event);
    // Nothing reads agent_reports back (it dedupes): a smaller copy is enough.
    const stored = toJson(EventSchema, capReportFields(clone(EventSchema, event), storedReportLimits)) as Record<string, unknown>;
    const size = JSON.stringify(stored).length;
    // Over the node's budget: acked (the agent drops it) but not stored or fanned out.
    if (!budget.allows(nodeId, size)) return toBinary(ReportEventResponseSchema, create(ReportEventResponseSchema));
    const row = db
      .insert(agentReports)
      .values({
        nodeId,
        outboxId,
        kind: event.payload.case ?? "unknown",
        event: stored,
        occurredAt: event.time ? timestampDate(event.time) : new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: agentReports.id })
      .get();
    // A retry of something already stored: ack again, tell nobody twice.
    if (row) {
      budget.spend(nodeId, size);
      hub.emitEvent(nodeId, event, { durable: true, outboxId });
    }
    return toBinary(ReportEventResponseSchema, create(ReportEventResponseSchema));
  };

  const getDesiredState = (nodeId: string, bytes: Uint8Array): Uint8Array => {
    const request = fromBinary(GetDesiredStateRequestSchema, bytes);
    const state = deps.desiredState(nodeId, request.knownRevision);
    return toBinary(GetDesiredStateResponseSchema, create(GetDesiredStateResponseSchema, { state: state ?? undefined }));
  };

  const registryTunnel = async (nodeId: string, stream: IncomingStream): Promise<Uint8Array> => {
    const panelNode = db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get();
    if (!panelNode || !hub.isOnline(panelNode.id)) {
      throw new PanelServiceError(StatusCode.UNAVAILABLE, "The node that runs the image registry is offline.");
    }
    if (!hub.supports(panelNode.id, "tunnel")) {
      throw new PanelServiceError(StatusCode.UNAVAILABLE, "The panel node's agent is too old to serve the image registry.");
    }
    // The panel node's agent reads the HTTP requests and lets through only this
    // node's repositories: no catalog, no DELETE, no other project's images.
    const scope = registryScope(db, nodeId);
    const upstream = hub.openRaw(panelNode.id, "tunnel", { target: { case: "registry", value: { scope } } });
    const onAbort = () => upstream.cancel("the agent closed its registry tunnel");
    stream.signal.addEventListener("abort", onAbort, { once: true });
    try {
      // Agent -> registry: until the agent half-closes.
      const up = (async () => {
        for (;;) {
          const chunk = await stream.channel.read();
          if (chunk === null) break;
          await upstream.writer.write(chunk);
        }
        upstream.writer.end();
      })();
      // Registry -> agent: until the registry side closes.
      const down = (async () => {
        for await (const chunk of upstream.body) await stream.channel.write(chunk);
      })();
      await Promise.all([up, down, upstream.response]);
    } catch (error) {
      upstream.cancel();
      if (stream.signal.aborted) return new Uint8Array();
      logger.warn({ err: error, nodeId, panelNodeId: panelNode.id }, "registry tunnel failed");
      throw new PanelServiceError(StatusCode.UNAVAILABLE, "The registry tunnel broke. Docker retries the pull or push.");
    } finally {
      stream.signal.removeEventListener("abort", onAbort);
    }
    return toBinary(RegistryTunnelResponseSchema, create(RegistryTunnelResponseSchema));
  };

  return {
    capabilities: panelCapabilities,
    async call(nodeId, method, request) {
      switch (method) {
        case wire("ReportCrash"):
          return reportCrash(nodeId, request);
        case wire("ReportEvent"):
          return reportEvent(nodeId, request);
        case wire("GetDesiredState"):
          return getDesiredState(nodeId, request);
        default:
          throw new PanelServiceError(StatusCode.UNIMPLEMENTED, `${method} is not a unary PanelService method of this panel.`);
      }
    },
    async open(nodeId, method, _request, stream) {
      if (method === wire("RegistryTunnel")) return registryTunnel(nodeId, stream);
      throw new PanelServiceError(StatusCode.UNIMPLEMENTED, `${method} is not a streaming PanelService method of this panel.`);
    },
  };
}

/**
 * What a node may do in the panel registry (repositories are service ids):
 * pull the services placed on it or targeted by a deployment in flight there
 * (a move's new node), push the services it is building now.
 */
export function registryScope(db: PanelDb, nodeId: string): { nodeId: string; pull: string[]; push: string[] } {
  const placed = db.select({ id: servicePlacements.serviceId }).from(servicePlacements).where(eq(servicePlacements.nodeId, nodeId)).all();
  const targeted = db
    .select({ id: deployments.serviceId })
    .from(deployments)
    .where(
      and(
        inArray(deployments.status, ["queued", "building", "deploying"]),
        sql`exists (select 1 from json_each(${deployments.targetNodeIds}) where value = ${nodeId})`,
      ),
    )
    .all();
  const building = db
    .select({ id: deployments.serviceId })
    .from(builds)
    .innerJoin(deployments, eq(builds.deploymentId, deployments.id))
    .where(and(eq(builds.nodeId, nodeId), inArray(builds.status, ["queued", "running"])))
    .all();
  const push = [...new Set(building.map((r) => r.id))].sort();
  const pull = [...new Set([...placed, ...targeted].map((r) => r.id))].sort();
  return { nodeId, pull, push };
}
