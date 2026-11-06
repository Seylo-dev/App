// The database part of a ServiceSpec, for the desired-state compiler: the
// DatabaseSpec (kind_spec "database") the agent uses for tools, backups and
// TLS exposure. Image, command, ports, health check, volume and recreate
// deploys are in the services spec written at create (databases.create via
// insertService); the engine's environment comes from env/desired.ts.

import type { MessageInitShape } from "@bufbuild/protobuf";
import { DatabaseEngine, type DatabaseSpecSchema } from "@seylo/proto";
import type { Deps } from "../../deps";
import { nodeHasCapability } from "./capability";
import { enginesCapability } from "./engines";
import { findDatabase, loadDatabase } from "./info";

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
 * node), an engine that needs database.engines.v2 is never sent exposed to
 * a node whose agent did not advertise it: an older agent would relay the
 * port without TLS.
 */
export function databaseRuntime(
  deps: Pick<Deps, "db" | "secrets">,
  serviceId: string,
  nodeId?: string,
): { database: DatabaseSpecInit } | null {
  if (!findDatabase(deps.db, serviceId)) return null;
  const info = loadDatabase(deps, serviceId);
  const exposable =
    !info.engine.needsAgentCapability || nodeId === undefined || nodeHasCapability(deps.db, null, nodeId, enginesCapability);
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
              // The agent creates or rotates this TLS-only user; the Redis-like engines keep their one user.
              ...(info.engine.redisLike ? {} : { user: info.exposedUser.user, password: info.exposedUser.password }),
            }
          : { enabled: false },
    },
  };
}
