// How an alert names the service it is about, the one way every title,
// channel and push says it: "<project> / <service>", and for a compose
// member "<project> / <stack> / <member>" (the member page's breadcrumb).
// Many projects have an "api" or a "web"; the project says which one.
//
//   const s = serviceSubject(db, serviceId);  // undefined once the service is gone
//   deps.alerts.raise({ ..., title: `${s.label} crashed`, serviceId, projectId: s.projectId });
//
// Titles are written once, when the alert is raised: a project or service
// renamed later keeps the text of alerts already sent. alerts.list and the
// notification fields name the ids as they are now (serviceSubjects), and
// link a service where it is now (serviceProjectIdOf, currentAlertLink): a
// service moved to another project keeps its id, its page moves.

import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { PanelDb } from "../../db/client";
import { projects, services } from "../../db/schema";

export const subjectSeparator = " / ";

export interface ServiceSubject {
  projectId: string;
  projectName: string;
  serviceId: string;
  serviceName: string;
  /** Compose members: their stack's name; null for every other service. */
  stackName: string | null;
  /** "acme-shop / api", or "acme-shop / shop / shop-web" for a member of the stack "shop". */
  label: string;
}

/** "<project> / <service>", with the stack between them for a compose member. */
export function subjectLabel(parts: { projectName: string; stackName?: string | null; serviceName: string }): string {
  return [parts.projectName, parts.stackName, parts.serviceName].filter((part) => !!part).join(subjectSeparator);
}

const stacks = alias(services, "stacks");

function rowsOf(db: PanelDb, serviceIds: string[]) {
  return db
    .select({
      serviceId: services.id,
      serviceName: services.name,
      projectId: services.projectId,
      projectName: projects.name,
      stackName: stacks.name,
    })
    .from(services)
    .innerJoin(projects, eq(projects.id, services.projectId))
    .leftJoin(stacks, eq(stacks.id, services.parentId))
    .where(serviceIds.length === 1 ? eq(services.id, serviceIds[0] as string) : inArray(services.id, serviceIds))
    .all();
}

const toSubject = (row: ReturnType<typeof rowsOf>[number]): ServiceSubject => ({
  ...row,
  stackName: row.stackName ?? null,
  label: subjectLabel(row),
});

/** The service's project (and stack) by their current names; undefined when there is no such service. */
export function serviceSubject(db: PanelDb, serviceId: string): ServiceSubject | undefined {
  const row = rowsOf(db, [serviceId])[0];
  return row ? toSubject(row) : undefined;
}

/** serviceSubject for many services at once (one query), keyed by service id. */
export function serviceSubjects(db: PanelDb, serviceIds: Iterable<string>): Map<string, ServiceSubject> {
  const ids = [...new Set(serviceIds)];
  const out = new Map<string, ServiceSubject>();
  if (ids.length === 0) return out;
  for (const row of rowsOf(db, ids)) out.set(row.serviceId, toSubject(row));
  return out;
}

/** Projects' current names by id (one query). */
export function projectNames(db: PanelDb, projectIds: Iterable<string>): Map<string, string> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, ids))
      .all()
      .map((row) => [row.id, row.name]),
  );
}

export interface AlertNames {
  services: Map<string, ServiceSubject>;
  projects: Map<string, string>;
}

/**
 * The project an alert's service is in now, where its page is: a service
 * moved to another project since the alert was raised lives under the new
 * one, while the alert's projectId stays the project it happened in. The
 * alert's own projectId when the service is gone; null when the alert is
 * not about a service.
 */
export function serviceProjectIdOf(
  row: { projectId: string | null; serviceId: string | null },
  services: ReadonlyMap<string, ServiceSubject>,
): string | null {
  if (!row.serviceId) return null;
  return services.get(row.serviceId)?.projectId ?? row.projectId;
}

/**
 * The alert's link, with a link to its service's pages ("/p/<project>/s/<service>",
 * the default for an alert about a service, and anything under it) moved to
 * the project the service is in now. Links are stored when the alert is
 * raised; every other link is left as it is.
 */
export function currentAlertLink(
  row: { link: string | null; projectId: string | null; serviceId: string | null },
  serviceProjectId: string | null,
): string | null {
  const { link, projectId, serviceId } = row;
  if (!link || !projectId || !serviceId || !serviceProjectId || serviceProjectId === projectId) return link;
  const page = `/p/${projectId}/s/${serviceId}`;
  if (!link.startsWith(page)) return link;
  const rest = link.slice(page.length);
  if (rest !== "" && !/^[/?#]/.test(rest)) return link;
  return `/p/${serviceProjectId}/s/${serviceId}${rest}`;
}

/** The current names of the services and projects some alerts are about (two queries at most). */
export function alertNames(db: PanelDb, rows: readonly { projectId: string | null; serviceId: string | null }[]): AlertNames {
  return {
    services: serviceSubjects(
      db,
      rows.flatMap((row) => (row.serviceId ? [row.serviceId] : [])),
    ),
    projects: projectNames(
      db,
      rows.flatMap((row) => (row.projectId ? [row.projectId] : [])),
    ),
  };
}
