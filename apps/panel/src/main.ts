// Panel entry point: read the config, open the data dir, start serving.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config";
import { openDatabases } from "./db/client";
import { panelWebsocket } from "./http/ws-guard";
import { createLogger } from "./logger";
import { createPanel } from "./panel";
import { ensureAgentTls } from "./security/agent-tls";
import { loadMasterKey } from "./security/master-key";
import { finishInterruptedRotation } from "./security/rotate-master-key";

// src/main.ts and dist/main.js both sit one level below apps/panel.
const packageRoot = resolve(import.meta.dir, "..");
const config = loadConfig(process.env, packageRoot);
const logger = createLogger(config.logLevel);

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const panelPath = join(config.dataDir, "panel.db");
const freshInstall = !existsSync(panelPath);
// A master-key rotation that did not finish (master.key.new left): finished
// here when panel.db is already sealed with the new key, else the leftover
// is removed and the panel keeps the old key.
const leftover = finishInterruptedRotation(config.dataDir);
if (leftover === "finished") logger.warn("finished a master-key rotation that stopped before master.key was replaced");
if (leftover === "removed") {
  logger.warn("removed master.key.new left by a master-key rotation that never committed; master.key is unchanged, run the rotation again");
}
const masterKey = loadMasterKey(join(config.dataDir, "master.key"), freshInstall);
const databases = openDatabases({ panelPath, metricsPath: join(config.dataDir, "metrics.db"), migrationsDir: config.migrationsDir });

// Agents reach a panel without a domain over TLS with a pinned key (security/agent-tls.ts).
const agentTls = config.agentTlsPort ? ensureAgentTls(config.dataDir, config.agentTlsPort) : null;
const panel = createPanel({ config, databases, masterKey, logger, agentTls: agentTls && { port: agentTls.port, pin: agentTls.pin } });
panel.runner.start(panel.deps);
panel.deps.proxy.start();
// Both listeners check text frames before Elysia parses them (http/ws-guard.ts).
panel.app.listen({ hostname: config.host, port: config.port, websocket: panelWebsocket });
if (agentTls) {
  panel.agentApp.listen({
    hostname: config.host,
    port: agentTls.port,
    tls: { cert: agentTls.certPem, key: agentTls.keyPem },
    websocket: panelWebsocket,
  });
  logger.info({ port: agentTls.port, pin: agentTls.pin }, "agent TLS listener ready");
}
logger.info({ host: config.host, port: config.port, version: config.version, dataDir: config.dataDir }, "panel listening");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "panel stopping");
  // stop(true) closes open connections too, agent WebSockets included, so
  // the process exits and agents reconnect to the next one.
  await panel.app.stop(true);
  if (agentTls) await panel.agentApp.stop(true);
  await panel.runner.stop();
  panel.deps.proxy.stop();
  databases.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
// Bun ends the process on an unhandled rejection or a throw in a timer. One
// bad promise must not drop the API, every agent connection and the live
// sockets: log it and keep serving.
process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled promise rejection"));
process.on("uncaughtException", (error) => logger.error({ err: error }, "uncaught exception"));
