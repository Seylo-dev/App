// The database part of a ServiceSpec, for the desired-state compiler: the
// DatabaseSpec (kind_spec "database") the agent uses for tools, backups, TLS
// exposure and retiring the old exposed user (retire.ts). Image, command,
// ports, health check, volume and recreate deploys are in the services spec
// written at create (databases.create via insertService); the engine's
// environment comes from env/desired.ts.

import type { MessageInitShape } from "@bufbuild/protobuf";
import { DatabaseEngine, type DatabaseSpecSchema } from "@seylo/proto";
import type { Deps } from "../../deps";
import type { CompileMemo } from "../../desired/contributors";
import { missingExposureCapability } from "./capability";
import { findDatabase, loadDatabase } from "./info";
import { retiredExposedUser } from "./retire";

export type DatabaseSpecInit = MessageInitShape<typeof DatabaseSpecSchema>;

const protoEngines = {
  postgres: DatabaseEngine.POSTGRES,
  mysql: DatabaseEngine.MYSQL,
  mariadb: DatabaseEngine.MARIADB,
  mongo: DatabaseEngine.MONGO,
  redis: DatabaseEngine.REDIS,
  valkey: DatabaseEngine.VALKEY,
  keydb: DatabaseEngine.KEYDB,
  dragonfly: DatabaseEngine.DRAGONFLY,
  clickhouse: DatabaseEngine.CLICKHOUSE,
} as const;

/**
 * Null for services that are not databases. With nodeId (the compiler's
 * node), exposure is never sent to an agent that cannot keep the port TLS
 * only (missingExposureCapability): an engine added in 0.2 needs
 * database.engines.v2, Postgres, MySQL and MariaDB need
 * database.exposure.v2. allowPlain goes only to an agent that advertises
 * database.exposure.plain.v1 (info.plainNeedsNodeUpdate; an older one
 * would ignore it and stay TLS only anyway). memo is the compile's
 * (retire.ts scans the running deployments once per compile).
 */
export function databaseRuntime(
  deps: Pick<Deps, "db" | "secrets">,
  serviceId: string,
  nodeId?: string,
  memo?: CompileMemo,
): { database: DatabaseSpecInit } | null {
  if (!findDatabase(deps.db, serviceId)) return null;
  const info = loadDatabase(deps, serviceId);
  const exposable = nodeId === undefined || missingExposureCapability(deps.db, null, info.engine, nodeId) === null;
  return {
    database: {
      engine: protoEngines[info.row.engine],
      version: info.row.version,
      credentials: { adminUser: info.admin.user, adminPassword: info.admin.password, database: info.admin.database },
      tools: { webUi: true, webUiIdleTimeout: { seconds: BigInt(info.row.webUiIdleMinutes * 60) } },
      exposure:
        info.exposure && exposable
          ? {
              enabled: true,
              hostPort: info.exposure.listenPort,
              allowedSourceCidrs: info.exposure.allowedCidrs,
              tlsHostname: info.row.tlsHostname ?? "",
              allowPlain: info.exposure.allowPlain && !info.plainNeedsNodeUpdate,
            }
          : { enabled: false },
      // The separate exposed user of a database from before 0.2.9, once no running service has its URL.
      retiredExposedUser: retiredExposedUser(deps, info, memo),
    },
  };
}
