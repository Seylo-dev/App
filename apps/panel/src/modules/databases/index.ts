// Databases: Postgres (with pgvector as a variant), MySQL, MariaDB, Mongo,
// Redis, Valkey, KeyDB, Dragonfly and ClickHouse services with generated
// credentials (sealed in service_secrets), pinned images, a data volume,
// internal and exposed connection URLs, password resets, the Users tab
// (users.ts: login users read from the engine, made, changed and deleted
// there, and the main user Seylo signs in with), the web UI and
// shell links, and TLS exposure. desired.ts gives the compiler the runtime
// half of their ServiceSpec; retire.ts holds back the retirement of an old
// exposed user while running services still have its URL, and sends it
// once none has (also from a job every minute); capability.ts tells open
// screens when a node's update reopens its exposed databases.

import { defineJob } from "../../jobs/queue";
import { defineModule } from "../module";
import { watchExposureCapabilities } from "./capability";
import { connection, create, get, listEngines, openShell, openWebUi, resetPassword, setExposure } from "./ops";
import { releaseHeldRetirements, watchRetirements } from "./retire";
import { createUser, deleteUser, listUsers, renameUser, setUserPassword, switchMainUser } from "./users";
import { setVersion, versionChoices } from "./version";

const retirementsType = "databases.retirements";

const retirements = defineJob({
  type: retirementsType,
  maxAttempts: 1,
  async run(_payload, ctx) {
    releaseHeldRetirements(ctx);
  },
});

export default defineModule({
  name: "databases",
  ops: [
    listEngines,
    create,
    get,
    connection,
    resetPassword,
    openWebUi,
    openShell,
    setExposure,
    versionChoices,
    setVersion,
    listUsers,
    createUser,
    setUserPassword,
    renameUser,
    deleteUser,
    switchMainUser,
  ],
  jobs: [retirements],
  start(deps) {
    watchRetirements(deps);
    watchExposureCapabilities(deps);
    deps.schedules.ensure({ key: retirementsType, jobType: retirementsType, intervalSeconds: 60, missedRun: "skip" });
  },
});
