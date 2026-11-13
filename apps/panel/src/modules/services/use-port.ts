// services.usePort: "Use port 6000" in the deploy dialog of a deploy that
// failed because the app listens on another port than the service's
// (Deployment.portHint, from the agent's not_listening). The service's first
// TCP port becomes the one the app listens on, and what sent traffic to the
// old port follows: its domains, its IP:port access (the first-run port and
// open timed exposes) and its Cloudflare tunnel. Then a deploy starts.
//
// When a live version serves, its containers listen on the old port, so
// those must keep pointing there until the new containers take over: the
// move is recorded on the new deployment (deployments.port_move), applied
// by the deploy runner when it rolls out and undone, with the port, when it
// fails or is cancelled (deployments/engine.ts). Without one (a first
// deploy, a stopped service) nothing serves on the old port and they move
// at once.

import { OpError, services as serviceOps } from "@seylo/ops";
import { and, eq, inArray } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { domains, type PortMove } from "../../db/schema";
import { implement } from "../../ops/implement";
import { assertNoActiveDeploy, queueDeploy } from "../deployments/queue";
import { panelServiceId } from "../nodes/panel-service";
import { assertNoActiveCopy } from "./copies";
import { actorOf, updateSpec } from "./ops";
import { accessOn, accessText, afterDomainsMoved, moveAccess } from "./port-move";
import { loadService } from "./rows";
import { readSpec, withFirstPort } from "./spec";

export const usePort = implement(serviceOps.usePort, (input, ctx) => {
  const svc = loadService(ctx.db, input.serviceId);
  if (svc.parentId) {
    throw new OpError("CONFLICT", `${svc.name} belongs to a compose stack: change its ports in the stack's compose file.`, {
      reason: "compose",
    });
  }
  if (svc.kind !== "app" || svc.id === panelServiceId) {
    throw new OpError("CONFLICT", "Only an app service's port can be switched this way.", { reason: "notApp" });
  }
  // It deploys: the right to deploy too, like services.start of a service never deployed.
  if (!ctx.access.can("services.deploy", { type: "service", id: svc.id })) {
    throw new OpError("FORBIDDEN", "Switching the port deploys the service, which needs the services.deploy permission.", {
      action: "services.deploy",
    });
  }
  // Everything that would refuse the deploy refuses before anything changes.
  assertNoActiveDeploy(ctx, svc.id);
  assertNoActiveCopy(ctx.db, svc.id);
  const spec = readSpec(svc.spec);
  if (spec.source.type === "none") {
    throw new OpError("BAD_REQUEST", "Set a source first: a repository, an image or a Dockerfile.", { reason: "noSource" });
  }
  const from = spec.ports.find((p) => p.protocol !== "udp")?.containerPort ?? null;
  if (input.fromPort !== undefined && from !== input.fromPort) {
    throw new OpError(
      "CONFLICT",
      from === null
        ? `The service has no port now, not ${input.fromPort}. Check Ports in the Container section of its Advanced tab.`
        : `The service's port is ${from} now, not ${input.fromPort}. Check Ports in the Container section of its Advanced tab.`,
      { reason: "portChanged" },
    );
  }

  const moved =
    from === null || from === input.port
      ? []
      : ctx.db
          .select({ id: domains.id, host: domains.host, pathPrefix: domains.pathPrefix })
          .from(domains)
          .where(and(eq(domains.serviceId, svc.id), eq(domains.targetPort, from)))
          .all();
  // The IP:port access and the tunnel on the old port: without them on the new one, an app without a
  // domain has no address once it listens there (the first-run port goes with the PortSpec of its port).
  const access = from === null || from === input.port ? { exposureIds: [], tunnel: false } : accessOn(ctx.db, svc.id, from);
  // A live version listens on the old port: all of them wait for the new containers, and the port and they
  // go back if the new deployment does not go live (deployments.port_move, engine.ts restorePortMove).
  const live = svc.liveDeploymentId !== null && !svc.stopped;
  const atRollout = live && moved.length > 0;
  const ports = withFirstPort(spec.ports, input.port);
  updateSpec(ctx, svc.id, (s) => ({ ...s, ports }));
  const movesNow = !live && (moved.length > 0 || access.exposureIds.length > 0 || access.tunnel);
  if (movesNow && from !== null) {
    if (moved.length > 0) {
      ctx.db
        .update(domains)
        .set({ targetPort: input.port })
        .where(
          inArray(
            domains.id,
            moved.map((d) => d.id),
          ),
        )
        .run();
    }
    moveAccess(ctx.db, svc.id, { ...access, fromPort: from, toPort: input.port });
    afterDomainsMoved(ctx, svc.id);
  }

  const names = moved.map((d) => `${d.host}${d.pathPrefix === "/" ? "" : d.pathPrefix}`).join(", ");
  const notes = [
    from === null
      ? `The service listens on port ${input.port} now (Use port ${input.port}).`
      : `Port ${from} changed to ${input.port} (Use port ${input.port}).`,
  ];
  if (moved.length > 0) {
    notes.push(
      atRollout
        ? `${names} move${moved.length === 1 ? "s" : ""} to port ${input.port} when this deploy rolls out; the live version keeps port ${from} until then.`
        : `${names} moved to port ${input.port}.`,
    );
  }
  const others = accessText(access);
  if (others) {
    notes.push(
      live
        ? `${others} move${others.includes(" and ") ? "" : "s"} to port ${input.port} when this deploy rolls out.`
        : `${others} moved to port ${input.port}.`,
    );
  }
  const portMove: PortMove | null =
    live && from !== null && from !== input.port
      ? {
          fromPort: from,
          toPort: input.port,
          domainIds: moved.map((d) => d.id),
          exposureIds: access.exposureIds,
          tunnel: access.tunnel,
          applied: false,
        }
      : null;
  const row = queueDeploy(ctx, {
    serviceId: svc.id,
    trigger: triggerOf(ctx),
    actor: actorOf(ctx),
    triggeredBy: userOf(ctx.principal)?.id ?? null,
    notes,
    portMove,
  });
  ctx.auditDetails?.({ fromPort: from, port: input.port, domainIds: moved.map((d) => d.id), deploymentId: row.id });
  return {
    deploymentId: row.id,
    ports,
    domainIds: moved.map((d) => d.id),
    domainsMove: atRollout ? ("rollout" as const) : ("now" as const),
  };
});

function triggerOf(ctx: Parameters<typeof actorOf>[0]): "manual" | "api" {
  return ctx.principal.type === "apiKey" ? "api" : "manual";
}
