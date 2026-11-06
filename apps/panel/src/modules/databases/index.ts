// Databases: Postgres (with pgvector as a variant), MySQL, MariaDB, Mongo,
// Redis, Valkey, KeyDB, Dragonfly and ClickHouse services with generated
// credentials (sealed in service_secrets), pinned images, a data volume,
// internal and exposed connection URLs, password resets, the web UI and
// shell links, and TLS exposure. desired.ts gives the compiler the runtime
// half of their ServiceSpec.

import { defineModule } from "../module";
import { connection, create, get, listEngines, openShell, openWebUi, resetPassword, setExposure } from "./ops";

export default defineModule({
  name: "databases",
  ops: [listEngines, create, get, connection, resetPassword, openWebUi, openShell, setExposure],
});
