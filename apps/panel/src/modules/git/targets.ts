// Where a generic git source may point. Nodes clone as root in their own
// network (and FetchGitFile hands the file back), so a git URL is a way into
// the node's network: a member could read an internal Gitea or a loopback
// service through it. Public addresses are fine. An internal one (private,
// loopback, link-local or reserved, or a name the panel cannot resolve; a
// node's own address on a private network too, unlike for uptime checks) is
// allowed only for hosts an admin (git.manage) saved a source with in the
// same project: saving records the host (git_internal_hosts), and the
// project's members may then use it too, like a shared credential. Cloud
// metadata endpoints are never allowed.
//
// Checked when a source is saved (with the caller) and again right before a
// build or FetchGitFile is sent to a node (without one), since a name can
// resolve somewhere else by then. A host the panel sees as public (a
// split-horizon name that is internal only at the nodes) is recorded only
// when an admin asks for it explicitly (git.allowInternalHost). Hosts of git
// sources that existed before this check, and that the panel resolves to
// internal addresses (or that are internal IP addresses) on the first start
// of 0.2, count as approved once (seedInternalGitHosts).
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

import { OpError } from "@seylo/ops";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Access } from "../../auth/access";
import { type Principal, userOf } from "../../auth/principal";
import type { PanelDb } from "../../db/client";
import { gitInternalHosts, projects, services } from "../../db/schema";
import type { Logger } from "../../logger";
import { deleteSetting, getSetting, setSetting } from "../../settings";
import { blockedTarget, checkTarget, type TargetCheck } from "../uptime/targets";
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

function hostOf(url: string, field: string): string {
  try {
    return urlHost(url).toLowerCase();
  } catch {
    throw new OpError("BAD_REQUEST", "This is not a git URL.", { field });
  }
}

/** The first-start seed while it runs, per database: every check below waits for it. */
const seeding = new WeakMap<PanelDb, Promise<void>>();

/** A host's address check, as git sources need it (a node's own private address is internal too). */
function checkGitHost(db: PanelDb, url: string): Promise<TargetCheck> {
  return checkTarget({ db }, targetUrl(url), { allowInternal: false, ownNodes: false });
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
 * also when the panel sees a public one.
 */
export async function assertGitTarget(
  db: PanelDb,
  input: { projectId: string; url: string; caller: GitCaller | null; field?: string },
): Promise<GitTargetVerdict> {
  const field = input.field ?? "source.url";
  const host = hostOf(input.url, field);
  await seeding.get(db);
  // A node's private address is internal here: the node needs allow_internal_host to clone from it.
  const target = await checkGitHost(db, input.url);
  if (target.ok) return { allowInternalHost: approved(db, input.projectId, host) };
  if (target.reason !== "metadata") {
    if (approved(db, input.projectId, host)) return { allowInternalHost: true };
    if (input.caller?.access.can("git.manage")) {
      db.insert(gitInternalHosts).values({ projectId: input.projectId, host, approvedBy: input.caller.userId }).onConflictDoNothing().run();
      return { allowInternalHost: true };
    }
  }
  const what =
    target.reason === "unresolvable" ? `The name ${host} does not resolve from the panel` : `${host} is ${blockedTarget(target)}`;
  if (target.reason === "metadata")
    throw new OpError("BAD_REQUEST", `${what}; nodes never clone from it.`, { field, reason: "internalTarget" });
  throw new OpError(
    "BAD_REQUEST",
    `${what}. Only an admin can use an internal git host; once an admin saves a source with ${host} in this project, its members can use it too.`,
    { field, reason: target.reason === "unresolvable" ? "unresolvable" : "internalTarget" },
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
 * never.
 */
export async function providerGitVerdict(db: PanelDb, input: { projectId: string; url: string }): Promise<GitTargetVerdict> {
  const host = hostOf(input.url, "source.providerId");
  await seeding.get(db);
  const target = await checkGitHost(db, input.url);
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
  if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()) {
    throw new OpError("NOT_FOUND", "No project with this id.", { field: "projectId" });
  }
  await seeding.get(db);
  const target = await checkGitHost(db, input.url);
  if (!target.ok && target.reason === "metadata")
    throw new OpError("BAD_REQUEST", `${host} is ${blockedTarget(target)}; nodes never clone from it.`, {
      field: "url",
      reason: "internalTarget",
    });
  db.insert(gitInternalHosts).values({ projectId: input.projectId, host, approvedBy: input.userId }).onConflictDoNothing().run();
  return { host };
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
 * never for anyone else: the request would ask DNS again, unchecked.
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
  const target = await checkGitHost(db, input.url);
  if (target.ok) return { ok: true, address: target.address as string, byName: false };
  if (target.reason === "unresolvable" && input.admin) return { ok: true, address: null, byName: true };
  if (target.reason !== "metadata" && target.reason !== "unresolvable" && (input.admin || approved(db, input.projectId, host)))
    return { ok: true, address: target.address, byName: false };
  return { ok: false, check: target };
}

/** How long the seed waits for one name; a slower answer counts as a failed lookup. */
const seedLookupMs = 20_000;

/**
 * Once per panel, on the first start of 0.2: the hosts of git sources
 * stored before this check (service and compose stack sources) that the
 * panel resolves to internal addresses, or that are internal IP addresses,
 * count as approved for their projects, so an update does not stop builds
 * an owner set up with a LAN git server. Nothing else is recorded. A host
 * the panel sees as public keeps building from public addresses, and a
 * member who saved a source on a name they control gets no internal access
 * for it from the node when the name is rebound later. A name the panel
 * cannot resolve (not found, or a lookup that failed) is not recorded
 * either, since a member could point it at an internal address afterwards;
 * it is logged, and an admin records it with git.allowInternalHost.
 *
 * The sources are read and every lookup starts in this call, before the
 * panel serves; the checks above wait for the answers. The setting is
 * written once all of them are in, so a panel stopped halfway seeds again.
 * A panel that ran the first features-1 seed (gitInternalHostsSeeded) drops
 * the rows nobody approved (approved_by null) first, once.
 */
export function seedInternalGitHosts(db: PanelDb, log?: Pick<Logger, "info" | "warn" | "error">): Promise<void> {
  if (getSetting(db, "gitInternalHostsSeededV2") === true) return Promise.resolve();
  const running = seeding.get(db);
  if (running) return running;
  if (getSetting(db, "gitInternalHostsSeeded") === true) {
    // A panel stopped right after this deletes again, which changes nothing: the seed below records what is left.
    const removed = db
      .delete(gitInternalHosts)
      .where(isNull(gitInternalHosts.approvedBy))
      .returning({ id: gitInternalHosts.id })
      .all().length;
    deleteSetting(db, "gitInternalHostsSeeded");
    log?.info({ removed }, "dropped the git internal hosts the first seed recorded without an admin; recording the internal ones again");
  }
  const rows = db
    .select({
      projectId: services.projectId,
      source: sql<string | null>`json_extract(${services.spec}, '$.source.type')`,
      url: sql<string | null>`json_extract(${services.spec}, '$.source.url')`,
      stackSource: sql<string | null>`json_extract(${services.spec}, '$.stack.source.type')`,
      stackUrl: sql<string | null>`json_extract(${services.spec}, '$.stack.source.url')`,
    })
    .from(services)
    .all();
  const hosts = new Map<string, { url: string; projectIds: Set<string> }>();
  for (const row of rows) {
    for (const url of [row.source === "git" ? row.url : null, row.stackSource === "git" ? row.stackUrl : null]) {
      if (!url) continue;
      let host: string;
      try {
        host = urlHost(url).toLowerCase();
      } catch {
        continue;
      }
      const entry = hosts.get(host) ?? { url, projectIds: new Set<string>() };
      entry.projectIds.add(row.projectId);
      hosts.set(host, entry);
    }
  }
  const checks = [...hosts].map(
    ([host, entry]) =>
      new Promise<{ host: string; entry: typeof entry; check: TargetCheck }>((resolve) => {
        const failed = (): void => resolve({ host, entry, check: { ok: false, reason: "unresolvable", address: host } });
        const timer = setTimeout(failed, seedLookupMs);
        timer.unref?.();
        checkGitHost(db, entry.url)
          .then((check) => resolve({ host, entry, check }), failed)
          .finally(() => clearTimeout(timer));
      }),
  );
  const work = Promise.all(checks)
    .then((results) => {
      for (const { host, entry, check } of results) {
        // Public (the panel vouches for it) or metadata (never): nothing to record.
        if (check.ok || check.reason === "metadata") continue;
        // Not found or a failed lookup: the panel cannot tell where the name points, and whoever
        // controls it could point it inside later. Only an admin records it.
        if (check.reason === "unresolvable") {
          log?.warn(
            { host, projectIds: [...entry.projectIds], notFound: check.notFound === true },
            "a git host of an existing source does not resolve at the panel, so it was not recorded as an internal host; an admin can allow it with git.allowInternalHost",
          );
          continue;
        }
        for (const projectId of entry.projectIds)
          db.insert(gitInternalHosts).values({ projectId, host, approvedBy: null }).onConflictDoNothing().run();
      }
      setSetting(db, "gitInternalHostsSeededV2", true);
    })
    .catch((error: unknown) => log?.error({ err: error }, "recording the internal git hosts of existing sources failed"))
    .finally(() => seeding.delete(db));
  seeding.set(db, work);
  return work;
}
