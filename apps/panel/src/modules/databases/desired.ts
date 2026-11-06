// The database part of a ServiceSpec, for the desired-state compiler: the
// DatabaseSpec (kind_spec "database") the agent uses for tools, backups and
// TLS exposure. Image, command, ports, health check, volume and recreate
// deploys are in the services spec written at create (databases.create via
// insertService); the engine's environment comes from env/desired.ts.

import type { MessageInitShape } from "@bufbuild/protobuf";
import { DatabaseEngine, type DatabaseSpecSchema } from "@seylo/proto";
import type { Deps } from "../../deps";
import { findDatabase, loadDatabase } from "./info";

export type DatabaseSpecInit = MessageInitShape<typeof DatabaseSpecSchema>;

const protoEngines = {
  postgres: DatabaseEngine.POSTGRES,
  mysql: DatabaseEngine.MYSQL,
  mariadb: DatabaseEngine.MARIADB,
  mongo: DatabaseEngine.MONGO,
  redis: DatabaseEngine.REDIS,
} as const;

/** Null for services that are not databases. */
export function databaseRuntime(deps: Pick<Deps, "db" | "secrets">, serviceId: string): { database: DatabaseSpecInit } | null {
  if (!findDatabase(deps.db, serviceId)) return null;
  const info = loadDatabase(deps, serviceId);
  return {
    database: {
      engine: protoEngines[info.row.engine],
      version: info.row.version,
      credentials: { adminUser: info.admin.user, adminPassword: info.admin.password, database: info.admin.database },
      tools: { webUi: true, webUiIdleTimeout: { seconds: BigInt(info.row.webUiIdleMinutes * 60) } },
      exposure: info.exposure
        ? {
            enabled: true,
            hostPort: info.exposure.listenPort,
            allowedSourceCidrs: info.exposure.allowedCidrs,
            tlsHostname: info.row.tlsHostname ?? "",
            // The agent creates or rotates this TLS-only user; Redis keeps its one user.
            ...(info.row.engine === "redis" ? {} : { user: info.exposedUser.user, password: info.exposedUser.password }),
          }
        : { enabled: false },
    },
  };
}
