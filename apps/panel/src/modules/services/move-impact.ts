// What moving a service to another node does, before anyone moves it
// (services.moveImpact): why it cannot move now and, per other node, why
// it cannot go there (services.move's own checks, move.ts, so the two never
// disagree); its volumes, which are copied while it is stopped, and a
// database's size at its last whole backup; its backups; the IP:port access
// that moves to the new node's address (access-move.ts); and the services
// of its project that use its address. A database's EXPOSED_* values name
// the node's address (unless it has a TLS host name), so those services
// need a deploy; its internal address stays the same, but there is no
// private network between nodes, so only services on the new node reach it.

import { builtinVariablesFor, hostMentions, type ParsedEnv } from "@seylo/env-analyzer";
import { OpError, services as serviceOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, count, desc, eq, gt, isNotNull } from "drizzle-orm";
import { backupPolicies, backupRuns, nodes, portExposures, servicePlacements } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { findDatabase, loadDatabase } from "../databases/info";
import { nodeAddress, placedNode } from "../domains/lookup";
import { buildEnvGraph } from "../env/graph";
import { assertNoActiveCopy } from "./copies";
import { literalText } from "./impact";
import { assertNode, dataVolumes } from "./insert";
import { assertCanStartMove, assertCopyNode, assertRunsOn, movableFrom } from "./move";
import { loadService, type ServiceRow } from "./rows";

type Impact = Static<typeof serviceOps.NodeMoveImpact>;
type Refusal = Static<typeof serviceOps.NodeMoveRefusal>;

/** The refusal a check throws, null when it passes. */
function refusalOf(check: () => void): Refusal | null {
  try {
    check();
    return null;
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    const reason = error.details?.reason ?? (error.code === "UNAVAILABLE" ? "offline" : "refused");
    return { reason, message: error.message };
  }
}

/** A service of the project as the referrer search reads it. */
export interface AddressUser {
  id: string;
  name: string;
  parsed: ParsedEnv;
}

/**
 * The variables of other services that use the address of `name` (a
 * service of kind `kind`): exposed reads its EXPOSED_URL, EXPOSED_HOST or
 * EXPOSED_PORT; internal reads an internal built-in (INTERNAL_URL,
 * INTERNAL_HOST, ClickHouse's INTERNAL_HTTP_URL) or has its name typed in
 * as a host. Only services that have such a variable are listed.
 */
export function addressUsers(
  name: string,
  kind: string,
  others: readonly AddressUser[],
  selfId: string,
): { exposed: { user: AddressUser; keys: string[] }[]; internal: { user: AddressUser; keys: string[] }[] } {
  const wanted = name.toLowerCase();
  const internalVariables = new Set(
    builtinVariablesFor(kind)
      .filter((v) => v.scope === "internal")
      .map((v) => v.name),
  );
  const exposed: { user: AddressUser; keys: string[] }[] = [];
  const internal: { user: AddressUser; keys: string[] }[] = [];
  for (const user of others) {
    if (user.id === selfId) continue;
    const exposedKeys = new Set<string>();
    const internalKeys = new Set<string>();
    for (const entry of user.parsed.entries) {
      for (const ref of entry.references) {
        if (ref.target.toLowerCase() !== wanted) continue;
        if (ref.variable.startsWith("EXPOSED_")) exposedKeys.add(entry.key);
        else if (internalVariables.has(ref.variable)) internalKeys.add(entry.key);
      }
      if (hostMentions(literalText(entry), name).length > 0) internalKeys.add(entry.key);
    }
    if (exposedKeys.size > 0) exposed.push({ user, keys: [...exposedKeys] });
    if (internalKeys.size > 0) internal.push({ user, keys: [...internalKeys] });
  }
  return { exposed, internal };
}

/** What services.moveImpact returns, for this caller. */
export function nodeMoveImpact(ctx: OpContext, svc: ServiceRow): Impact {
  const volumes = dataVolumes(ctx.db, svc.id);
  const placed = ctx.db
    .select({ nodeId: servicePlacements.nodeId })
    .from(servicePlacements)
    .where(eq(servicePlacements.serviceId, svc.id))
    .all();
  const here = new Set(placed.map((p) => p.nodeId));

  const blocker = refusalOf(() => {
    const { from } = movableFrom(ctx, svc);
    assertNoActiveCopy(ctx.db, svc.id, { anySource: true });
    assertCanStartMove(ctx, svc);
    if (volumes.length > 0) assertCopyNode(ctx, from, "from");
  });
  const targets = ctx.db
    .select()
    .from(nodes)
    .orderBy(nodes.name)
    .all()
    .filter((node) => !here.has(node.id))
    .map((node) => ({
      id: node.id,
      name: node.name,
      online: ctx.agents.isOnline(node.id),
      address: nodeAddress(placedNode(node)),
      refusal: refusalOf(() => {
        assertNode(ctx.db, node.id);
        assertRunsOn(ctx, svc, node.id);
        if (volumes.length > 0) assertCopyNode(ctx, node.id, "to");
      }),
    }));

  const now = new Date();
  const backups = ctx.db
    .select({
      finishedAt: backupRuns.finishedAt,
      startedAt: backupRuns.startedAt,
      target: backupRuns.target,
      contents: backupRuns.contents,
    })
    .from(backupRuns)
    .where(and(eq(backupRuns.serviceId, svc.id), eq(backupRuns.kind, "backup"), eq(backupRuns.status, "succeeded")))
    .orderBy(desc(backupRuns.startedAt))
    .limit(50)
    .all();
  const last = backups[0];
  const measured = backups.find((b) => b.target === "database" && b.contents?.wholeServer && b.contents.databases.length > 0);
  const schedules =
    ctx.db
      .select({ n: count() })
      .from(backupPolicies)
      .where(and(eq(backupPolicies.serviceId, svc.id), eq(backupPolicies.enabled, true)))
      .get()?.n ?? 0;

  const db = findDatabase(ctx.db, svc.id) ? loadDatabase(ctx, svc.id) : null;
  const timed =
    ctx.db
      .select({ n: count() })
      .from(portExposures)
      .where(
        and(
          eq(portExposures.serviceId, svc.id),
          eq(portExposures.kind, "timed"),
          isNotNull(portExposures.expiresAt),
          gt(portExposures.expiresAt, now),
        ),
      )
      .get()?.n ?? 0;
  const firstRun =
    ctx.db
      .select({ id: portExposures.id })
      .from(portExposures)
      .where(and(eq(portExposures.serviceId, svc.id), eq(portExposures.kind, "first_run")))
      .get() !== undefined;

  // Names and keys only where the caller may see them, as services.moveProjectImpact.
  const graph = buildEnvGraph(ctx, svc.projectId);
  const users = addressUsers(
    svc.name,
    svc.kind,
    graph.services.map((s) => ({ id: s.row.id, name: s.row.name, parsed: s.parsed })),
    svc.id,
  );
  const nodesOf = new Map(graph.services.map((s) => [s.row.id, s.nodes.map((n) => n.id)]));
  const can = (action: `${string}.${string}`, id: string) => ctx.access.can(action, { type: "service", id });
  const hiddenIds = new Set<string>();
  const shown = (list: { user: AddressUser; keys: string[] }[]) =>
    list.flatMap(({ user, keys }) => {
      if (!can("services.view", user.id)) {
        hiddenIds.add(user.id);
        return [];
      }
      return [{ serviceId: user.id, name: user.name, keys: can("env.view", user.id) ? keys : [], nodeIds: nodesOf.get(user.id) ?? [] }];
    });
  const exposedReferrers = shown(users.exposed);
  const internalReferrers = shown(users.internal);

  return {
    blocker,
    targets,
    volumes: volumes.map((v) => ({ name: v.name, mountPath: v.mountPath })),
    dataSize: measured?.contents
      ? {
          bytes: measured.contents.databases.reduce((sum, d) => sum + d.sizeBytes, 0),
          measuredAt: (measured.finishedAt ?? measured.startedAt).toISOString(),
        }
      : null,
    lastBackupAt: last ? (last.finishedAt ?? last.startedAt).toISOString() : null,
    backupSchedules: schedules,
    exposure: {
      database: db?.exposure
        ? {
            port: db.exposure.listenPort > 0 ? db.exposure.listenPort : null,
            tlsHostname: db.row.tlsHostname,
            allowPlain: db.exposure.allowPlain,
          }
        : null,
      timed,
      firstRun,
    },
    exposedReferrers,
    internalReferrers,
    hiddenReferrers: hiddenIds.size,
  };
}

export const moveImpact = implement(serviceOps.moveImpact, (input, ctx) => nodeMoveImpact(ctx, loadService(ctx.db, input.serviceId)));
