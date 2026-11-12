// Variables every service offers to references, by kind. The panel fills
// their values in env.references; docs and the editor list them from here
// so the names never drift apart.

import type { VariableScope } from "./types";

export interface BuiltinVariable {
  name: string;
  scope: VariableScope;
  sensitive: boolean;
  description: string;
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

/** Every built-in variable name of any kind (URL, DOMAIN, INTERNAL_URL, ..., INTERNAL_HTTP_PORT). */
export const builtinNames: ReadonlySet<string> = new Set([...appVariables, ...clickhouseVariables].map((b) => b.name));

/** Database service kinds; @seylo/ops databaseEngineIds lists the same (this package has no dependencies). */
const databaseKinds = new Set(["postgres", "mysql", "mariadb", "mongo", "redis", "valkey", "keydb", "dragonfly", "clickhouse"]);

export function builtinVariablesFor(serviceKind: string): readonly BuiltinVariable[] {
  if (serviceKind === "clickhouse") return clickhouseVariables;
  return databaseKinds.has(serviceKind) ? databaseVariables : appVariables;
}
