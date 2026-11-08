// Where a generic git source may point. Nodes clone as root in their own
// network (and FetchGitFile hands the file back), so a git URL is a way into
// the node's network: a member could read an internal Gitea or a loopback
// service through it. Public addresses are fine. An internal one (private,
// loopback, link-local or reserved, or a name the panel cannot resolve; a
// node's own address on a private network too, unlike for uptime checks,
// and a host whose every address is one of the panel's nodes', public ones
// included, since the node connects to itself there; for a member only the
// nodes' trusted addresses count, see NodeAddressScope) is allowed only for
// hosts an admin (git.manage) saved a source with in the same project:
// saving records the host (git_internal_hosts), and the project's members
// may then use it too, like a shared credential. Cloud metadata endpoints
// are never allowed.
//
// Checked when a source is saved (with the caller) and again right before a
// build or FetchGitFile is sent to a node (without one), since a name can
// resolve somewhere else by then. A host the panel sees as public (a
// split-horizon name that is internal only at the nodes) is recorded only
// when an admin asks for it explicitly (git.allowInternalHost). Hosts of git
// sources that existed before this check, and that the panel resolves to
// internal addresses or the nodes' own (or that are internal IP addresses)
// on the first start of 0.2, count as approved once (seedInternalGitHosts).
//
// The node resolves the name again when it clones, so the panel's answer is
// not the last word: a name can answer the panel with a public address and
// the node with an internal one (rebinding, split-horizon DNS). The agent
// therefore checks the address of every connection it makes for a git
// source (go/internal/netguard) and allows internal addresses only for the
// source's own host, only when the request says so: GitSource.
// allow_internal_host, which the panel sets exactly when the host is in
// git_internal_hosts for the project, or for a git provider connection
// (whose host only gitProviders.manage sets) when the panel sees the host
// as internal or it is recorded for the project (providerGitVerdict).

import { git as gitOps, OpError } from "@seylo/ops";
import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { compareVersions, parseVersion } from "../../agent-hub/version";
import type { Access } from "../../auth/access";
import { type Principal, userOf } from "../../auth/principal";
import type { PanelDb } from "../../db/client";
import { gitInternalHosts, nodes, projects, services, users } from "../../db/schema";
import type { Logger } from "../../logger";
import { deleteSetting, getSetting, setSetting } from "../../settings";
import { blockedTarget, checkTarget, type NodeAddressScope, type TargetCheck } from "../uptime/targets";
import { targetUrl, urlHost } from "./remote";

declare module "../../settings" {
  interface SettingValues {
    /**
     * Set by the first seed (features-1 dev panels only), which also recorded
     * public hosts and names the panel could not resolve. Its rows are
     * dropped once before the current seed runs; then the setting is deleted.
     */
    gitInternalHostsSeeded: boolean;
    /** The internal hosts of git sources saved before internal git hosts needed an admin were recorded. */
    gitInternalHostsSeededV2: boolean;
    /**
     * The hosts of existing git sources on the nodes' own addresses were
     * recorded (0.2.0-rc.2, when nodes started refusing their own
     * addresses); a panel whose V2 seed ran before records those once.
     */
    gitInternalHostsSeededNodes: boolean;
    /**
     * Left by the seed when some nodes had no interface addresses on record
     * (agents before 0.2.0-rc.2): those nodes, and the hosts it saw as
     * public with the sources on each, checked again once per node when it
     * reports them (recheckSeededGitHosts).
     */
    gitInternalHostsPending: { nodeIds: string[]; hosts: { host: string; url: string; services: { id: string; projectId: string }[] }[] };
  }
}

/** Who saves the source; null when the panel dispatches a stored one (build, push). */
export interface GitCaller {
  access: Pick<Access, "can">;
  userId: string | null;
}

/** The caller of an op, for assertGitTarget. */
export function gitCaller(ctx: { access: Pick<Access, "can">; principal: Principal }): GitCaller {
  return { access: ctx.access, userId: userOf(ctx.principal)?.id ?? null };
}

/**
 * The host of a git URL as git_internal_hosts records it (urlHost, lower
 * case), or null when the URL has none InternalGitHost can name (no host
 * at all, say "ssh://" and a control character): such a host is never
 * recorded, so git.listInternalHosts and git.removeInternalHost work for
 * every row.
 */
export function recordedHostOf(url: string): string | null {
  let host: string;
  try {
    host = urlHost(url).toLowerCase();
  } catch {
    return null;
  }
  return Value.Check(gitOps.InternalGitHost, host) ? host : null;
}

function hostOf(url: string, field: string): string {
  const host = recordedHostOf(url);
  if (host === null) throw new OpError("BAD_REQUEST", "This is not a git URL.", { field });
  return host;
}

/** The first-start seed while it runs, per database: every check below waits for it. */
const seeding = new WeakMap<PanelDb, Promise<void>>();

/**
 * A host's address check, as git sources need it: a node's own private
 * address is internal too, and so is a host whose every address is one of
 * the nodes' (reason "node"), since nodes refuse their own addresses for git
 * unless the host is allowed. `scope` says which of the nodes' addresses
 * count (NodeAddressScope): what agents report only where an admin stands
 * behind the outcome.
 */
export function checkGitHost(db: PanelDb, url: string, scope: NodeAddressScope): Promise<TargetCheck> {
  return checkTarget({ db }, targetUrl(url), { allowInternal: false, ownNodes: false, nodesInternal: scope });
}

/** True when an admin allowed this git host (host[:port] as urlHost gives it, lower case) in the project. */
function approved(db: PanelDb, projectId: string, host: string): boolean {
  return (
    db
      .select({ id: gitInternalHosts.id })
      .from(gitInternalHosts)
      .where(and(eq(gitInternalHosts.projectId, projectId), eq(gitInternalHosts.host, host)))
      .get() !== undefined
  );
}

/** Whether the node may connect to internal addresses of the source's host (GitSource.allow_internal_host). */
export interface GitTargetVerdict {
  allowInternalHost: boolean;
}

/**
 * BAD_REQUEST unless the project's nodes may clone from this git URL. With a
 * caller who has git.manage, an internal host is recorded for the project.
 * allowInternalHost is true exactly when the host is recorded for the
 * project: the node then accepts internal addresses for it (and only it),
 * also when the panel sees a public one. The nodes' addresses agents report
 * count only for a git.manage caller (whose save records the host, so a git
 * server on a node's second address gets allowed); for a member and for a
 * build dispatch only the trusted ones do, so an agent that lies about its
 * addresses cannot refuse members a public host. A member's source on an
 * address only an agent reported then fails at that node, which refuses
 * its own addresses, with the hint to ask an admin.
 */
export async function assertGitTarget(
  db: PanelDb,
  input: { projectId: string; url: string; caller: GitCaller | null; field?: string },
): Promise<GitTargetVerdict> {
  const field = input.field ?? "source.url";
  const host = hostOf(input.url, field);
  await seeding.get(db);
  const admin = input.caller?.access.can("git.manage") === true;
  // A node's private address is internal here: the node needs allow_internal_host to clone from it.
  const target = await checkGitHost(db, input.url, admin ? "reported" : "trusted");
  if (target.ok) return { allowInternalHost: approved(db, input.projectId, host) };
  if (target.reason !== "metadata") {
    if (approved(db, input.projectId, host)) return { allowInternalHost: true };
    if (input.caller && admin) {
      db.insert(gitInternalHosts).values({ projectId: input.projectId, host, approvedBy: input.caller.userId }).onConflictDoNothing().run();
      return { allowInternalHost: true };
    }
  }
  const what =
    target.reason === "unresolvable" ? `The name ${host} does not resolve from the panel` : `${host} is ${blockedTarget(target)}`;
  if (target.reason === "metadata")
    throw new OpError("BAD_REQUEST", `${what}; nodes never clone from it.`, { field, reason: "internalTarget" });
  // details.host: what an admin can allow for the project (git.allowInternalHost); never for metadata.
  throw new OpError(
    "BAD_REQUEST",
    `${what}. Only an admin can use an internal git host; once an admin saves a source with ${host} in this project (or allows it), its members can use it too.`,
    { field, reason: target.reason === "unresolvable" ? "unresolvable" : "internalTarget", host },
  );
}

/** True when the host (urlHost form, lower case) is recorded for the project, once the seed is done. */
export async function gitHostRecorded(db: PanelDb, projectId: string, host: string): Promise<boolean> {
  await seeding.get(db);
  return approved(db, projectId, host);
}

/**
 * GitSource.allow_internal_host for a git provider connection's clone URL.
 * The connection's address is set by gitProviders.manage (an admin), so a
 * host the panel sees as internal (or cannot resolve) counts as allowed, as
 * if an admin had saved a generic source with it; no row is written. A
 * public host (github.com, a public GitLab) gets it only when it is
 * recorded for the project (git.allowInternalHost, for split-horizon
 * names), so a rebinding answer at the node is refused there. Metadata
 * never. The nodes' addresses agents report count here (an admin set the
 * connection's address), so a provider on a node's second address builds.
 */
export async function providerGitVerdict(db: PanelDb, input: { projectId: string; url: string }): Promise<GitTargetVerdict> {
  const host = hostOf(input.url, "source.providerId");
  await seeding.get(db);
  const target = await checkGitHost(db, input.url, "reported");
  if (target.ok) return { allowInternalHost: approved(db, input.projectId, host) };
  return { allowInternalHost: target.reason !== "metadata" };
}

/**
 * git.allowInternalHost: an admin allows the host of a git URL for a
 * project whatever the panel's own DNS answers for it, for a name that is
 * public at the panel and internal at the nodes (split-horizon DNS), which
 * saving a source cannot record. Metadata addresses never.
 */
export async function allowInternalGitHost(
  db: PanelDb,
  input: { projectId: string; url: string; userId: string | null },
): Promise<{ host: string }> {
  const host = hostOf(input.url, "url");
  assertProject(db, input.projectId);
  await seeding.get(db);
  const target = await checkGitHost(db, input.url, "reported");
  if (!target.ok && target.reason === "metadata")
    throw new OpError("BAD_REQUEST", `${host} is ${blockedTarget(target)}; nodes never clone from it.`, {
      field: "url",
      reason: "internalTarget",
    });
  db.insert(gitInternalHosts).values({ projectId: input.projectId, host, approvedBy: input.userId }).onConflictDoNothing().run();
  return { host };
}

/** Services with their git hosts (urlHost form, lower case): the generic git source's and the compose stack's. */
function gitSourceRows(db: PanelDb, filter?: SQL): { id: string; projectId: string; hosts: string[]; urls: string[] }[] {
  const rows = db
    .select({
      id: services.id,
      projectId: services.projectId,
      source: sql<string | null>`json_extract(${services.spec}, '$.source.type')`,
      url: sql<string | null>`json_extract(${services.spec}, '$.source.url')`,
      stackSource: sql<string | null>`json_extract(${services.spec}, '$.stack.source.type')`,
      stackUrl: sql<string | null>`json_extract(${services.spec}, '$.stack.source.url')`,
    })
    .from(services)
    .where(filter)
    .all();
  return rows.map((row) => {
    const hosts: string[] = [];
    const urls: string[] = [];
    for (const url of [row.source === "git" ? row.url : null, row.stackSource === "git" ? row.stackUrl : null]) {
      const host = url ? recordedHostOf(url) : null;
      if (!url || host === null) continue;
      hosts.push(host);
      urls.push(url);
    }
    return { id: row.id, projectId: row.projectId, hosts, urls };
  });
}

/** The git hosts of each generic git source and compose stack source in a project, per host. */
function sourceHostCounts(db: PanelDb, projectId: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of gitSourceRows(db, eq(services.projectId, projectId)))
    for (const host of row.hosts) counts.set(host, (counts.get(host) ?? 0) + 1);
  return counts;
}

function assertProject(db: PanelDb, projectId: string): void {
  if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()) {
    throw new OpError("NOT_FOUND", "No project with this id.", { field: "projectId" });
  }
}

/**
 * git.listInternalHosts: the hosts a project's nodes may clone from
 * internal addresses (git_internal_hosts), with who allowed each (null:
 * recorded by the first-start seed, or the account is gone) and how many
 * of the project's git sources use it.
 */
export async function listInternalGitHosts(
  db: PanelDb,
  projectId: string,
): Promise<{ items: { host: string; approvedBy: { id: string; name: string } | null; createdAt: string; usedBy: number }[] }> {
  assertProject(db, projectId);
  await seeding.get(db);
  const counts = sourceHostCounts(db, projectId);
  const rows = db
    .select({
      host: gitInternalHosts.host,
      createdAt: gitInternalHosts.createdAt,
      userId: users.id,
      userName: users.name,
      email: users.email,
    })
    .from(gitInternalHosts)
    .leftJoin(users, eq(users.id, gitInternalHosts.approvedBy))
    .where(eq(gitInternalHosts.projectId, projectId))
    .orderBy(gitInternalHosts.host)
    .all();
  return {
    items: rows.map((r) => ({
      host: r.host,
      approvedBy: r.userId ? { id: r.userId, name: r.userName || (r.email ?? "") } : null,
      createdAt: r.createdAt.toISOString(),
      usedBy: counts.get(r.host) ?? 0,
    })),
  };
}

/**
 * git.removeInternalHost: the project's nodes no longer clone this host
 * from internal addresses (its sources build again only once an admin
 * saves or allows it). NOT_FOUND when it is not allowed there.
 */
export function removeInternalGitHost(db: PanelDb, input: { projectId: string; host: string }): void {
  assertProject(db, input.projectId);
  const removed = db
    .delete(gitInternalHosts)
    .where(and(eq(gitInternalHosts.projectId, input.projectId), eq(gitInternalHosts.host, input.host.trim().toLowerCase())))
    .returning({ id: gitInternalHosts.id })
    .all();
  if (removed.length === 0)
    throw new OpError("NOT_FOUND", `${input.host} is not an allowed internal host of this project.`, { field: "host" });
}

/** For sources that may be git: checks the URL of a git one. */
export async function assertGitSourceTarget(
  db: PanelDb,
  projectId: string,
  source: { type: string; url?: string } | null | undefined,
  caller: GitCaller | null,
  field = "source.url",
): Promise<void> {
  if (source?.type === "git" && typeof source.url === "string") await assertGitTarget(db, { projectId, url: source.url, caller, field });
}

/**
 * Where the panel itself may read a git URL (git.branches): the vetted
 * address of a public host, or of an internal one that is allowed for the
 * project (git_internal_hosts) or asked about by an admin (git.manage).
 * The same rule as saving the source, not the uptime setting. Metadata
 * addresses never. A name the panel cannot resolve is read by name for an
 * admin (who may save a source with it, and is root on the nodes anyway),
 * never for anyone else: the request would ask DNS again, unchecked. As
 * for saving, only the nodes' trusted addresses count for anyone else.
 */
export async function gitReadTarget(
  db: PanelDb,
  input: { projectId: string; url: string; admin: boolean; field?: string },
): Promise<
  | { ok: true; address: string; byName: false }
  | { ok: true; address: null; byName: true }
  | { ok: false; check: Extract<TargetCheck, { ok: false }> }
> {
  const host = hostOf(input.url, input.field ?? "url");
  await seeding.get(db);
  const target = await checkGitHost(db, input.url, input.admin ? "reported" : "trusted");
  if (target.ok) return { ok: true, address: target.address as string, byName: false };
  if (target.reason === "unresolvable" && input.admin) return { ok: true, address: null, byName: true };
  if (target.reason !== "metadata" && target.reason !== "unresolvable" && (input.admin || approved(db, input.projectId, host)))
    return { ok: true, address: target.address, byName: false };
  return { ok: false, check: target };
}

/** How long the seed waits for one name; a slower answer counts as a failed lookup. */
const seedLookupMs = 20_000;

/** checkGitHost for the seed, with what agents report: a lookup slower than seedLookupMs or one that fails counts as unresolvable. */
function seedCheck(db: PanelDb, host: string, url: string): Promise<TargetCheck> {
  return new Promise((resolve) => {
    const failed = (): void => resolve({ ok: false, reason: "unresolvable", address: host });
    const timer = setTimeout(failed, seedLookupMs);
    timer.unref?.();
    checkGitHost(db, url, "reported")
      .then(resolve, failed)
      .finally(() => clearTimeout(timer));
  });
}

/** A seed's hosts: a URL to look each up by, and the sources on it. */
type SeedHost = { host: string; url: string; services: { id: string; projectId: string }[] };

function seedHosts(db: PanelDb): SeedHost[] {
  const hosts = new Map<string, SeedHost>();
  for (const row of gitSourceRows(db)) {
    row.hosts.forEach((host, i) => {
      const entry = hosts.get(host) ?? { host, url: row.urls[i] as string, services: [] };
      if (!entry.services.some((s) => s.id === row.id)) entry.services.push({ id: row.id, projectId: row.projectId });
      hosts.set(host, entry);
    });
  }
  return [...hosts.values()];
}

/** Agents from 0.2.0-rc.2 on report NodeFacts.interface_addresses; development builds too. */
function reportsInterfaceAddresses(agentVersion: string | null): boolean {
  const version = parseVersion(agentVersion);
  return version === null || compareVersions(version, { major: 0, minor: 2, patch: 0, pre: "rc.2" }) >= 0;
}

function interfaceAddressesOf(facts: unknown): unknown[] | null {
  const list = (facts as { interfaceAddresses?: unknown } | null)?.interfaceAddresses;
  return Array.isArray(list) ? list : null;
}

/**
 * Once per panel, on the first start of 0.2: the hosts of git sources
 * stored before this check (service and compose stack sources) that the
 * panel resolves to internal addresses or the nodes' own (reason "node",
 * what agents report included), or that are internal IP addresses, count
 * as approved for their projects, so an update does not stop builds an
 * owner set up with a LAN git server or a git server on a node. Nothing
 * else is recorded. A host the panel sees as public keeps building from
 * public addresses, and a member who saved a source on a name they control
 * gets no internal access for it from the node when the name is rebound
 * later. A name the panel cannot resolve (not found, or a lookup that
 * failed) is not recorded either, since a member could point it at an
 * internal address afterwards; it is logged, and an admin records it with
 * git.allowInternalHost.
 *
 * The sources are read and every lookup starts in this call, before the
 * panel serves; the checks above wait for the answers. The setting is
 * written once all of them are in, so a panel stopped halfway seeds again.
 * A panel that ran the first features-1 seed (gitInternalHostsSeeded) drops
 * the rows nobody approved (approved_by null) first, once. A panel that ran
 * this seed before nodes refused their own addresses (0.2.0-rc.1) records
 * the hosts on the nodes' addresses once (gitInternalHostsSeededNodes), and
 * nothing else: those sources built until then.
 *
 * Nodes whose stored facts have no interface addresses yet (older agents,
 * or facts an older panel stored, since it drops fields it does not know)
 * hide their second addresses from this pass: those nodes and the hosts it
 * saw as public are kept (gitInternalHostsPending), and checked again once
 * per node when it connects with an agent that reports them
 * (recheckSeededGitHosts).
 */
export function seedInternalGitHosts(db: PanelDb, log?: Pick<Logger, "info" | "warn" | "error">): Promise<void> {
  const full = getSetting(db, "gitInternalHostsSeededV2") !== true;
  if (!full && getSetting(db, "gitInternalHostsSeededNodes") === true) return Promise.resolve();
  const running = seeding.get(db);
  if (running) return running;
  if (full && getSetting(db, "gitInternalHostsSeeded") === true) {
    // A panel stopped right after this deletes again, which changes nothing: the seed below records what is left.
    const removed = db
      .delete(gitInternalHosts)
      .where(isNull(gitInternalHosts.approvedBy))
      .returning({ id: gitInternalHosts.id })
      .all().length;
    deleteSetting(db, "gitInternalHostsSeeded");
    log?.info({ removed }, "dropped the git internal hosts the first seed recorded without an admin; recording the internal ones again");
  }
  const hosts = seedHosts(db);
  const unseen = db
    .select({ id: nodes.id, facts: nodes.facts })
    .from(nodes)
    .all()
    .filter((n) => interfaceAddressesOf(n.facts) === null)
    .map((n) => n.id);
  const checks = hosts.map(async (entry) => ({ entry, check: await seedCheck(db, entry.host, entry.url) }));
  const work = Promise.all(checks)
    .then((results) => {
      const onNodes: string[] = [];
      const publicHosts: SeedHost[] = [];
      for (const { entry, check } of results) {
        const { host } = entry;
        const projectIds = new Set(entry.services.map((s) => s.projectId));
        // Public (the panel vouches for it) or metadata (never): nothing to record.
        if (check.ok) publicHosts.push(entry);
        if (check.ok || check.reason === "metadata") continue;
        // Not found or a failed lookup: the panel cannot tell where the name points, and whoever
        // controls it could point it inside later. Only an admin records it.
        if (check.reason === "unresolvable") {
          if (full)
            log?.warn(
              { host, projectIds: [...projectIds], notFound: check.notFound === true },
              "a git host of an existing source does not resolve at the panel, so it was not recorded as an internal host; an admin can allow it with git.allowInternalHost",
            );
          continue;
        }
        // After the V2 seed, internal hosts of sources saved since went through the check: only the nodes' own are new.
        if (!full && check.reason !== "node") continue;
        if (check.reason === "node") onNodes.push(host);
        for (const projectId of projectIds)
          db.insert(gitInternalHosts).values({ projectId, host, approvedBy: null }).onConflictDoNothing().run();
      }
      if (onNodes.length > 0)
        log?.info({ hosts: onNodes }, "recorded the git hosts of existing sources on the nodes' own addresses as internal hosts");
      if (unseen.length > 0 && publicHosts.length > 0) setSetting(db, "gitInternalHostsPending", { nodeIds: unseen, hosts: publicHosts });
      else deleteSetting(db, "gitInternalHostsPending");
      setSetting(db, "gitInternalHostsSeededV2", true);
      setSetting(db, "gitInternalHostsSeededNodes", true);
    })
    .catch((error: unknown) => log?.error({ err: error }, "recording the internal git hosts of existing sources failed"))
    .finally(() => seeding.delete(db));
  seeding.set(db, work);
  return work;
}

/** The last recheck per database: they run one after another, after the seed. */
const rechecks = new WeakMap<PanelDb, Promise<void>>();

/**
 * When a node the seed could not see the interface addresses of
 * (gitInternalHostsPending) connects with an agent that reports them, the
 * hosts the seed saw as public are checked again, once, and the ones now
 * on the nodes' addresses (reason "node") are recorded like the seed would
 * have: for the projects whose source from before the seed is still on
 * that host, nothing for sources saved since (those went through the
 * check). A node still on an older agent stays pending until its update.
 * The setting is dropped when no node or host is left.
 */
export function recheckSeededGitHosts(db: PanelDb, nodeId: string, log?: Pick<Logger, "info" | "error">): Promise<void> {
  const run = (rechecks.get(db) ?? Promise.resolve())
    .then(() => seeding.get(db))
    .then(async () => {
      const pending = getSetting(db, "gitInternalHostsPending");
      if (!pending?.nodeIds.includes(nodeId)) return;
      const node = db.select({ agentVersion: nodes.agentVersion, facts: nodes.facts }).from(nodes).where(eq(nodes.id, nodeId)).get();
      if (node && !reportsInterfaceAddresses(node.agentVersion)) return;
      let hosts = pending.hosts;
      if (node && (interfaceAddressesOf(node.facts)?.length ?? 0) > 0) {
        const results = await Promise.all(hosts.map(async (entry) => ({ entry, check: await seedCheck(db, entry.host, entry.url) })));
        const ids = [...new Set(hosts.flatMap((h) => h.services.map((s) => s.id)))];
        const current = new Map((ids.length > 0 ? gitSourceRows(db, inArray(services.id, ids)) : []).map((row) => [row.id, row] as const));
        const onNodes: string[] = [];
        for (const { entry, check } of results) {
          if (check.ok || check.reason !== "node") continue;
          onNodes.push(entry.host);
          const projectIds = new Set(
            entry.services
              .filter((s) => current.get(s.id)?.projectId === s.projectId && current.get(s.id)?.hosts.includes(entry.host))
              .map((s) => s.projectId),
          );
          for (const projectId of projectIds)
            db.insert(gitInternalHosts).values({ projectId, host: entry.host, approvedBy: null }).onConflictDoNothing().run();
        }
        hosts = hosts.filter((h) => !onNodes.includes(h.host));
        if (onNodes.length > 0)
          log?.info(
            { hosts: onNodes, nodeId },
            "recorded the git hosts of sources from before the upgrade on a node's own addresses as internal hosts, now that the node reported them",
          );
      }
      const known = new Set(
        db
          .select({ id: nodes.id })
          .from(nodes)
          .all()
          .map((n) => n.id),
      );
      const nodeIds = pending.nodeIds.filter((id) => id !== nodeId && known.has(id));
      if (nodeIds.length === 0 || hosts.length === 0) deleteSetting(db, "gitInternalHostsPending");
      else setSetting(db, "gitInternalHostsPending", { nodeIds, hosts });
    })
    .catch((error: unknown) =>
      log?.error({ err: error, nodeId }, "checking the git hosts of existing sources against a node's addresses failed"),
    );
  rechecks.set(db, run);
  return run;
}
