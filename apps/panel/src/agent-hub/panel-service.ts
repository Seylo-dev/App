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
//   CheckEdgeAccess           whether the user of an edge tool session (a Box or a
//                             database web UI) may keep it; the agent asks about
//                             each session at most once a minute.

import { clone, create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import {
  CheckEdgeAccessRequestSchema,
  CheckEdgeAccessResponseSchema,
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
import { and, eq, sql } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import {
  agentReports,
  buildInFlight,
  builds,
  crashReports,
  deploymentInFlight,
  deployments,
  nodes,
  type CrashAction as StoredCrashAction,
  servicePlacements,
  services,
} from "../db/schema";
import type { Logger } from "../logger";
import { createRateLimiter } from "../ops/rate-limit";
import { capFields, storedReportLimits } from "./field-caps";
import type { AgentHub } from "./hub";
import { type IncomingStream, PanelServiceError, type PanelServiceHandlers } from "./panel-service-types";
import { createReportBudget, type ReportLane, reportLane, storedReportsSince } from "./report-budget";

export interface PanelServiceDeps {
  db: PanelDb;
  hub: AgentHub;
  logger: Logger;
  /** The node's current desired state, or null when `knownRevision` is already current. */
  desiredState(nodeId: string, knownRevision: bigint): DesiredState | null;
  /** A node passed its daily report budget in a lane (report-budget.ts); called once per node, lane and day. */
  reportBudgetExceeded?(nodeId: string, lane: ReportLane): void;
  /** CheckEdgeAccess: whether the ticket's user may keep the tool session ("box:<id>", "db-ui:<id>") on this node. */
  edgeAccessAllowed(nodeId: string, request: { subject: string; userId: string }): boolean;
}

const wire = (name: string) => `/${PanelService.typeName}/${name}`;

/** Every PanelService method this panel serves, by capability. */
export const panelCapabilities = ["panel.report.v1", "panel.desired.v1", "panel.registry-tunnel.v1", "panel.edge-access.v1"] as const;

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
/** GetDesiredState per node: an agent asks once per connection (catching up after a fresh start). */
const desiredBurst = 10;
const desiredPerSecond = 0.1;
/** CheckEdgeAccess per node: one a minute per open tool session; a few hundred sessions fit. */
const edgeAccessBurst = 300;
const edgeAccessPerSecond = 5;

export function createPanelService(deps: PanelServiceDeps): PanelServiceHandlers {
  const { db, hub, logger } = deps;
  const reportLimiter = createRateLimiter({
    standard: { burst: reportBurst, refillPerSecond: reportsPerSecond },
    strict: { burst: reportBurst, refillPerSecond: reportsPerSecond },
  });

  const desiredLimiter = createRateLimiter({
    standard: { burst: desiredBurst, refillPerSecond: desiredPerSecond },
    strict: { burst: desiredBurst, refillPerSecond: desiredPerSecond },
  });

  const edgeAccessLimiter = createRateLimiter({
    standard: { burst: edgeAccessBurst, refillPerSecond: edgeAccessPerSecond },
    strict: { burst: edgeAccessBurst, refillPerSecond: edgeAccessPerSecond },
  });

  const budget = createReportBudget({
    storedSince: (nodeId, lane, since) => storedReportsSince(db, nodeId, lane, since),
    onExceeded: (nodeId, lane) => {
      logger.warn({ nodeId, lane }, "node passed its daily report budget; further reports of this lane are acknowledged and dropped");
      deps.reportBudgetExceeded?.(nodeId, lane);
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
    capFields(report);
    report.lastLines = report.lastLines.slice(-maxCrashLines).map((line) => line.slice(0, maxCrashLineLength));
    report.containerId = report.containerId.slice(0, maxContainerIdLength);
    const size = JSON.stringify(report.lastLines).length + report.containerId.length;
    // Over the node's budget: acked (the agent drops it) but not stored or fanned out.
    if (!budget.allows(nodeId, "general", size)) return toBinary(ReportCrashResponseSchema, create(ReportCrashResponseSchema));
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
      budget.spend(nodeId, "general", size);
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
    capFields(event);
    // Nothing reads agent_reports back (it dedupes): a smaller copy is enough.
    const stored = toJson(EventSchema, capFields(clone(EventSchema, event), storedReportLimits)) as Record<string, unknown>;
    const size = JSON.stringify(stored).length;
    // Cron, backup and cleanup results have budgets of their own: a crash or alert flood cannot starve them.
    const lane = reportLane(event.payload.case ?? "");
    // Over the node's budget: acked (the agent drops it) but not stored or fanned out.
    if (!budget.allows(nodeId, lane, size)) return toBinary(ReportEventResponseSchema, create(ReportEventResponseSchema));
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
      budget.spend(nodeId, lane, size);
      hub.emitEvent(nodeId, event, { durable: true, outboxId });
    }
    return toBinary(ReportEventResponseSchema, create(ReportEventResponseSchema));
  };

  const getDesiredState = (nodeId: string, bytes: Uint8Array): Uint8Array => {
    // Compiling a node's state reads every service placed on it; the agent needs it once per connection.
    if (desiredLimiter.take(`node:${nodeId}`, "standard") > 0) {
      throw new PanelServiceError(StatusCode.RESOURCE_EXHAUSTED, "Too many desired state requests. The panel sends changes on its own.");
    }
    const request = fromBinary(GetDesiredStateRequestSchema, bytes);
    const state = deps.desiredState(nodeId, request.knownRevision);
    return toBinary(GetDesiredStateResponseSchema, create(GetDesiredStateResponseSchema, { state: state ?? undefined }));
  };

  const checkEdgeAccess = (nodeId: string, bytes: Uint8Array): Uint8Array => {
    if (bytes.length > 4096) throw new PanelServiceError(StatusCode.INVALID_ARGUMENT, "The request is too large.");
    if (edgeAccessLimiter.take(`node:${nodeId}`, "standard") > 0) {
      throw new PanelServiceError(StatusCode.RESOURCE_EXHAUSTED, "Too many edge access checks. Retry later.");
    }
    const request = fromBinary(CheckEdgeAccessRequestSchema, bytes);
    const allowed = deps.edgeAccessAllowed(nodeId, { subject: request.subject, userId: request.userId });
    return toBinary(CheckEdgeAccessResponseSchema, create(CheckEdgeAccessResponseSchema, { allowed }));
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
        case wire("CheckEdgeAccess"):
          return checkEdgeAccess(nodeId, request);
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
    .where(and(deploymentInFlight, sql`exists (select 1 from json_each(${deployments.targetNodeIds}) where value = ${nodeId})`))
    .all();
  const building = db
    .select({ id: deployments.serviceId })
    .from(builds)
    .innerJoin(deployments, eq(builds.deploymentId, deployments.id))
    .where(and(eq(builds.nodeId, nodeId), buildInFlight))
    .all();
  const push = [...new Set(building.map((r) => r.id))].sort();
  const pull = [...new Set([...placed, ...targeted].map((r) => r.id))].sort();
  return { nodeId, pull, push };
}
