// Where a generic git source may point. Nodes clone as root in their own
// network (and FetchGitFile hands the file back), so a git URL is a way into
// the node's network: a member could read an internal Gitea or a loopback
// service through it. Public addresses are fine. An internal one (private,
// loopback, link-local or reserved, or a name the panel cannot resolve) is
// allowed only for hosts an admin (git.manage) saved a source with in the
// same project: saving records the host (git_internal_hosts), and the
// project's members may then use it too, like a shared credential. Cloud
// metadata endpoints are never allowed.
//
// Checked when a source is saved (with the caller) and again right before a
// build or FetchGitFile is sent to a node (without one), since a name can
// resolve somewhere else by then. Hosts of git sources that existed before
// this check count as approved once (seedInternalGitHosts).

import { OpError } from "@seylo/ops";
import { and, eq, sql } from "drizzle-orm";
import type { Access } from "../../auth/access";
import { type Principal, userOf } from "../../auth/principal";
import type { PanelDb } from "../../db/client";
import { gitInternalHosts, services } from "../../db/schema";
import { getSetting, setSetting } from "../../settings";
import { blockedTarget, checkTarget } from "../uptime/targets";
import { targetUrl, urlHost } from "./remote";

declare module "../../settings" {
  interface SettingValues {
    /** The hosts of git sources saved before internal git hosts needed an admin were recorded. */
    gitInternalHostsSeeded: boolean;
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

function approved(db: PanelDb, projectId: string, host: string): boolean {
  return (
    db
      .select({ id: gitInternalHosts.id })
      .from(gitInternalHosts)
      .where(and(eq(gitInternalHosts.projectId, projectId), eq(gitInternalHosts.host, host)))
      .get() !== undefined
  );
}

/**
 * BAD_REQUEST unless the project's nodes may clone from this git URL. With a
 * caller who has git.manage, an internal host is recorded for the project.
 */
export async function assertGitTarget(
  db: PanelDb,
  input: { projectId: string; url: string; caller: GitCaller | null; field?: string },
): Promise<void> {
  const field = input.field ?? "source.url";
  const host = hostOf(input.url, field);
  const target = await checkTarget({ db }, targetUrl(input.url), { allowInternal: false });
  if (target.ok) return;
  if (target.reason !== "metadata") {
    if (approved(db, input.projectId, host)) return;
    if (input.caller?.access.can("git.manage")) {
      db.insert(gitInternalHosts).values({ projectId: input.projectId, host, approvedBy: input.caller.userId }).onConflictDoNothing().run();
      return;
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
 * Once per panel: the hosts of git sources stored before this check (service
 * and compose stack sources) count as approved for their projects, so an
 * update does not stop builds an owner set up with a LAN git server.
 */
export function seedInternalGitHosts(db: PanelDb): void {
  if (getSetting(db, "gitInternalHostsSeeded") === true) return;
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
  for (const row of rows) {
    for (const url of [row.source === "git" ? row.url : null, row.stackSource === "git" ? row.stackUrl : null]) {
      if (!url) continue;
      let host: string;
      try {
        host = urlHost(url).toLowerCase();
      } catch {
        continue;
      }
      db.insert(gitInternalHosts).values({ projectId: row.projectId, host, approvedBy: null }).onConflictDoNothing().run();
    }
  }
  setSetting(db, "gitInternalHostsSeeded", true);
}
