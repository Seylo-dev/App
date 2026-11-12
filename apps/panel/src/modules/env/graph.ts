// Every env value of one project, resolved: built-in variables of each
// service (URL, INTERNAL_URL, database credentials, ...), each service's
// own .env keys with ${{svc.VAR}} references followed across services, and
// the project's shared variables. References that loop never resolve
// (the analyzer reports them as reference-cycle). The References op, the
// analyzer context and the desired state all read from this one graph.

import {
  type AnalyzeContext,
  builtinVariablesFor,
  isPublicName,
  isSecretEntry,
  looksSecret,
  type NodeRef,
  type ParsedEnv,
  parseEnv,
  type ReferenceTarget,
  type ReferenceVariable,
  secretOverride,
  sharedTarget,
  substituteReferences,
} from "@seylo/env-analyzer";
import { and, asc, eq, ne } from "drizzle-orm";
import { domains, services } from "../../db/schema";
import type { Deps } from "../../deps";
import { exposedConnection, exposureState, findDatabase, internalConnection, loadDatabase } from "../databases/info";
import { databaseKinds, mainPort, type ServiceRow, serviceNodes } from "../domains/lookup";
import { domainUrl, primaryDomain } from "../domains/rows";
import { readProjectEnv, readServiceEnv } from "./store";

export interface GraphService {
  row: ServiceRow;
  nodes: NodeRef[];
  parsed: ParsedEnv;
  /** Built-in variables with their values ("" when not known yet, for example no domain). */
  builtins: ReferenceVariable[];
  exposed: boolean;
  isDatabase: boolean;
}

export interface EnvGraph {
  projectId: string;
  services: GraphService[];
  shared: ParsedEnv;
  byName(name: string): GraphService | undefined;
  /** Resolved value of target.variable; null when unknown, unresolvable or in a cycle. */
  value(target: string, variable: string): string | null;
  /** Resolved own keys of a service, in file order, last duplicate wins. */
  resolveService(serviceId: string): { values: Map<string, string>; unresolved: { key: string; target: string; variable: string }[] };
  sharedValues(): Map<string, string>;
  /**
   * Whether target.variable holds a secret (env-analyzer isSecretEntry: its
   * "# @public"/"# @secret" comment, its name, its value, or a reference to a
   * secret such as a database password); unknown variables are not.
   */
  isSecret(target: string, variable: string): boolean;
}

/** Variables whose value carries a database password. */
const credentialVariables = new Set(["PASSWORD", "INTERNAL_URL", "INTERNAL_HTTP_URL", "EXPOSED_URL"]);

export function isCredentialVariable(service: GraphService, variable: string): boolean {
  return service.isDatabase && credentialVariables.has(variable);
}

function builtinsFor(deps: Pick<Deps, "db" | "secrets">, row: ServiceRow): { builtins: ReferenceVariable[]; exposed: boolean } {
  const defs = builtinVariablesFor(row.kind);
  const values = new Map<string, string>();
  let exposed = false;
  if (databaseKinds.has(row.kind) && findDatabase(deps.db, row.id)) {
    const info = loadDatabase(deps, row.id);
    const internal = internalConnection(info);
    // Null, so EXPOSED_* are empty, while exposure is off or waits for the node's update (its port is closed).
    const outside = exposedConnection(info);
    exposed = exposureState(info) === "open";
    values.set("INTERNAL_URL", internal.url);
    values.set("INTERNAL_HOST", internal.host);
    values.set("INTERNAL_PORT", String(internal.port));
    if (internal.httpUrl) values.set("INTERNAL_HTTP_URL", internal.httpUrl);
    if (info.engine.httpPort !== null) values.set("INTERNAL_HTTP_PORT", String(info.engine.httpPort));
    values.set("EXPOSED_URL", outside?.url ?? "");
    values.set("EXPOSED_HOST", outside?.host ?? "");
    values.set("EXPOSED_PORT", outside ? String(outside.port) : "");
    values.set("USER", info.admin.user);
    values.set("PASSWORD", info.admin.password);
    values.set("DATABASE", info.admin.database);
  } else {
    const primary = primaryDomain(deps.db, row.id);
    const port = mainPort(row);
    values.set("URL", primary ? domainUrl(primary) : "");
    values.set("DOMAIN", primary?.host ?? "");
    values.set("INTERNAL_URL", port ? `http://${row.name}:${port}` : "");
    values.set("INTERNAL_HOST", row.name);
    values.set("INTERNAL_PORT", port ? String(port) : "");
    exposed = !!deps.db
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.serviceId, row.id)))
      .all()
      .find(Boolean);
  }
  return {
    exposed,
    builtins: defs.map((def) => ({
      name: def.name,
      value: values.get(def.name) ?? "",
      scope: def.scope,
      sensitive: def.sensitive || (databaseKinds.has(row.kind) && credentialVariables.has(def.name)),
      description: def.description,
    })),
  };
}

export function buildEnvGraph(deps: Pick<Deps, "db" | "secrets">, projectId: string): EnvGraph {
  const rows = deps.db
    .select()
    .from(services)
    // Compose stacks themselves do not run; their members do.
    .where(and(eq(services.projectId, projectId), ne(services.kind, "compose")))
    .orderBy(asc(services.name))
    .all();
  const list: GraphService[] = rows.map((row) => {
    const { builtins, exposed } = builtinsFor(deps, row);
    return {
      row,
      nodes: serviceNodes(deps.db, row.id).map((n) => ({ id: n.id, name: n.name })),
      parsed: parseEnv(readServiceEnv(deps.db, deps.secrets, row.id).text),
      builtins,
      exposed,
      isDatabase: databaseKinds.has(row.kind),
    };
  });
  const byName = new Map(list.map((s) => [s.row.name.toLowerCase(), s]));
  const shared = parseEnv(readProjectEnv(deps.db, deps.secrets, projectId).text);
  const sharedMap = new Map<string, string>();
  for (const entry of shared.entries) sharedMap.set(entry.key, entry.value);

  // Memo per "service.KEY": a string when resolved, null when it cannot be,
  // "visiting" while on the stack (a second visit is a cycle).
  const memo = new Map<string, string | null | "visiting">();

  const ownValue = (service: GraphService, key: string): string | null => {
    const id = `${service.row.id}.${key}`;
    const known = memo.get(id);
    if (known === "visiting") return null;
    if (known !== undefined) return known;
    const entry = service.parsed.entries.findLast((e) => e.key === key);
    if (!entry) return null;
    memo.set(id, "visiting");
    let result: string | null;
    if (entry.quote === "single") {
      result = entry.value;
    } else {
      const self = service.row.name.toLowerCase();
      const out = substituteReferences(entry.value, (target, variable) =>
        target.toLowerCase() === self ? ownBuiltin(service, variable) : value(target, variable),
      );
      result = out.unresolved.length > 0 ? null : out.value;
    }
    memo.set(id, result);
    return result;
  };

  /** A service's own built-in value (its DOMAIN, URL, ...), the only part of itself its env may reference. */
  const ownBuiltin = (service: GraphService, variable: string): string | null =>
    service.builtins.find((b) => b.name === variable)?.value ?? null;

  const value = (target: string, variable: string): string | null => {
    if (target === sharedTarget) return sharedMap.get(variable) ?? null;
    const service = byName.get(target.toLowerCase());
    if (!service) return null;
    const builtin = service.builtins.find((b) => b.name === variable);
    if (builtin) return builtin.value;
    return ownValue(service, variable);
  };

  // Memo per "service.KEY" like values; a loop counts as secret (never guessed public).
  const secretMemo = new Map<string, boolean | "visiting">();
  const isSecret = (target: string, variable: string): boolean => {
    if (target === sharedTarget) {
      const entry = shared.entries.findLast((e) => e.key === variable);
      return entry ? isSecretEntry(shared, entry) : false;
    }
    const service = byName.get(target.toLowerCase());
    if (!service) return false;
    const builtin = service.builtins.find((b) => b.name === variable);
    if (builtin) return builtin.sensitive;
    const id = `${service.row.id}.${variable}`;
    const known = secretMemo.get(id);
    if (known === "visiting") return true;
    if (known !== undefined) return known;
    const entry = service.parsed.entries.findLast((e) => e.key === variable);
    if (!entry) return false;
    secretMemo.set(id, "visiting");
    // A "# @public"/"# @secret" comment decides; otherwise the resolved value counts too
    // (a reference to a plain variable that holds a token).
    const override = secretOverride(service.parsed, entry);
    const result =
      override !== null
        ? override === "secret"
        : isSecretEntry(service.parsed, entry, (ref) => isSecret(ref.target, ref.variable)) ||
          (!isPublicName(variable) && looksSecret(ownValue(service, variable) ?? ""));
    secretMemo.set(id, result);
    return result;
  };

  return {
    projectId,
    services: list,
    shared,
    isSecret,
    byName: (name) => byName.get(name.toLowerCase()),
    value,
    sharedValues: () => new Map(sharedMap),
    resolveService(serviceId) {
      const service = list.find((s) => s.row.id === serviceId);
      const values = new Map<string, string>();
      const unresolved: { key: string; target: string; variable: string }[] = [];
      if (!service) return { values, unresolved };
      const self = service.row.name.toLowerCase();
      for (const entry of service.parsed.entries) {
        if (entry.quote === "single") {
          values.set(entry.key, entry.value);
          continue;
        }
        const out = substituteReferences(entry.value, (target, variable) => {
          // Its own DOMAIN, URL, ... resolve; its own variables do not (a loop back into this file).
          if (target.toLowerCase() === self) return ownBuiltin(service, variable);
          return value(target, variable);
        });
        values.set(entry.key, out.value);
        for (const miss of out.unresolved) unresolved.push({ key: entry.key, ...miss });
      }
      return { values, unresolved };
    },
  };
}

export interface ContextOptions {
  /** Whether the caller may see this target's values; hidden values are null. Defaults to all. */
  canSee?: (target: GraphService | "shared", variable: string) => boolean;
}

/** The analyzer context of one service: every other service of the project and the shared variables. */
export function contextFor(graph: EnvGraph, serviceId: string, options: ContextOptions = {}): AnalyzeContext {
  const self = graph.services.find((s) => s.row.id === serviceId);
  const canSee = options.canSee ?? (() => true);
  const targets: ReferenceTarget[] = [];
  for (const service of graph.services) {
    if (service.row.id === serviceId) continue;
    const builtinNames = new Set(service.builtins.map((b) => b.name));
    const own: ReferenceVariable[] = [];
    const seen = new Set<string>();
    for (const entry of [...service.parsed.entries].reverse()) {
      if (seen.has(entry.key) || builtinNames.has(entry.key)) continue;
      seen.add(entry.key);
      own.unshift({
        name: entry.key,
        value: canSee(service, entry.key) ? graph.value(service.row.name, entry.key) : null,
        scope: "plain",
        sensitive: true,
        description: "variable of this service",
        dependsOn: entry.references.map((r) => ({ target: r.target, variable: r.variable })),
      });
    }
    targets.push({
      name: service.row.name,
      kind: "service",
      serviceId: service.row.id,
      serviceKind: service.row.kind,
      nodes: service.nodes,
      internalHost: service.row.name,
      exposed: service.exposed,
      variables: [...service.builtins.map((b) => ({ ...b, value: canSee(service, b.name) ? b.value : null })), ...own],
    });
  }
  if (graph.shared.entries.length > 0) {
    const values = graph.sharedValues();
    targets.push({
      name: sharedTarget,
      kind: "shared",
      serviceId: null,
      serviceKind: null,
      nodes: [],
      internalHost: null,
      exposed: false,
      variables: [...values.keys()].map((name) => ({
        name,
        value: canSee("shared", name) ? (values.get(name) ?? null) : null,
        scope: "plain" as const,
        sensitive: true,
        description: "shared variable",
      })),
    });
  }
  return {
    self: {
      serviceId,
      name: self?.row.name ?? "",
      nodes: self?.nodes ?? [],
      // Its own DOMAIN, URL, ... it may reference as ${{<name>.DOMAIN}}.
      builtins: self ? self.builtins.map((b) => ({ ...b, value: canSee(self, b.name) ? b.value : null })) : [],
    },
    targets,
  };
}
