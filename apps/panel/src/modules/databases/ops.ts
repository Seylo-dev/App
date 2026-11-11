// Database op handlers: the engine catalog, create a database service with
// generated credentials, read it, its connection details, password resets
// (applied inside the running database through the agent's Exec, or by the
// restart a new environment causes), the web UI and shell links, and TLS
// exposure through the agent's portgate, which uses the database's own user.

import { timestampDate } from "@bufbuild/protobuf/wkt";
import { parseEnv } from "@seylo/env-analyzer";
import { databases as dbOps, domains as domainOps, env as envOps, exposures as exposureOps, OpError, terminals } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, eq, ne } from "drizzle-orm";
import type { AgentHub } from "../../agent-hub/hub";
import { userOf } from "../../auth/principal";
import { portExposures, serviceDatabases, services } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { queueDeploy } from "../deployments/queue";
import { normalizeCidrs } from "../domains/checks";
import { invalidateService } from "../domains/lookup";
import { assertHostUnclaimed } from "../domains/ownership";
import { issuerName } from "../domains/rows";
import { readServiceEnv } from "../env/store";
import { assertCreateRights } from "../services/create-rights";
import { insertService } from "../services/insert";
import { publishService } from "../services/ops";
import { defaultContainer } from "../services/spec";
import terminalsModule from "../terminals";
import { missingExposureCapability, nodeHasCapability } from "./capability";
import { edgeToolLink } from "./edge-ticket";
import {
  changePasswordExec,
  containerCommand,
  defaultDatabaseName,
  engines,
  enginesCapability,
  engineVersion,
  engineVersions,
  exposureCapability,
  exposureRefusal,
  generatePassword,
  generateUserName,
  healthProbe,
} from "./engines";
import {
  adminPasswordSecret,
  type DatabaseInfo,
  exposedAddress,
  exposedConnection,
  internalConnection,
  loadDatabase,
  writeSecret,
} from "./info";

type Database = Static<typeof dbOps.Database>;

const hostnamePattern = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** What the node reports about a database: its web UI and the exposed port's certificate. */
function reported(agents: AgentHub | undefined, info: DatabaseInfo) {
  const status = agents?.state.serviceStatuses(info.service.id).find((s) => !info.node || s.nodeId === info.node.id)?.status;
  const port =
    info.exposure && info.exposure.listenPort > 0 ? status?.openPorts.find((p) => p.hostPort === info.exposure?.listenPort) : undefined;
  const webUi = status?.webUi;
  return {
    webUiRunning: webUi?.running ?? false,
    webUiActiveAt: webUi?.running && webUi.lastActiveAt ? timestampDate(webUi.lastActiveAt).toISOString() : null,
    certIssuer: port?.certificateIssuer ? issuerName(port.certificateIssuer) : null,
    certExpiresAt: port?.certificateExpiresAt ? timestampDate(port.certificateExpiresAt) : null,
  };
}

export function toDatabase(info: DatabaseInfo, agents?: AgentHub, now = new Date()): Database {
  const address = exposedAddress(info);
  const internal = internalConnection(info);
  const seen = reported(agents, info);
  const certificate: Database["exposure"]["certificate"] =
    info.exposure === null
      ? "none"
      : !info.row.tlsHostname
        ? "selfSigned"
        : seen.certExpiresAt && seen.certExpiresAt.getTime() > now.getTime() && !seen.certIssuer?.includes("self")
          ? "valid"
          : "pending";
  return {
    serviceId: info.service.id,
    projectId: info.service.projectId,
    name: info.service.name,
    engine: info.row.engine,
    version: info.row.version,
    variant: info.row.variant,
    nodeId: info.node?.id ?? "",
    nodeName: info.node?.name ?? "",
    internal: {
      host: internal.host,
      port: internal.port,
      database: internal.database,
      user: internal.user,
      httpPort: info.engine.httpPort,
    },
    shellClient: info.engine.shellClient,
    exposure: {
      enabled: info.exposure !== null,
      host: address?.host ?? null,
      port: address?.port ?? null,
      user: info.admin.user,
      allowedCidrs: info.exposure?.allowedCidrs ?? [],
      needsAllowedCidrs: info.engine.exposureNeedsAllowlist,
      tlsHostname: info.row.tlsHostname,
      certificate,
      certificateIssuer: seen.certIssuer,
      certificateExpiresAt: seen.certExpiresAt?.toISOString() ?? null,
    },
    webUi: {
      tool: info.engine.webUiTool,
      idleMinutes: info.row.webUiIdleMinutes,
      running: seen.webUiRunning,
      lastActiveAt: seen.webUiActiveAt,
    },
    createdAt: info.row.createdAt.toISOString(),
  };
}

function afterChange(ctx: OpContext, info: { service: { id: string; projectId: string } }) {
  ctx.agents.desired.markDirty({ serviceId: info.service.id });
  invalidateService(ctx, info.service.id, [dbOps.get.id, dbOps.connection.id, exposureOps.get.id, envOps.references.id]);
}

export const listEngines = implement(dbOps.engines, () => ({
  engines: Object.values(engines).map((e) => ({
    engine: e.engine,
    label: e.label,
    port: e.port,
    versions: e.versions.map(({ version, image }) => ({ version, image })),
    variants: e.variants.map((v) => ({ id: v.id, label: v.label, versions: v.versions.map(({ version, image }) => ({ version, image })) })),
    defaultUser: e.defaultUser,
    hasDatabase: e.hasDatabase,
    shellClient: e.shellClient,
    webUiTool: e.webUiTool,
    notice: e.notice,
  })),
}));

export const create = implement(dbOps.create, (input, ctx) => {
  const engine = engines[input.engine];
  const versions = engineVersions(input.engine, input.variant);
  if (!versions) {
    const offered = engine.variants.map((v) => v.id);
    throw new OpError(
      "BAD_REQUEST",
      offered.length
        ? `${engine.label} has no ${input.variant} image. Pick ${offered.join(" or ")}, or leave the variant out.`
        : `${engine.label} has no image variants.`,
      { field: "variant" },
    );
  }
  const version = engineVersion(input.engine, input.version, input.variant);
  if (!version) {
    throw new OpError(
      "BAD_REQUEST",
      `${engine.label}${input.variant ? ` with ${input.variant}` : ""} ${input.version} is not offered. Pick one of ${versions.map((v) => v.version).join(", ")}.`,
      { field: "version" },
    );
  }
  if (engine.redisLike && input.user && input.user !== "default") {
    throw new OpError("BAD_REQUEST", `${engine.label} has one user, default.`, { field: "user" });
  }
  // An older agent would run it without its shell, web UI, backups or TLS on the exposed port.
  if (engine.needsAgentCapability && !nodeHasCapability(ctx.db, ctx.agents, input.nodeId, enginesCapability)) {
    throw new OpError(
      "CONFLICT",
      `The agent on this node does not run ${engine.label} yet. Update the node (or wait until it has connected once), then try again.`,
      { field: "nodeId", reason: "agentTooOld" },
    );
  }
  const password = input.password ?? generatePassword();
  // A database starts right away: that first deploy is services.deploy. Its env is the panel's own (credentials).
  assertCreateRights(ctx, { type: "project", id: input.projectId }, { deploy: true });
  const user = userOf(ctx.principal);
  const serviceId = ctx.db.transaction((tx) => {
    const row = insertService(tx, {
      projectId: input.projectId,
      name: input.name,
      kind: input.engine,
      nodeId: input.nodeId,
      createdBy: user?.id ?? null,
      volumes: [{ name: "data", mountPath: version.dataPath }],
      spec: {
        source: { type: "image", image: version.image, registryId: null },
        container: { ...defaultContainer, command: containerCommand(input.engine), entrypoint: [], stopGraceSeconds: 30 },
        ports: [{ containerPort: engine.port, protocol: "tcp" }],
        healthCheck: {
          probe: healthProbe(input.engine),
          intervalSeconds: 10,
          timeoutSeconds: 5,
          startPeriodSeconds: 60,
          failureThreshold: 6,
        },
        // Two copies must never share one data folder.
        deploy: { mode: "recreate", healthTimeoutSeconds: 300 },
      },
    });
    tx.insert(serviceDatabases)
      .values({
        serviceId: row.id,
        engine: input.engine,
        version: version.version,
        variant: input.variant ?? null,
        databaseName: engine.hasDatabase ? (input.database ?? defaultDatabaseName(input.name)) : "",
        adminUser: input.user ?? engine.defaultUser ?? generateUserName(input.engine === "clickhouse" ? "ch" : "admin"),
        // Exposure uses the admin user; only databases from before 0.2.9 name a separate one (retired by the agent).
        exposedUser: "",
      })
      .run();
    writeSecret(tx, ctx.secrets, row.id, adminPasswordSecret, password);
    return row.id;
  });
  // Start it right away: a database has nothing to build.
  queueDeploy(ctx, { serviceId, trigger: "manual", actor: user?.email ?? null, triggeredBy: user?.id ?? null });
  // The sidebar and the dashboard count it at once (the panel topic), the project's screens list it.
  publishService(ctx, { id: serviceId, projectId: input.projectId });
  ctx.live.publish(`project:${input.projectId}`, { type: "invalidate", ops: [envOps.references.id] });
  return toDatabase(loadDatabase(ctx, serviceId), ctx.agents);
});

export const get = implement(dbOps.get, (input, ctx) => toDatabase(loadDatabase(ctx, input.serviceId), ctx.agents));

export const connection = implement(dbOps.connection, (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  return { internal: internalConnection(info), exposed: exposedConnection(info) };
});

/** The references that carry the database's password: inside and through the exposed port alike. */
const credentialVariables = ["PASSWORD", "INTERNAL_URL", "INTERNAL_HTTP_URL", "EXPOSED_URL"];

/** Services of the project whose env uses this database's credentials. */
function servicesUsingCredentials(ctx: OpContext, info: DatabaseInfo): string[] {
  const name = info.service.name.toLowerCase();
  const rows = ctx.db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.projectId, info.service.projectId), ne(services.id, info.service.id)))
    .all();
  return rows
    .filter((row) =>
      parseEnv(readServiceEnv(ctx.db, ctx.secrets, row.id).text).entries.some((e) =>
        e.references.some((r) => r.target.toLowerCase() === name && credentialVariables.includes(r.variable)),
      ),
    )
    .map((row) => row.id);
}

export const resetPassword = implement(dbOps.resetPassword, async (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  const password = input.password ?? generatePassword();
  // One user inside and through the exposed port: user "exposed" (kept for older callers) changes it too.
  // Engines that read the password from their environment take it with the restart the new env causes.
  const exec = changePasswordExec(info.row.engine, info.admin.user, password);
  if (exec) {
    if (!info.node) throw new OpError("CONFLICT", "The database is not placed on a node.", { reason: "noNode" });
    // Change it inside the running database first; only store it once that worked.
    const result = await ctx.agents.call(
      info.node.id,
      "exec",
      { serviceId: info.service.id, command: exec.command, stdin: new TextEncoder().encode(exec.stdin), timeout: { seconds: 30n } },
      { timeoutMs: 45_000, metadata: { actor: userOf(ctx.principal)?.id ?? "" } },
    );
    if (result.exitCode !== 0) {
      ctx.logger.warn({ serviceId: info.service.id, exitCode: result.exitCode }, "database password change failed");
      throw new OpError("CONFLICT", "The database refused the password change. Check that it is running and try again.", {
        reason: "execFailed",
        exitCode: String(result.exitCode),
      });
    }
  }
  ctx.db.transaction((tx) => {
    writeSecret(tx, ctx.secrets, info.service.id, adminPasswordSecret, password);
  });
  afterChange(ctx, info);
  return { password, affectedServiceIds: servicesUsingCredentials(ctx, info) };
});

export const openWebUi = implement(dbOps.openWebUi, (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  if (!info.node) throw new OpError("CONFLICT", "The database is not placed on a node.", { reason: "noNode" });
  const link = edgeToolLink(ctx, "db", info.service.id, info.node, ctx.principal);
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
});

export const openShell = implement(dbOps.openShell, async (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  // The terminals module issues shell tickets; databaseClient makes the agent start the engine's client signed in.
  const handler = terminalsModule.ops.find((op) => op.contract.id === terminals.openShell.id);
  if (!handler) throw new OpError("NOT_IMPLEMENTED", "Shells are not available on this panel yet.", { feature: "terminals.shell" });
  const ticket = (await handler.run({ serviceId: info.service.id, databaseClient: true }, ctx)) as Static<typeof terminals.TerminalTicket>;
  return { ticket: ticket.ticket, socketPath: ticket.url, client: info.engine.shellClient, expiresAt: ticket.expiresAt };
});

export const setExposure = implement(dbOps.setExposure, (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  if (!info.node) throw new OpError("CONFLICT", "The database is not placed on a node.", { reason: "noNode" });
  const node = info.node;
  const noTls = input.enabled ? exposureRefusal(info.row) : null;
  if (noTls) throw new OpError("CONFLICT", noTls, { reason: "noTls" });
  // An older agent would relay the port without TLS (or without checking that clients ask for it); the
  // desired state leaves it closed there anyway.
  const missing = input.enabled ? missingExposureCapability(ctx.db, ctx.agents, info.engine, node.id) : null;
  if (missing) {
    throw new OpError(
      "CONFLICT",
      missing === exposureCapability
        ? `The agent on ${node.name} cannot expose ${info.engine.label} with its own user over TLS yet. Update the node first.`
        : `The agent on ${node.name} cannot expose ${info.engine.label} with TLS yet. Update the node first.`,
      { reason: "agentTooOld" },
    );
  }
  const tlsHostname = input.tlsHostname === undefined ? info.row.tlsHostname : input.tlsHostname?.toLowerCase() || null;
  if (tlsHostname && !hostnamePattern.test(tlsHostname)) {
    throw new OpError("BAD_REQUEST", `${tlsHostname} is not a host name.`, { field: "tlsHostname" });
  }
  // The node routes tlsHostname for its ACME certificate, so it must not be anyone else's host.
  if (tlsHostname && tlsHostname !== info.row.tlsHostname) {
    assertHostUnclaimed(ctx.db, tlsHostname, { field: "tlsHostname", exceptDatabaseOf: info.service.id });
  }
  const cidrs = input.allowedCidrs === undefined ? (info.exposure?.allowedCidrs ?? []) : normalizeCidrs(input.allowedCidrs);
  // An engine with known, unfixed holes (KeyDB) is never open to anyone with the password.
  if (input.enabled && info.engine.exposureNeedsAllowlist && cidrs.length === 0) {
    throw new OpError(
      "BAD_REQUEST",
      `${info.engine.label} gets no security fixes, so it can only be exposed to listed addresses. Add allowed IPs or CIDRs.`,
      { field: "allowedCidrs", reason: "allowlistRequired" },
    );
  }
  ctx.db.transaction((tx) => {
    tx.update(serviceDatabases).set({ tlsHostname }).where(eq(serviceDatabases.serviceId, info.service.id)).run();
    if (!input.enabled) {
      tx.delete(portExposures)
        .where(and(eq(portExposures.serviceId, info.service.id), eq(portExposures.kind, "database")))
        .run();
      return;
    }
    const port = input.port ?? info.exposure?.listenPort ?? 0;
    if (port > 0) {
      const taken = tx
        .select({ id: portExposures.id, serviceId: portExposures.serviceId, kind: portExposures.kind })
        .from(portExposures)
        .where(and(eq(portExposures.nodeId, node.id), eq(portExposures.listenPort, port)))
        .all()
        .find((r) => !(r.serviceId === info.service.id && r.kind === "database"));
      if (taken) throw new OpError("CONFLICT", `Port ${port} is already open on ${node.name}.`, { field: "port" });
    }
    if (info.exposure) {
      tx.update(portExposures)
        .set({ listenPort: port, allowedCidrs: cidrs, tls: true })
        .where(eq(portExposures.id, info.exposure.id))
        .run();
    } else {
      tx.insert(portExposures)
        .values({
          serviceId: info.service.id,
          nodeId: node.id,
          kind: "database",
          listenPort: port,
          targetPort: info.engine.port,
          allowedCidrs: cidrs,
          tls: true,
          createdBy: userOf(ctx.principal)?.id ?? null,
        })
        .run();
    }
  });
  afterChange(ctx, info);
  invalidateService(ctx, info.service.id, [domainOps.list.id]);
  return toDatabase(loadDatabase(ctx, info.service.id), ctx.agents);
});
