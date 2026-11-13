// Variables every service offers to references, by kind. The panel fills
// their values in env.references; docs and the editor list them from here
// so the names never drift apart. A list variable (DOMAINS) holds its
// items comma separated, and a reference may pick one by its 0-based
// index: ${{api.DOMAINS[1]}}. Another list variable only needs `list` and
// `item` here; the analyzer, resolution and the editor go by the flag.

import type { VariableScope } from "./types";

export interface BuiltinVariable {
  name: string;
  scope: VariableScope;
  sensitive: boolean;
  description: string;
  /**
   * A comma-separated list: a reference may pick one item by its 0-based
   * index, ${{api.DOMAINS[1]}}. The panel passes it on as
   * ReferenceVariable.list. Only list variables take an index.
   */
  list?: boolean;
  /** What one item of a list is, for messages ("api has 2 domains"). */
  item?: string;
}

const v = (name: string, scope: VariableScope, description: string, sensitive = false): BuiltinVariable => ({
  name,
  scope,
  sensitive,
  description,
});

/** Apps, compose members, Boxes. */
export const appVariables: readonly BuiltinVariable[] = [
  v("URL", "public", "public URL of the primary domain"),
  v("DOMAIN", "public", "host of the primary domain"),
  { ...v("DOMAINS", "public", "all domain hosts, primary first, comma separated"), list: true, item: "domain" },
  v("INTERNAL_URL", "internal", "http://<service>:<port> on the project network"),
  v("INTERNAL_HOST", "internal", "host name on the project network"),
  v("INTERNAL_PORT", "plain", "main container port"),
];

/** Every database engine. */
export const databaseVariables: readonly BuiltinVariable[] = [
  v("INTERNAL_URL", "internal", "connection URL on the project network"),
  v("INTERNAL_HOST", "internal", "host name on the project network"),
  v("INTERNAL_PORT", "plain", "port on the project network"),
  v("EXPOSED_URL", "public", "connection URL from anywhere, with TLS", true),
  v("EXPOSED_HOST", "public", "public host of the exposed port"),
  v("EXPOSED_PORT", "public", "exposed port"),
  v("USER", "plain", "user name"),
  v("PASSWORD", "plain", "password", true),
  v("DATABASE", "plain", "default database"),
];

/** ClickHouse adds its HTTP interface (the native protocol is INTERNAL_URL). */
export const clickhouseVariables: readonly BuiltinVariable[] = [
  ...databaseVariables,
  v("INTERNAL_HTTP_URL", "internal", "HTTP interface URL on the project network (port 8123), with the password"),
  v("INTERNAL_HTTP_PORT", "plain", "HTTP interface port on the project network"),
];

const allBuiltins: readonly BuiltinVariable[] = [...appVariables, ...clickhouseVariables];

/** Every built-in variable name of any kind (URL, DOMAIN, DOMAINS, INTERNAL_URL, ..., INTERNAL_HTTP_PORT). */
export const builtinNames: ReadonlySet<string> = new Set(allBuiltins.map((b) => b.name));

/** Names of the built-in list variables (DOMAINS): the ones that take an index. */
export const listNames: ReadonlySet<string> = new Set(allBuiltins.filter((b) => b.list).map((b) => b.name));

/** Database service kinds; @seylo/ops databaseEngineIds lists the same (this package has no dependencies). */
const databaseKinds = new Set(["postgres", "mysql", "mariadb", "mongo", "redis", "valkey", "keydb", "dragonfly", "clickhouse"]);

export function builtinVariablesFor(serviceKind: string): readonly BuiltinVariable[] {
  if (serviceKind === "clickhouse") return clickhouseVariables;
  return databaseKinds.has(serviceKind) ? databaseVariables : appVariables;
}

/** The items of a list variable's value: "" has none, "a.com,b.com" two. */
export function listItems(value: string): string[] {
  return value === "" ? [] : value.split(",");
}

/** What one item of the list variable `name` is ("domain" for DOMAINS), "item" for a list builtins.ts does not name. */
export function listItemName(name: string): string {
  return allBuiltins.find((b) => b.list && b.name === name)?.item ?? "item";
}

/**
 * The value a reference gets: the variable's value, or with an index the
 * item at that index of a list ("" past its end). Null when the value is
 * not known or hidden, and for an index on a variable that is no list (the
 * reference stays as written, like one to an unknown variable).
 */
export function referenceValue(
  variable: { value: string | null; list?: boolean } | null | undefined,
  index: number | null | undefined,
): string | null {
  if (!variable || variable.value === null) return null;
  if (index === null || index === undefined) return variable.value;
  if (!variable.list) return null;
  return listItems(variable.value)[index] ?? "";
}
