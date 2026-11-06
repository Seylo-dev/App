// The services module's part of a node's DesiredState: service rows -> the
// proto ServiceSpec of one service on one node. The desired-state compiler
// (desired/compile.ts) calls serviceSpecFor for every placement on the
// node and fills in what other modules own: env, routing, dev access,
// public ports and database settings (domains/desired.ts
// serviceNetworking), cron jobs and backups.
//
// What it sets: id, project, name, kind, generation, stopped, protected,
// image (by digest, with registry login), container, volumes, file mounts,
// ports, health check, crash policy, resources, replicas, load balancer
// (other nodes of the service, sticky sessions), deploy strategy and the
// kind spec of compose members and cron services.
//
// Run settings come from the target deployment's snapshot, so changes wait
// for the next deploy; crash policy, stopped and replicas are current.
// Databases and Boxes are placed and returned even without a deployment;
// databaseRuntime/boxRuntime replace their image, env and ports. A stopped
// service that was never deployed (a clone) is returned stopped with no
// image, so its node keeps its folders.

import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import { CronConcurrency, DeployMode, PortProtocol, ServiceKind, type ServiceSpec, ServiceSpecSchema } from "@seylo/proto";
import { and, eq, inArray } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { deployments, servicePlacements, services, volumes } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";
import { openRegistryLogin } from "../registries";
import { entryNodeOf } from "./rows";
import { registryMatches } from "./source-guard";
import { type RunSettings, readRunSettings, readSpec, restartDelaySeconds } from "./spec";

export type ServiceSpecInit = MessageInitShape<typeof ServiceSpecSchema>;

const kinds: Record<string, ServiceKind> = {
  app: ServiceKind.APP,
  cron: ServiceKind.CRON,
  postgres: ServiceKind.DATABASE,
  mysql: ServiceKind.DATABASE,
  mariadb: ServiceKind.DATABASE,
  mongo: ServiceKind.DATABASE,
  redis: ServiceKind.DATABASE,
  box: ServiceKind.BOX,
};

/** Kinds whose image and settings come from their own module (databases, boxes), not from deployments. */
const runtimeKinds = new Set(["postgres", "mysql", "mariadb", "mongo", "redis", "box"]);

const seconds = (n: number) => durationFromMs(n * 1000);

/**
 * The ServiceSpec of one service on one node, or null when nothing of it
 * should run there: not placed on the node, never deployed, or a compose
 * stack (its members run instead).
 */
export function serviceSpecFor(db: PanelDb, secrets: SecretBox, serviceId: string, nodeId: string): ServiceSpec | null {
  const svc = db.select().from(services).where(eq(services.id, serviceId)).get();
  if (!svc || svc.kind === "compose") return null;
  // Databases and Boxes run from their module's runtime (image, env, ports) and need no deployment.
  const ownRuntime = runtimeKinds.has(svc.kind);
  // A stopped service that was never deployed (a clone) goes as a stopped spec without an image, so
  // its node keeps the folders a data copy fills instead of sweeping them as an orphan's.
  const parked = svc.stopped && !svc.targetDeploymentId;
  if (!svc.targetDeploymentId && !ownRuntime && !parked) return null;
  const placements = db.select().from(servicePlacements).where(eq(servicePlacements.serviceId, serviceId)).all();
  const here = placements.find((p) => p.nodeId === nodeId);
  if (!here) return null;
  const found = svc.targetDeploymentId ? db.select().from(deployments).where(eq(deployments.id, svc.targetDeploymentId)).get() : undefined;
  if (!found?.imageRef && !ownRuntime && !parked) return null;
  const target = found ?? { imageRef: "", imageDigest: null, generation: Math.max(1, svc.generation), runSettings: null };

  const spec = readSpec(svc.spec);
  const run: RunSettings = readRunSettings(target.runSettings, spec);
  const kind = run.member ? ServiceKind.COMPOSE_MEMBER : (kinds[svc.kind] ?? ServiceKind.APP);
  // A registry login only goes to its own registry, whatever the stored image says.
  const opened = spec.source.type === "image" && spec.source.registryId ? openRegistryLogin(db, secrets, spec.source.registryId) : null;
  const registry = opened && spec.source.type === "image" && registryMatches(opened.server, spec.source.image) ? opened : null;
  const mounts = db.select().from(volumes).where(eq(volumes.serviceId, serviceId)).all();

  // Moving away with volumes: this node keeps its copy stopped (and its data) until the new node is live.
  const leaving =
    db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, serviceId),
          eq(deployments.trigger, "move"),
          eq(deployments.movedFromNodeId, nodeId),
          inArray(deployments.status, ["queued", "building", "deploying"]),
        ),
      )
      .get() !== undefined && mounts.some((v) => v.kind === "volume");

  const init: ServiceSpecInit = {
    id: svc.id,
    projectId: svc.projectId,
    name: svc.name,
    kind,
    generation: BigInt(Math.max(1, target.generation)),
    stopped: svc.stopped || leaving,
    protected: svc.protected,
    image: { reference: target.imageRef ?? "", digest: target.imageDigest ?? "", auth: registry ?? undefined },
    container: {
      command: run.container.command,
      entrypoint: run.container.entrypoint,
      workingDir: run.container.workingDir,
      user: run.container.user,
      stopSignal: run.container.stopSignal,
      stopGracePeriod: seconds(run.container.stopGraceSeconds),
    },
    volumes: mounts
      .filter((v) => v.kind === "volume")
      .map((v) => ({ name: v.name, containerPath: v.mountPath, readOnly: v.readOnly, ownerServiceId: v.ownerServiceId ?? "" })),
    files: mounts
      .filter((v) => v.kind === "file")
      .map((v) => ({
        containerPath: v.mountPath,
        content: new TextEncoder().encode(v.contentSealed ? (secrets.open(v.contentSealed, "volume.file") ?? "") : ""),
        mode: 0o644,
      })),
    ports: run.ports.map((p) => ({ containerPort: p.containerPort, protocol: p.protocol === "udp" ? PortProtocol.UDP : PortProtocol.TCP })),
    healthCheck: run.healthCheck ? healthCheckOf(run.healthCheck) : undefined,
    crashPolicy: {
      restart: spec.crashPolicy.restart,
      stopAfterCrashes: spec.crashPolicy.stopAfterCrashes,
      restartDelay: seconds(restartDelaySeconds),
    },
    resources: {
      memoryLimitBytes: run.resources.memoryLimitBytes === null ? undefined : BigInt(run.resources.memoryLimitBytes),
      memoryReservationBytes: run.resources.memoryReservationBytes === null ? undefined : BigInt(run.resources.memoryReservationBytes),
      cpuWeight: run.resources.cpuWeight ?? undefined,
      pidsLimit: run.resources.pidsLimit ?? undefined,
    },
    replicas: here.replicas,
    loadBalancer: {
      // URLs of copies on other nodes go through their edge; the routing owner fills them in.
      // With an entry node only it balances over the other nodes; without one every node does.
      remoteUpstreams: [nodeId, null].includes(entryNodeOf(spec.entryNodeId, placements))
        ? placements.filter((p) => p.nodeId !== nodeId).map((p) => ({ nodeId: p.nodeId, url: "" }))
        : [],
      stickySessions: spec.stickySessions,
    },
    deploy: {
      mode: run.deploy.mode === "recreate" ? DeployMode.RECREATE : DeployMode.ROLLING,
      healthTimeout: seconds(run.deploy.healthTimeoutSeconds),
    },
  };

  if (run.member) {
    // Members reach each other by their compose names, as in the compose file.
    init.networkAliases = [run.member.composeService];
    init.kindSpec = {
      case: "composeMember",
      value: { stackId: svc.parentId ?? "", composeService: run.member.composeService, dependsOn: run.member.dependsOn },
    };
  } else if (svc.kind === "cron" && run.cron) {
    init.kindSpec = {
      case: "cron",
      value: {
        schedule: run.cron.schedule,
        timeZone: run.cron.timeZone,
        timeout: seconds(run.cron.timeoutSeconds),
        concurrency:
          run.cron.concurrency === "allow"
            ? CronConcurrency.ALLOW
            : run.cron.concurrency === "replace"
              ? CronConcurrency.REPLACE
              : CronConcurrency.FORBID,
      },
    };
    if (run.cron.command.length > 0) init.container = { ...init.container, command: run.cron.command };
  }
  return create(ServiceSpecSchema, init);
}

function healthCheckOf(h: NonNullable<RunSettings["healthCheck"]>): NonNullable<ServiceSpecInit["healthCheck"]> {
  const probe =
    h.probe.type === "tcp"
      ? { case: "tcp" as const, value: { port: h.probe.port } }
      : h.probe.type === "http"
        ? {
            case: "http" as const,
            value: { port: h.probe.port, path: h.probe.path, host: h.probe.host, expectedStatus: h.probe.expectedStatus },
          }
        : { case: "command" as const, value: { command: h.probe.command } };
  return {
    probe,
    interval: seconds(h.intervalSeconds),
    timeout: seconds(h.timeoutSeconds),
    startPeriod: seconds(h.startPeriodSeconds),
    failureThreshold: h.failureThreshold,
  };
}

/** Service ids placed on a node whose spec the compiler should ask for. */
export function servicesOnNode(db: PanelDb, nodeId: string): string[] {
  return db
    .select({ id: servicePlacements.serviceId })
    .from(servicePlacements)
    .innerJoin(services, eq(services.id, servicePlacements.serviceId))
    .where(and(eq(servicePlacements.nodeId, nodeId)))
    .all()
    .map((r) => r.id);
}
