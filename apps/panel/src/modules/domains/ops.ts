// Domain op handlers. Every change commits, marks the service's desired
// state dirty (the agent rewrites its route file) and invalidates the
// screens that show domains, IP:port access and env references.

import { domains as domainOps, env as envOps, exposures as exposureOps, OpError } from "@seylo/ops";
import { and, asc, eq, ne } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { type DomainMiddlewares, domains } from "../../db/schema";
import type { OpContext } from "../../ops/implement";
import { implement } from "../../ops/implement";
import { applyDomainLive } from "../exposures/logic";
import { checkCertificate, checkRedirects, hashBasicAuthPassword, normalizeCidrs } from "./checks";
import { checkHost, dnsLookups, pointsTo } from "./dns";
import { appPort, getService, invalidateService, type ServiceRow, serviceNodes } from "./lookup";
import { checkOrigin, enqueueOriginCheck, originApplies, saveOrigin } from "./origin";
import { assertCertificateNames, assertHostAvailable, type HostCaller } from "./ownership";
import { type DomainRow, getDomain, primaryDomain, serviceDomains, toDomain } from "./rows";

const changedOps = [domainOps.list.id, exposureOps.get.id, envOps.references.id];

function afterChange(ctx: OpContext, serviceId: string) {
  ctx.agents.desired.markDirty({ serviceId });
  invalidateService(ctx, serviceId, changedOps);
}

export function requireDomain(db: PanelDb, serviceId: string, domainId: string): DomainRow {
  const row = getDomain(db, serviceId, domainId);
  if (!row) throw new OpError("NOT_FOUND", "That domain does not exist on this service.", { domainId });
  return row;
}

function targetPortFor(db: PanelDb, service: ServiceRow, requested: number | undefined): number {
  // An app built from a repository with no port: the port its other domains use, else 80, which is its PORT too.
  const port = requested ?? appPort(db, service);
  if (port === null) {
    throw new OpError("BAD_REQUEST", `${service.name} has no port yet. Pass targetPort or add a port to the service.`, {
      field: "targetPort",
    });
  }
  return port;
}

/**
 * Inserts a domain. The (host, path) pair is unique across the panel, and a
 * host routed by another service is only available to callers who may edit
 * that service's domains (see ownership.ts).
 */
export function insertDomain(caller: HostCaller, db: PanelDb, values: typeof domains.$inferInsert): DomainRow {
  assertHostAvailable({ ...caller, db }, values.host, values.serviceId);
  const taken = db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.host, values.host), eq(domains.pathPrefix, values.pathPrefix ?? "/")))
    .get();
  if (taken) {
    throw new OpError("CONFLICT", `${values.host}${values.pathPrefix === "/" ? "" : values.pathPrefix} is already in use.`, {
      field: "host",
    });
  }
  return db.insert(domains).values(values).returning().get();
}

function autoSuggestion(db: PanelDb, service: ServiceRow): string | null {
  const node = serviceNodes(db, service.id).find((n) => n.wildcardDomain);
  if (!node?.wildcardDomain) return null;
  const host = `${service.name}.${node.wildcardDomain}`;
  const taken = db.select({ id: domains.id }).from(domains).where(eq(domains.host, host)).get();
  return taken ? null : host;
}

export const list = implement(domainOps.list, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  // The address every row names: what its records point at (one lookup of the nodes, no DNS query).
  const addresses = pointsTo(serviceNodes(ctx.db, service.id));
  return {
    domains: serviceDomains(ctx.db, service.id).map((row) => ({ ...toDomain(row), pointsTo: addresses })),
    autoDomainSuggestion: autoSuggestion(ctx.db, service),
  };
});

export const addAuto = implement(domainOps.addAuto, (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  const node = serviceNodes(ctx.db, service.id).find((n) => n.wildcardDomain);
  if (!node?.wildcardDomain) {
    throw new OpError("CONFLICT", "None of this service's nodes has a wildcard domain. Set one on the node first.", {
      reason: "noWildcardDomain",
    });
  }
  const targetPort = targetPortFor(ctx.db, service, input.targetPort);
  const host = `${input.subdomain ?? service.name}.${node.wildcardDomain}`;
  const row = ctx.db.transaction((tx) => {
    const created = insertDomain(ctx, tx, {
      serviceId: service.id,
      host,
      pathPrefix: "/",
      targetPort,
      https: "acme",
      auto: true,
      // The wildcard record points at the node, so the check would only repeat what the owner set up.
      dnsStatus: "ok",
      dnsCheckedAt: new Date(),
      certStatus: "pending",
      isPrimary: !primaryDomain(tx, service.id),
    });
    return created;
  });
  afterChange(ctx, service.id);
  return toDomain(row);
});

export const add = implement(domainOps.add, async (input, ctx) => {
  const service = getService(ctx.db, input.serviceId);
  const https = input.https ?? "acme";
  if (https === "custom") {
    throw new OpError("BAD_REQUEST", "Add the domain with acme or off, then upload its certificate with domains.setCertificate.", {
      field: "https",
    });
  }
  const targetPort = targetPortFor(ctx.db, service, input.targetPort);
  const nodes = serviceNodes(ctx.db, service.id);
  const dns = await checkHost(input.host, nodes, dnsLookups());
  const row = ctx.db.transaction((tx) => {
    const makePrimary = !input.forward && (input.primary === true || !primaryDomain(tx, service.id));
    if (makePrimary) tx.update(domains).set({ isPrimary: false }).where(eq(domains.serviceId, service.id)).run();
    return insertDomain(ctx, tx, {
      serviceId: service.id,
      host: input.host,
      pathPrefix: input.pathPrefix ?? "/",
      stripPrefix: input.stripPrefix ?? false,
      targetPort,
      https,
      forward: input.forward ?? null,
      isPrimary: makePrimary,
      dnsStatus: dns.status,
      dnsCheckedAt: new Date(),
      certStatus: https === "off" ? "none" : "pending",
    });
  });
  afterChange(ctx, service.id);
  // The node writes the route a moment from now; the origin check waits for it (origin.ts).
  if (originApplies(row, dns.status)) enqueueOriginCheck(ctx, row.id);
  return { domain: toDomain(row), dns: { domainId: row.id, host: row.host, checkedAt: new Date().toISOString(), ...dns } };
});

export const checkDns = implement(domainOps.checkDns, async (input, ctx) => {
  const row = requireDomain(ctx.db, input.serviceId, input.domainId);
  const nodes = serviceNodes(ctx.db, input.serviceId);
  const dns = await checkHost(row.host, nodes, dnsLookups());
  // Behind Cloudflare's proxy only the origin check tells whether the record there points at the node.
  const origin = originApplies(row, dns.status) ? (await checkOrigin(ctx, row)).origin : null;
  const checkedAt = new Date();
  ctx.db.update(domains).set({ dnsStatus: dns.status, dnsCheckedAt: checkedAt }).where(eq(domains.id, row.id)).run();
  const originChanged = saveOrigin(ctx, row, origin, checkedAt);
  if (dns.status !== row.dnsStatus && !originChanged) invalidateService(ctx, input.serviceId, [domainOps.list.id]);
  return { domainId: row.id, host: row.host, checkedAt: checkedAt.toISOString(), ...dns, ...(origin ? { origin } : {}) };
});

export const update = implement(domainOps.update, (input, ctx) => {
  const row = requireDomain(ctx.db, input.serviceId, input.domainId);
  if (input.https === "custom" && !row.certificateSealed) {
    throw new OpError("BAD_REQUEST", "Upload a certificate with domains.setCertificate to use HTTPS mode custom.", { field: "https" });
  }
  if (input.forward && row.isPrimary) {
    throw new OpError("BAD_REQUEST", "The primary domain cannot redirect elsewhere. Make another domain primary first.", {
      field: "forward",
    });
  }
  const pathPrefix = input.pathPrefix ?? row.pathPrefix;
  if (pathPrefix !== row.pathPrefix) {
    // A new path on a shared host outranks the other services' rules there.
    assertHostAvailable(ctx, row.host, row.serviceId, "pathPrefix");
    const taken = ctx.db
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.host, row.host), eq(domains.pathPrefix, pathPrefix), ne(domains.id, row.id)))
      .get();
    if (taken) throw new OpError("CONFLICT", `${row.host}${pathPrefix} is already in use.`, { field: "pathPrefix" });
  }
  const https = input.https ?? row.https;
  const updated = ctx.db
    .update(domains)
    .set({
      pathPrefix,
      stripPrefix: input.stripPrefix ?? row.stripPrefix,
      targetPort: input.targetPort ?? row.targetPort,
      https,
      redirectToHttps: input.redirectToHttps ?? row.redirectToHttps,
      forward: input.forward === undefined ? row.forward : input.forward,
      // A new HTTPS mode needs a new certificate state; custom certificates are valid on upload.
      ...(https !== row.https ? { certStatus: https === "off" ? "none" : https === "custom" ? "valid" : "pending" } : {}),
    })
    .where(eq(domains.id, row.id))
    .returning()
    .get();
  afterChange(ctx, input.serviceId);
  return toDomain(updated);
});

export const setMiddlewares = implement(domainOps.setMiddlewares, async (input, ctx) => {
  const row = requireDomain(ctx.db, input.serviceId, input.domainId);
  const current: DomainMiddlewares = row.middlewares ?? {};
  const next: DomainMiddlewares = { ...current };

  if (input.basicAuth !== undefined) {
    if (input.basicAuth === null) {
      delete next.basicAuth;
    } else {
      const stored = new Map((current.basicAuth?.users ?? []).map((u) => [u.username, u.hash]));
      const seen = new Set<string>();
      const users: { username: string; hash: string }[] = [];
      for (const user of input.basicAuth.users) {
        if (seen.has(user.username)) throw new OpError("BAD_REQUEST", `${user.username} is listed twice.`, { field: "basicAuth.users" });
        seen.add(user.username);
        const hash = user.password ? await hashBasicAuthPassword(user.password) : stored.get(user.username);
        if (!hash) throw new OpError("BAD_REQUEST", `Set a password for the new user ${user.username}.`, { field: "basicAuth.users" });
        users.push({ username: user.username, hash });
      }
      next.basicAuth = { users };
    }
  }
  if (input.ipAllowList !== undefined) {
    const cidrs = normalizeCidrs(input.ipAllowList, "ipAllowList");
    if (cidrs.length > 0) next.ipAllowList = cidrs;
    else delete next.ipAllowList;
  }
  if (input.rateLimit !== undefined) {
    if (input.rateLimit === null) delete next.rateLimit;
    else next.rateLimit = { ...input.rateLimit };
  }
  if (input.redirects !== undefined) {
    checkRedirects(input.redirects);
    if (input.redirects.length > 0) next.redirects = input.redirects.map((r) => ({ ...r }));
    else delete next.redirects;
  }

  const updated = ctx.db.update(domains).set({ middlewares: next }).where(eq(domains.id, row.id)).returning().get();
  afterChange(ctx, input.serviceId);
  return toDomain(updated);
});

export const setCertificate = implement(domainOps.setCertificate, (input, ctx) => {
  const row = requireDomain(ctx.db, input.serviceId, input.domainId);
  const checked = checkCertificate(row.host, input.certPem, input.privateKey);
  // Traefik keeps one certificate store per node: every name on it is served for that host.
  assertCertificateNames(ctx, input.certPem, row.serviceId);
  const sealed = ctx.secrets.seal(JSON.stringify({ certPem: input.certPem, keyPem: input.privateKey }), "domain.certificate");
  const updated = ctx.db
    .update(domains)
    .set({ https: "custom", certificateSealed: sealed, certStatus: "valid", certExpiresAt: checked.expiresAt, certIssuer: checked.issuer })
    .where(eq(domains.id, row.id))
    .returning()
    .get();
  afterChange(ctx, input.serviceId);
  return toDomain(updated);
});

export const setPrimary = implement(domainOps.setPrimary, (input, ctx) => {
  const row = requireDomain(ctx.db, input.serviceId, input.domainId);
  if (row.forward) throw new OpError("BAD_REQUEST", "A redirect-only domain cannot be primary.", { field: "domainId" });
  const updated = ctx.db.transaction((tx) => {
    tx.update(domains).set({ isPrimary: false }).where(eq(domains.serviceId, input.serviceId)).run();
    const next = tx.update(domains).set({ isPrimary: true }).where(eq(domains.id, row.id)).returning().get();
    // IP:port redirects follow the primary domain once it is live.
    if (next.liveAt) applyDomainLive(tx, input.serviceId);
    return next;
  });
  afterChange(ctx, input.serviceId);
  return toDomain(updated);
});

export const remove = implement(domainOps.remove, (input, ctx) => {
  const row = requireDomain(ctx.db, input.serviceId, input.domainId);
  ctx.db.transaction((tx) => {
    tx.delete(domains).where(eq(domains.id, row.id)).run();
    if (row.isPrimary) {
      const promote = tx
        .select()
        .from(domains)
        .where(eq(domains.serviceId, input.serviceId))
        .orderBy(asc(domains.createdAt))
        .all()
        .find((d) => !d.forward);
      if (promote) tx.update(domains).set({ isPrimary: true }).where(eq(domains.id, promote.id)).run();
    }
  });
  afterChange(ctx, input.serviceId);
  return {};
});
