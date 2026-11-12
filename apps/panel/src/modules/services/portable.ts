// Creating a service from a full description, in one transaction, and the
// spec a copy of a service keeps. Clones (clone.ts) and imports from an
// exported file (modules/serviceTransfer) both create through
// materializeService, so they write the same rows the same way: the
// service row (always stopped and never deployed), volumes and file mounts
// (re-sealed), the .env, a database's facts and logins, a Box's facts,
// domains, and what only an import brings along (IP:port access settings,
// database listeners, a tunnel, the maintenance page, cron jobs, uptime
// checks, alert rules, backup policies and a deploy trigger).
//
// The caller decides what goes in and checks the rules for it (permissions,
// validation, names, hosts); this file only writes. A throw anywhere rolls
// the whole service back with the caller's transaction, and no node heard
// of it yet.

import { and, eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import {
  alertRules,
  backupPolicies,
  cloudflareTunnels,
  cronJobs,
  deployTriggers,
  type domains,
  maintenancePages,
  portExposures,
  type ServiceKind,
  serviceAccess,
  serviceBoxes,
  serviceDatabases,
  services,
  uptimeChecks,
  volumes,
} from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";
import { hashToken, randomToken } from "../../security/tokens";
import { writeSecret } from "../databases/info";
import { insertDomain } from "../domains/ops";
import type { HostCaller } from "../domains/ownership";
import type { DomainRow } from "../domains/rows";
import { writeServiceEnv } from "../env/store";
import { insertService } from "./insert";
import type { ServiceSpecJson } from "./spec";

type Insert<T extends { $inferInsert: unknown }, Omitted extends string> = Omit<T["$inferInsert"], Omitted>;

export interface Materialize {
  projectId: string;
  name: string;
  kind: ServiceKind;
  nodeId: string;
  replicas: number;
  /** Final: portableSpecOf, plus whatever the caller changed. */
  spec: ServiceSpecJson;
  templateSlug: string | null;
  notes: string;
  createdBy: string | null;
  /** Data volumes; they start empty. */
  volumes: { name: string; mountPath: string; readOnly: boolean }[];
  /** File mounts with their content in clear (sealed here); null content = an empty file. */
  fileMounts: { name: string; mountPath: string; readOnly: boolean; content: string | null }[];
  /** The .env text; null or blank writes none. */
  env: string | null;
  database: {
    facts: Insert<typeof serviceDatabases, "serviceId" | "createdAt">;
    /** service_secrets rows in clear (sealed here). */
    secrets: { name: string; value: string }[];
  } | null;
  box: { repository: string | null; idleMinutes: number } | null;
  /** Inserted through insertDomain (host availability and the unique host and path). */
  domains: Insert<typeof domains, "serviceId" | "id">[];
  access?: { closeWhenDomainLive: boolean; redirectToPrimary: boolean } | null;
  /** Database listeners on the service's node. */
  exposures?: Insert<typeof portExposures, "serviceId" | "nodeId" | "id">[];
  /** The tunnel's token in clear (sealed here). */
  tunnel?: (Insert<typeof cloudflareTunnels, "serviceId" | "tokenSealed"> & { token: string | null }) | null;
  maintenance?: Insert<typeof maintenancePages, "serviceId"> | null;
  cronJobs?: Insert<typeof cronJobs, "serviceId" | "id">[];
  uptimeChecks?: Insert<typeof uptimeChecks, "serviceId" | "id">[];
  alertRules?: { event: (typeof alertRules.$inferInsert)["event"]; enabled: boolean; channelIds: string[] }[];
  /** Volume backups name their volume; it must be one of `volumes`. */
  backups?: (Insert<typeof backupPolicies, "serviceId" | "volumeId" | "id"> & { volume: string | null })[];
  /** Make a new deploy trigger URL; its token is returned once. */
  deployTrigger?: boolean;
}

export interface Materialized {
  id: string;
  domains: DomainRow[];
  uptimeChecks: (typeof uptimeChecks.$inferSelect)[];
  /** The new deploy trigger's token, when one was made. */
  deployTriggerToken: string | null;
}

/** Writes every row of a new service inside the caller's transaction. */
export function materializeService(caller: HostCaller & { secrets: SecretBox }, tx: PanelDb, input: Materialize): Materialized {
  const { id } = insertService(tx, {
    projectId: input.projectId,
    name: input.name,
    kind: input.kind,
    nodeId: input.nodeId,
    replicas: input.replicas,
    spec: input.spec,
    templateSlug: input.templateSlug,
    notes: input.notes,
    createdBy: input.createdBy,
    volumes: input.volumes,
  });
  // Created stopped and never deployed: the node keeps its folders (services/desired.ts) until someone starts it.
  tx.update(services).set({ stopped: true }).where(eq(services.id, id)).run();
  for (const f of input.fileMounts) {
    tx.insert(volumes)
      .values({
        serviceId: id,
        name: f.name,
        mountPath: f.mountPath,
        kind: "file",
        readOnly: f.readOnly,
        contentSealed: f.content === null ? null : caller.secrets.seal(f.content, "volume.file"),
      })
      .run();
  }
  if (input.env?.trim()) writeServiceEnv(tx, caller.secrets, id, input.env, input.createdBy);
  if (input.database) {
    tx.insert(serviceDatabases)
      .values({ ...input.database.facts, serviceId: id, createdAt: new Date() })
      .run();
    for (const secret of input.database.secrets) writeSecret(tx, caller.secrets, id, secret.name, secret.value);
  }
  if (input.box)
    tx.insert(serviceBoxes).values({ serviceId: id, repository: input.box.repository, idleMinutes: input.box.idleMinutes }).run();
  const madeDomains = input.domains.map((d) => insertDomain(caller, tx, { ...d, serviceId: id }));
  if (input.access)
    tx.insert(serviceAccess)
      .values({ serviceId: id, ...input.access })
      .run();
  for (const e of input.exposures ?? [])
    tx.insert(portExposures)
      .values({ ...e, serviceId: id, nodeId: input.nodeId })
      .run();
  if (input.tunnel) {
    const { token, ...tunnel } = input.tunnel;
    tx.insert(cloudflareTunnels)
      .values({ ...tunnel, serviceId: id, tokenSealed: token ? caller.secrets.seal(token, "cloudflare.tunnel") : null })
      .run();
  }
  if (input.maintenance)
    tx.insert(maintenancePages)
      .values({ ...input.maintenance, serviceId: id })
      .run();
  for (const job of input.cronJobs ?? [])
    tx.insert(cronJobs)
      .values({ ...job, serviceId: id })
      .run();
  const checks = (input.uptimeChecks ?? []).map((c) =>
    tx
      .insert(uptimeChecks)
      .values({ ...c, serviceId: id })
      .returning()
      .get(),
  );
  for (const rule of input.alertRules ?? []) {
    tx.insert(alertRules)
      .values({ scopeType: "service", scopeId: id, ...rule })
      .run();
  }
  for (const { volume, ...policy } of input.backups ?? []) {
    const volumeId = volume
      ? tx
          .select({ id: volumes.id })
          .from(volumes)
          .where(and(eq(volumes.serviceId, id), eq(volumes.name, volume), eq(volumes.kind, "volume")))
          .get()?.id
      : null;
    if (volume && !volumeId) throw new Error(`materializeService: backup of unknown volume ${volume}`);
    tx.insert(backupPolicies)
      .values({ ...policy, serviceId: id, volumeId: volumeId ?? null })
      .run();
  }
  let deployTriggerToken: string | null = null;
  if (input.deployTrigger) {
    deployTriggerToken = randomToken();
    tx.insert(deployTriggers)
      .values({ serviceId: id, tokenHash: hashToken(deployTriggerToken), hint: deployTriggerToken.slice(-4), createdBy: input.createdBy })
      .run();
  }
  return { id, domains: madeDomains, uptimeChecks: checks, deployTriggerToken };
}

/**
 * What a copy of a service keeps of its spec: everything but its place in a
 * stack, a preview's identity, the entry node and previews (off). The
 * source stays as it is, Deploy on push included (an import decides that
 * itself), except that a clone starts without an uploaded archive's name
 * (it copies the archive separately); an export drops the previews' domain
 * pattern, which names the old panel's wildcard domain.
 */
export function portableSpecOf(spec: ServiceSpecJson, mode: "clone" | "export"): ServiceSpecJson {
  const source: ServiceSpecJson["source"] =
    mode === "clone" && spec.source.type === "upload" ? { type: "upload", fileName: null } : spec.source;
  return {
    ...spec,
    source,
    entryNodeId: null,
    previews: { ...spec.previews, enabled: false, ...(mode === "export" ? { domainPattern: "" } : {}) },
    member: null,
    stack: null,
    preview: null,
  };
}
