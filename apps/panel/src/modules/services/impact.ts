// What changes when a service leaves its project (services.moveProject) or
// a copy of it lands in another one (services.clone): ${{svc.VAR}}
// references and internal host names resolve by name inside one project,
// and shared ${{project.X}} variables come from the project. The functions
// on plain shapes are pure (tested directly); moveImpact reads the rows,
// filters by what the caller may see and adds what blocks a move.

import { appVariables, builtinVariablesFor, hostMentions, type ParsedEnv, parseEnv, sharedTarget } from "@seylo/env-analyzer";
import { allOps, grantableActions, OpError, type services as serviceOps } from "@seylo/ops";
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
import { assertSourceAllowed } from "./source-guard";
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

/** What renameSelf changed and what it left. */
export interface SelfRename {
  text: string;
  /** ${{from.X}} and `from` as a URL host or host:port, now naming the clone. */
  renamed: { key: string; target: string; via: "reference" | "hostname" }[];
  /** Values that are just `from` (HOST=web, but also DB_NAME=web): maybe a host, maybe not, so they stay. */
  kept: { key: string; target: string }[];
}

/**
 * A clone's .env with the source's name swapped for the clone's where it
 * named the service itself: ${{web.X}} in web's .env, and web as a host in
 * a URL or with a port (http://web/, user@web, web:3000). Copied as they
 * are, they would name the source (same project) or whatever has that name
 * in the target project. A value that is only the name is not touched: it
 * may be a database or user name rather than a host.
 */
export function renameSelf(text: string, from: string, to: string): SelfRename {
  if (from.toLowerCase() === to.toLowerCase()) return { text, renamed: [], kept: [] };
  const wanted = from.toLowerCase();
  const edits: { start: number; end: number }[] = [];
  const renamed: SelfRename["renamed"] = [];
  const kept: SelfRename["kept"] = [];
  const seen = new Set<string>();
  // Each variable and target once, however often the value repeats it.
  const once = (key: string, target: string) => {
    const id = `${key}\u0000${target}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
  for (const entry of parseEnv(text).entries) {
    for (const ref of entry.references) {
      if (ref.target.toLowerCase() !== wanted) continue;
      edits.push({ start: ref.targetRange.start, end: ref.targetRange.end });
      const target = `${ref.target}.${ref.variable}`;
      if (once(entry.key, target)) renamed.push({ key: entry.key, target, via: "reference" });
    }
    // Host names are found in the value as written (inside its quotes), references blanked out.
    const { start, end } = entry.valueRange;
    const quoted = entry.quote !== "none" && end > start;
    const base = quoted ? start + 1 : start;
    const close = quoted && end - start >= 2 && text[end - 1] === text[start] ? end - 1 : end;
    let raw = text.slice(base, close);
    for (const ref of entry.references) {
      const at = ref.range.start - base;
      raw = raw.slice(0, at) + " ".repeat(ref.raw.length) + raw.slice(at + ref.raw.length);
    }
    for (const m of hostMentions(raw, from)) {
      const before = raw[m.from - 1];
      if (m.port === "" && before !== "@" && before !== "/") {
        if (once(entry.key, m.host)) kept.push({ key: entry.key, target: m.host });
        continue;
      }
      edits.push({ start: base + m.from, end: base + m.from + m.host.length });
      const target = `${m.host}${m.port}`;
      if (once(entry.key, target)) renamed.push({ key: entry.key, target, via: "hostname" });
    }
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + to + out.slice(edit.end);
  return { text: out, renamed, kept };
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

/** Database variables that carry the password (env/graph.ts credentialVariables). */
const credentialVariables = new Set(["PASSWORD", "INTERNAL_URL", "INTERNAL_HTTP_URL", "EXPOSED_URL"]);

/**
 * Whether ${{svc.VAR}} only reads an address of the service (a built-in
 * like URL, INTERNAL_HOST or ClickHouse's INTERNAL_HTTP_PORT), which anyone
 * in its project may use. Its own variables and database credentials
 * (ClickHouse's INTERNAL_HTTP_URL too) are not open.
 */
export function isOpenVariable(serviceKind: string, variable: string): boolean {
  const builtins = builtinVariablesFor(serviceKind);
  const def = builtins.find((d) => d.name === variable);
  if (!def || def.sensitive) return false;
  return !(builtins !== appVariables && credentialVariables.has(variable));
}

/**
 * References in `project` to `name` that read more than an address. They
 * were written while nothing there had that name, so nobody checked that
 * their writer may read them; a service arriving under that name would
 * hand its values to whoever can run code next to them.
 */
export function plantedReferences(
  project: ProjectEnv,
  name: string,
  serviceKind: string,
  selfId: string,
): { service: EnvService; key: string; reference: string }[] {
  const wanted = name.toLowerCase();
  const out: { service: EnvService; key: string; reference: string }[] = [];
  for (const service of project.services) {
    if (service.id === selfId) continue;
    for (const entry of service.parsed.entries) {
      for (const ref of entry.references) {
        if (ref.target.toLowerCase() !== wanted || isOpenVariable(serviceKind, ref.variable)) continue;
        out.push({ service, key: entry.key, reference: `${ref.target}.${ref.variable}` });
      }
    }
  }
  return out;
}

/** The message for planted references, naming the service only when the caller may see it. */
export function plantedMessage(
  ctx: Pick<OpContext, "access">,
  planted: { service: EnvService; key: string; reference: string }[],
  projectName: string,
  advice: string,
): string {
  const first = planted[0] as (typeof planted)[number];
  const who = ctx.access.can("services.view", { type: "service", id: first.service.id })
    ? `${first.service.name} (${first.key})`
    : "A service you cannot see";
  return `${who} in ${projectName} already references ${first.reference}, which would start reading this service's values. ${advice}`;
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

function blockersFor(ctx: OpContext, svc: ServiceRow, targetProjectId: string, to: ProjectEnv): MoveBlock[] {
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
  if (targetProjectId !== svc.projectId) {
    const planted = plantedReferences(to, svc.name, svc.kind, svc.id);
    if (planted.length > 0)
      block("references", plantedMessage(ctx, planted, target?.name ?? "that project", "Remove that reference first."));
  }
  const missing = missingServiceAction(ctx, svc.id);
  if (missing)
    block("access", `Moving a service needs full access to it, and you do not have ${missing} here. Ask an admin or the project's owner.`);
  const attach = targetProjectId !== svc.projectId ? sourceAttachBlock(ctx, svc, targetProjectId) : null;
  if (attach) block("access", attach);
  return out;
}

/**
 * The source's git credential, registry login, GitHub installation or git
 * provider connection becomes usable in the new project once the service is
 * there (source-guard.ts: a project's services share what one of them uses),
 * so the move needs the same right as attaching it there.
 */
function sourceAttachBlock(ctx: OpContext, svc: ServiceRow, targetProjectId: string): string | null {
  try {
    assertSourceAllowed(ctx, targetProjectId, readSpec(svc.spec).source);
    return null;
  } catch (error) {
    // Only the permission matters here: the stored source passed its other checks when it was saved.
    if (error instanceof OpError && error.code === "FORBIDDEN") return error.message;
    return null;
  }
}

/** Everything services.moveProjectImpact returns, for this caller. */
export function moveImpact(ctx: OpContext, svc: ServiceRow, targetProjectId: string): MoveImpact {
  const fromGraph = buildEnvGraph(ctx, svc.projectId);
  const from = projectEnvOf(fromGraph);
  const to = targetProjectId === svc.projectId ? from : projectEnvOf(buildEnvGraph(ctx, targetProjectId));
  const blockers = blockersFor(ctx, svc, targetProjectId, to);
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
