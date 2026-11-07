// Composes the panel from its parts. main.ts calls it with real files;
// tests call it with in-memory databases. Nothing here reads the
// environment or the clock directly.

import { allOps } from "@seylo/ops";
import { opRoutes } from "@seylo/ops/elysia";
import { eq } from "drizzle-orm";
import { type AnyElysia, Elysia } from "elysia";
import { agentEndpoint } from "./agent-hub/endpoint";
import { createAgentHub } from "./agent-hub/hub";
import { agentMoveTarget } from "./agent-hub/move-target";
import type { Config } from "./config";
import type { Databases } from "./db/client";
import { nodes } from "./db/schema";
import type { Deps, OpRunner } from "./deps";
import { domainRedirect } from "./http/domain-redirect";
import { health } from "./http/health";
import { securityHeaders, servedOverHttps } from "./http/https";
import { httpOpHandler } from "./http/ops-http";
import { createProxyTrust, type ProxyTrust } from "./http/proxy-trust";
import { webApp } from "./http/static";
import { createJobRunner, type JobRunner } from "./jobs/queue";
import { liveEndpoint } from "./live/endpoint";
import { createLiveHub } from "./live/hub";
import type { Logger } from "./logger";
import { createAlertSink } from "./modules/alerts/sink";
import { modules } from "./modules/index.gen";
import type { PanelModule } from "./modules/module";
import { createNotifier } from "./modules/notifications/email";
import { injectBoot, readBoot } from "./modules/settings/boot";
import { collectHandlers } from "./ops/handlers";
import { createOpExecutor, type ExecuteOp } from "./ops/pipeline";
import { createRateLimiter, type RateLimiter } from "./ops/rate-limit";
import { type EdgeTicketKey, ensureEdgeTicketKey } from "./security/edge-ticket-key";
import { createSecretBox } from "./security/secret-box";
import { ensurePanelId } from "./settings";

export interface PanelOptions {
  config: Config;
  databases: Databases;
  masterKey: Uint8Array;
  logger: Logger;
  /** Defaults to every module in modules/index.gen.ts. */
  modules?: readonly PanelModule[];
  rateLimiter?: RateLimiter;
  /** Defaults to the config's trusted proxies resolved through DNS. */
  proxy?: ProxyTrust;
  /** The agents' TLS listener's port and pin (main.ts makes the key); off when left out. */
  agentTls?: { port: number; pin: string } | null;
}

export interface Panel {
  app: ReturnType<typeof buildApp>;
  /** Only the agent endpoint, for the agents' TLS listener (main.ts listens on it with the certificate). */
  agentApp: AnyElysia;
  deps: Deps;
  runner: JobRunner;
  execute: ExecuteOp;
}

export function createPanel(options: PanelOptions): Panel {
  const { config, databases, logger } = options;
  const { db, metrics } = databases;
  const secrets = createSecretBox(options.masterKey);
  const runner = createJobRunner(db, logger.child({ component: "jobs" }));
  const agents = createAgentHub((error) => logger.error({ err: error }, "agent event listener failed"));
  const live = createLiveHub();
  const ops: OpRunner = {
    execute: async () => {
      throw new Error("ops are not ready yet: the panel is still being built");
    },
  };

  const deps: Deps = {
    config,
    db,
    metrics,
    secrets,
    logger,
    live,
    jobs: runner,
    schedules: runner.schedules,
    agents,
    alerts: createAlertSink({ db, jobs: runner, live, logger: logger.child({ component: "alerts" }) }),
    notify: createNotifier({ db, secrets, logger: logger.child({ component: "notify" }) }),
    ops,
    panelId: ensurePanelId(db),
    startedAt: new Date(),
    proxy:
      options.proxy ??
      createProxyTrust({ always: config.trustProxy, proxies: config.trustedProxies, moreProxies: () => panelNodeProxies(db) }),
    agentTls: options.agentTls ?? null,
  };

  const panelModules = options.modules ?? modules;
  for (const module of panelModules) runner.register(module.jobs ?? []);
  const handlers = collectHandlers(panelModules);
  const execute = createOpExecutor(deps, handlers, options.rateLimiter ?? createRateLimiter());
  ops.execute = execute;
  const edgeKey = ensureEdgeTicketKey(db, secrets);
  for (const module of panelModules) module.start?.(deps);

  const app = buildApp(deps, execute, edgeKey, moduleRoutes(deps, panelModules));
  // Agents' node health check reads /api/health at the URL they joined (the pinned TLS port).
  const agentApp = new Elysia({ name: "agent-tls" }).use(health(deps)).use(agentRoutes(deps, edgeKey));
  return { app, agentApp, deps, runner, execute };
}

/** The extra HTTP endpoints of every module (PanelModule.http), as one plugin. */
function moduleRoutes(deps: Deps, panelModules: readonly PanelModule[]): AnyElysia {
  let routes: AnyElysia = new Elysia({ name: "modules" });
  for (const module of panelModules) {
    if (module.http) routes = routes.use(module.http(deps));
  }
  return routes;
}

function buildApp(deps: Deps, execute: ExecuteOp, edgeTicketKey: EdgeTicketKey, modules: AnyElysia) {
  return new Elysia()
    .onRequest(({ request, set, server }) => {
      // A Response's own headers win, so pages with stricter rules keep them.
      const https = servedOverHttps(deps, request, server?.requestIP(request)?.address ?? null);
      Object.assign(set.headers, securityHeaders(https));
    })
    .use(health(deps))
    .use(opRoutes(allOps, httpOpHandler(execute, deps)))
    .use(modules)
    .use(liveEndpoint(deps))
    .use(agentRoutes(deps, edgeTicketKey))
    .use(
      webApp(deps.config.webDist, {
        renderIndex: (html) => injectBoot(html, readBoot(deps.db)),
        redirect: (request) => domainRedirect(deps, request),
      }),
    );
}

/** Next to Wings, the panel sits behind the fork's Traefik: its name comes with the panel node's facts. */
function panelNodeProxies(db: Databases["db"]): string[] {
  const row = db.select({ facts: nodes.facts }).from(nodes).where(eq(nodes.isPanelNode, true)).get();
  const name = (row?.facts as { wings?: { proxyContainer?: string } } | null | undefined)?.wings?.proxyContainer;
  return name ? [name] : [];
}

/** The agent WebSocket endpoint; served on the main port and on the agents' TLS port. */
function agentRoutes(deps: Deps, edgeTicketKey: EdgeTicketKey) {
  return agentEndpoint({
    db: deps.db,
    hub: deps.agents,
    logger: deps.logger.child({ component: "agent-hub" }),
    panelId: deps.panelId,
    panelVersion: deps.config.version,
    edgeTicketKey,
    panelNodeFromInstallerOnly: deps.config.image !== null,
    proxy: deps.proxy,
    // Nodes that joined over an IP address move to the live panel domain.
    moveTarget: (nodeId) => agentMoveTarget(deps.db, nodeId),
  });
}
