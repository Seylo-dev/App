// What changes when a service leaves its project (services.moveProject) or
// a copy of it lands in another one (services.clone): ${{svc.VAR}}
// references and internal host names resolve by name inside one project,
// and shared ${{project.X}} variables come from the project. The functions
// on plain shapes are pure (tested directly); moveImpact reads the rows,
// filters by what the caller may see and adds what blocks a move.

import { hostMentions, type ParsedEnv, sharedTarget } from "@seylo/env-analyzer";
import { allOps, grantableActions, type services as serviceOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { grants, invites, previews, projects, services, users } from "../../db/schema";
import type { OpContext } from "../../ops/implement";
import { hasActiveDeploy } from "../deployments/queue";
import { receivesShared } from "../env/desired";
import { buildEnvGraph, type EnvGraph } from "../env/graph";
import { inviteStatus } from "../invites/rows";
import { activeCopy } from "./copies";
import { nameKey, type ServiceRow } from "./rows";
import { readSpec } from "./spec";

export type ReferenceEffect = Static<typeof serviceOps.ReferenceEffect>;
export type MoveImpact = Static<typeof serviceOps.MoveImpact>;
type MoveBlock = MoveImpact["blockers"][number];

/** One service's parsed .env as the analysis needs it. */
export interface EnvService {
  id: string;
  name: string;
  kind: string;
  parsed: ParsedEnv;
}

/** A project's services and shared variables. */
export interface ProjectEnv {
  services: readonly EnvService[];
  shared: ParsedEnv;
}

/** The value with every ${{...}} blanked out, so host names inside references never count. */
function literalText(entry: ParsedEnv["entries"][number]): string {
  let value = entry.value;
  for (const ref of entry.references) value = value.split(ref.raw).join(" ".repeat(ref.raw.length));
  return value;
}

function byName(project: ProjectEnv): Map<string, EnvService> {
  return new Map(project.services.map((s) => [s.name.toLowerCase(), s]));
}

function sharedKeys(project: ProjectEnv): Set<string> {
  return new Set(project.shared.entries.map((e) => e.key));
}

/**
 * The variables of `self` that point at something `from` provides or
 * `to` will: references to other services and shared variables, and other
 * services' host names typed into values. unresolved = `to` has nothing by
 * that name; retargeted = it now means `to`'s service or variable.
 * Nothing that resolves nowhere today and nowhere after is listed.
 */
export function ownReferenceEffects(self: EnvService, from: ProjectEnv, to: ProjectEnv): ReferenceEffect[] {
  const fromNames = byName(from);
  const toNames = byName(to);
  const fromShared = sharedKeys(from);
  const toShared = sharedKeys(to);
  const selfName = self.name.toLowerCase();
  const out: ReferenceEffect[] = [];
  const seen = new Set<string>();
  const add = (effect: ReferenceEffect) => {
    const id = `${effect.key}\u0000${effect.target.toLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(effect);
  };
  const hostNames = [...new Set([...fromNames.keys(), ...toNames.keys()])].filter((n) => n !== selfName);
  for (const entry of self.parsed.entries) {
    for (const ref of entry.references) {
      const target = ref.target.toLowerCase();
      if (target === sharedTarget) {
        const before = fromShared.has(ref.variable);
        const after = toShared.has(ref.variable);
        if (!before && !after) continue;
        add({ key: entry.key, target: `${sharedTarget}.${ref.variable}`, via: "reference", effect: after ? "retargeted" : "unresolved" });
        continue;
      }
      if (target === selfName) continue;
      const before = fromNames.has(target);
      const after = toNames.has(target);
      if (!before && !after) continue;
      add({ key: entry.key, target: `${ref.target}.${ref.variable}`, via: "reference", effect: after ? "retargeted" : "unresolved" });
    }
    const text = literalText(entry);
    for (const name of hostNames) {
      for (const m of hostMentions(text, name)) {
        add({ key: entry.key, target: `${m.host}${m.port}`, via: "hostname", effect: toNames.has(name) ? "retargeted" : "unresolved" });
      }
    }
  }
  return out;
}

/** Services of `project` (other than `selfId`) whose variables reference `name` or use it as a host, with those variables. */
export function referrersOf(name: string, project: ProjectEnv, selfId: string): { service: EnvService; keys: string[] }[] {
  const wanted = name.toLowerCase();
  const out: { service: EnvService; keys: string[] }[] = [];
  for (const service of project.services) {
    if (service.id === selfId) continue;
    const keys = new Set<string>();
    for (const entry of service.parsed.entries) {
      if (entry.references.some((r) => r.target.toLowerCase() === wanted)) keys.add(entry.key);
      else if (hostMentions(literalText(entry), name).length > 0) keys.add(entry.key);
    }
    if (keys.size > 0) out.push({ service, keys: [...keys] });
  }
  return out;
}

/** Shared variables of `from` the service receives (not overridden by its own keys) that `to` does not have. */
export function sharedVariablesLost(self: EnvService, from: ProjectEnv, to: ProjectEnv): string[] {
  if (!receivesShared(self.kind)) return [];
  const own = new Set(self.parsed.entries.map((e) => e.key));
  const after = sharedKeys(to);
  return [...sharedKeys(from)].filter((key) => !own.has(key) && !after.has(key)).sort();
}

export function projectEnvOf(graph: EnvGraph): ProjectEnv {
  return {
    services: graph.services.map((s) => ({ id: s.row.id, name: s.row.name, kind: s.row.kind, parsed: s.parsed })),
    shared: graph.shared,
  };
}

/** The first service action the caller lacks on the service: moving needs all of them (the new project may give more). */
export function missingServiceAction(ctx: Pick<OpContext, "access">, serviceId: string): string | null {
  for (const action of grantableActions(allOps, "service")) {
    if (!ctx.access.can(action, { type: "service", id: serviceId })) return action;
  }
  return null;
}

/** Whether people have to confirm the move: anything in the impact besides the switch itself. */
export function needsConfirm(impact: MoveImpact): boolean {
  return (
    impact.referencedBy.length > 0 ||
    impact.hiddenReferrers > 0 ||
    impact.targetReferrers.length > 0 ||
    impact.hiddenTargetReferrers > 0 ||
    impact.ownReferences.length > 0 ||
    impact.sharedLost.count > 0 ||
    impact.grants.count > 0 ||
    impact.invites > 0
  );
}

/** Pending invites that carry a grant on the service. */
export function invitesNaming(ctx: Pick<OpContext, "db">, serviceId: string, now = new Date()) {
  return ctx.db
    .select()
    .from(invites)
    .all()
    .filter((row) => inviteStatus(row, now) === "pending" && row.grants.some((g) => g.scopeType === "service" && g.scopeId === serviceId));
}

function blockersFor(ctx: OpContext, svc: ServiceRow, targetProjectId: string): MoveBlock[] {
  const out: MoveBlock[] = [];
  const block = (reason: MoveBlock["reason"], message: string) => out.push({ reason, message });
  const projectRows = ctx.db
    .select({ id: projects.id, name: projects.name, protected: projects.protected })
    .from(projects)
    .where(inArray(projects.id, [svc.projectId, targetProjectId]))
    .all();
  const target = projectRows.find((p) => p.id === targetProjectId);
  if (targetProjectId === svc.projectId) block("sameProject", `${svc.name} is already in this project.`);
  if (svc.protected || projectRows.some((p) => p.protected))
    block("protected", "The panel's own project and its services stay where they are.");
  if (svc.kind === "compose" || svc.parentId)
    block(
      "compose",
      svc.parentId ? `${svc.name} belongs to a compose stack and moves with it.` : "Compose stacks cannot change project yet.",
    );
  if (readSpec(svc.spec).preview) block("preview", `${svc.name} is a pull request preview; it belongs to its service's project.`);
  const open = ctx.db
    .select({ id: previews.id })
    .from(previews)
    .where(and(eq(previews.serviceId, svc.id), isNotNull(previews.previewServiceId)))
    .get();
  if (open) block("previews", `Close ${svc.name}'s pull request previews first: they run in its project.`);
  const taken = ctx.db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.projectId, targetProjectId), eq(services.nameKey, nameKey(svc.name))))
    .get();
  if (taken && targetProjectId !== svc.projectId)
    block("nameTaken", `${target?.name ?? "That project"} already has a service named ${svc.name}. Rename one of them first.`);
  if (hasActiveDeploy(ctx, svc.id)) block("deploying", "Wait for the running deploy to finish.");
  if (activeCopy(ctx.db, svc.id)) block("copying", "Wait for its data copy to finish.");
  const missing = missingServiceAction(ctx, svc.id);
  if (missing)
    block("access", `Moving a service needs full access to it, and you do not have ${missing} here. Ask an admin or the project's owner.`);
  return out;
}

/** Everything services.moveProjectImpact returns, for this caller. */
export function moveImpact(ctx: OpContext, svc: ServiceRow, targetProjectId: string): MoveImpact {
  const blockers = blockersFor(ctx, svc, targetProjectId);
  const fromGraph = buildEnvGraph(ctx, svc.projectId);
  const from = projectEnvOf(fromGraph);
  const to = targetProjectId === svc.projectId ? from : projectEnvOf(buildEnvGraph(ctx, targetProjectId));
  const self = from.services.find((s) => s.id === svc.id) ?? {
    id: svc.id,
    name: svc.name,
    kind: svc.kind,
    parsed: { text: "", entries: [], comments: [], problems: [] },
  };
  const can = (action: `${string}.${string}`, type: "project" | "service", id: string) => ctx.access.can(action, { type, id });

  const visible = (list: { service: EnvService; keys: string[] }[]) => {
    const shown: { serviceId: string; name: string; keys: string[] }[] = [];
    let hidden = 0;
    for (const { service, keys } of list) {
      if (!can("services.view", "service", service.id)) hidden++;
      else shown.push({ serviceId: service.id, name: service.name, keys: can("env.view", "service", service.id) ? keys : [] });
    }
    return { shown, hidden };
  };
  const moving = targetProjectId !== svc.projectId;
  const referencedBy = moving ? visible(referrersOf(svc.name, from, svc.id)) : { shown: [], hidden: 0 };
  const targetReferrers = moving ? visible(referrersOf(svc.name, to, svc.id)) : { shown: [], hidden: 0 };
  const ownReferences = moving && can("env.view", "service", svc.id) ? ownReferenceEffects(self, from, to) : [];
  const lost = moving ? sharedVariablesLost(self, from, to) : [];

  const grantRows = ctx.db
    .select({ name: users.name, email: users.email })
    .from(grants)
    .innerJoin(users, eq(users.id, grants.userId))
    .where(and(eq(grants.scopeType, "service"), eq(grants.scopeId, svc.id)))
    .all();
  return {
    blockers,
    referencedBy: referencedBy.shown,
    hiddenReferrers: referencedBy.hidden,
    targetReferrers: targetReferrers.shown,
    hiddenTargetReferrers: targetReferrers.hidden,
    ownReferences,
    sharedLost: { count: lost.length, names: can("env.view", "project", svc.projectId) ? lost : [] },
    grants: {
      count: grantRows.length,
      names: can("grants.view", "service", svc.id) ? grantRows.map((g) => g.name || g.email).sort() : [],
    },
    invites: invitesNaming(ctx, svc.id).length,
    switches: svc.targetDeploymentId !== null && !svc.stopped,
  };
}
