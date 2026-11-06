// The desired-state compiler: DB rows -> the DesiredState one node should
// run (proto/seylo/agent/v1/desired.proto). Pure database reads, no agent
// calls, so it is tested on an in-memory database.
//
// It is assembled from the modules that own the rows:
//
//   services          serviceSpecFor(db, secrets, serviceId, nodeId) in
//                     modules/services/desired.ts: the base ServiceSpec (image by
//                     target deployment, container, volumes, files, ports, health,
//                     crash policy, resources, replicas, deploy strategy, compose
//                     member and cron kind specs). null = nothing runs here.
//   cron_jobs         ServiceSpec.cron_jobs, mapped here
//   nodes             NodeSettings, mapped here; ServiceSpec.load_balancer URLs of
//                     copies on other nodes (their public address, through their edge)
//   contributors      the rest, from the modules that own it (contributors.ts):
//                     networking sets env (references resolved), routing, dev access,
//                     public ports, database and Box runtime, global maintenance
//
// A new table whose rows must reach agents gets a contributor in its own
// module.

import { create } from "@bufbuild/protobuf";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import {
  CronConcurrency,
  CronJobSchema,
  type DesiredState,
  DesiredStateSchema,
  type NodeSettings,
  NodeSettingsSchema,
  type ServiceSpec,
} from "@seylo/proto";
import { asc, eq, inArray } from "drizzle-orm";
import type { PanelDb } from "../db/client";
import { cronJobs, nodes, services, users } from "../db/schema";
import { nodeAddress, privateIpv4Of } from "../modules/domains/lookup";
import { serviceSpecFor, servicesOnNode } from "../modules/services";
import type { SecretBox } from "../security/secret-box";
import { getSetting } from "../settings";
import type { DesiredContributor } from "./contributors";

export interface CompileOptions {
  /** Revision to stamp on the result (nodes.desired_revision after the bump). */
  revision: bigint;
  secrets: SecretBox;
  contributors?: readonly DesiredContributor[];
}

const seconds = (n: number) => durationFromMs(n * 1000);

/** Ids of the services placed on the node, sorted (some may not be runnable yet). */
export function placedServiceIds(db: PanelDb, nodeId: string): string[] {
  return [...new Set(servicesOnNode(db, nodeId))].sort();
}

export function compileDesiredState(db: PanelDb, nodeId: string, options: CompileOptions): DesiredState {
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node) throw new Error(`node ${nodeId} does not exist`);

  const specs: ServiceSpec[] = [];
  for (const serviceId of placedServiceIds(db, nodeId)) {
    const spec = compileServiceSpec(db, nodeId, serviceId, options);
    if (spec) specs.push(spec);
  }
  const projectIds = [...new Set(specs.map((s) => s.projectId))].sort();
  return create(DesiredStateSchema, {
    revision: options.revision,
    services: specs,
    networks: projectIds.map((projectId) => ({ projectId })),
    settings: compileNodeSettings(db, node, options),
  });
}

export function compileNodeSettings(db: PanelDb, node: typeof nodes.$inferSelect, options: CompileOptions): NodeSettings {
  const owner = db.select({ email: users.email }).from(users).where(eq(users.role, "owner")).orderBy(asc(users.createdAt)).get();
  const out = create(NodeSettingsSchema, {
    gamesFirstCpu: node.gamesFirstCpu,
    acmeEmail: owner?.email ?? "",
    wildcardDomain: node.wildcardDomain ?? "",
    logRetention: { maxBytesPerService: BigInt(node.logMaxBytesPerService), maxAge: seconds(node.logMaxAgeDays * 86_400) },
    // 0 tells the agent this node does not build.
    maxParallelBuilds: node.canBuild ? node.maxParallelBuilds : 0,
    // Agents older than the panel update themselves after they connect.
    autoUpdate: getSetting(db, "autoUpdate") ?? false,
  });
  for (const contributor of options.contributors ?? []) {
    contributor.node?.({ db, secrets: options.secrets, nodeId: node.id, settings: out });
  }
  return out;
}

/** One service's spec for one node, or null when nothing of it runs there. */
export function compileServiceSpec(db: PanelDb, nodeId: string, serviceId: string, options: CompileOptions): ServiceSpec | null {
  const spec = serviceSpecFor(db, options.secrets, serviceId, nodeId);
  if (!spec) return null;
  const service = db.select().from(services).where(eq(services.id, serviceId)).get();
  if (!service) return null;
  addCronJobs(db, spec);
  fillRemoteUpstreams(db, spec);
  for (const contributor of options.contributors ?? []) {
    contributor.service?.({ db, secrets: options.secrets, nodeId, service, spec });
  }
  return spec;
}

const concurrency = { forbid: CronConcurrency.FORBID, allow: CronConcurrency.ALLOW, replace: CronConcurrency.REPLACE } as const;

/** Scheduled commands of the service (cron_jobs), run by the agent next to it. */
function addCronJobs(db: PanelDb, spec: ServiceSpec): void {
  const jobs = db.select().from(cronJobs).where(eq(cronJobs.serviceId, spec.id)).orderBy(asc(cronJobs.id)).all();
  spec.cronJobs = jobs.map((job) =>
    create(CronJobSchema, {
      id: job.id,
      schedule: job.schedule,
      timeZone: job.timeZone,
      command: ["sh", "-c", job.command],
      timeout: seconds(job.timeoutSeconds),
      concurrency: concurrency[job.concurrency] ?? CronConcurrency.FORBID,
      disabled: !job.enabled,
    }),
  );
}

/** Copies on other nodes are reached through that node's edge (there is no cross-node private network). */
/** The seylo-lb entry point of a node's own Traefik (go/internal/proxy DefaultLBPort). */
const lbPort = 5757;

function sharesWingsProxy(facts: unknown): boolean {
  const wings = (facts as { wings?: { traefikDynamicDir?: string } } | null)?.wings;
  return Boolean(wings?.traefikDynamicDir);
}

function fillRemoteUpstreams(db: PanelDb, spec: ServiceSpec): void {
  const upstreams = spec.loadBalancer?.remoteUpstreams ?? [];
  const missing = upstreams.filter((u) => !u.url).map((u) => u.nodeId);
  if (!spec.loadBalancer || missing.length === 0) return;
  // The other node's own Traefik serves its local replicas on the seylo-lb
  // entry point (TLS, :5757). Nodes sharing the Wings Traefik have none.
  const addresses = new Map(
    db
      .select({ id: nodes.id, ipv4: nodes.publicIpv4, ipv6: nodes.publicIpv6, publicAddress: nodes.publicAddress, facts: nodes.facts })
      .from(nodes)
      .where(inArray(nodes.id, missing))
      .all()
      .map((n) => {
        // Nodes on one private network (no public address) reach each other privately.
        const host = nodeAddress({ ...n, privateIpv4: privateIpv4Of(n.facts) }) ?? "";
        return [n.id, host && !sharesWingsProxy(n.facts) ? `https://${host}:${lbPort}` : ""];
      }),
  );
  for (const upstream of upstreams) if (!upstream.url) upstream.url = addresses.get(upstream.nodeId) ?? "";
  // A copy without a known address cannot be reached; leave it out rather than send an empty URL.
  spec.loadBalancer.remoteUpstreams = upstreams.filter((u) => u.url);
}
