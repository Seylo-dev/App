// Composes the panel from its parts. main.ts calls it with real files;
// tests call it with in-memory databases. Nothing here reads the
// environment or the clock directly.
//
// Three apps share one set of deps: `app` (the panel port), `agentApp` (the
// agents' TLS port) and `tailnetApp` (the unix socket Tailscale Serve
// proxies to, http/tailnet-host.ts). The tailnet app gets a copy of the
// deps that trusts forwarded headers from every peer and says it is the
// tailnet listener; it has no agent endpoint and no domain redirect. Module
// state is keyed by deps.db and deps.agents, which the copy shares, so a
// second module.http(deps) splits nothing.

import { allOps, apiPrefix } from "@seylo/ops";
import { opRoutes } from "@seylo/ops/elysia";
import { eq } from "drizzle-orm";
import { type AnyElysia, Elysia } from "elysia";
import { agentConnectPath, agentEndpoint } from "./agent-hub/endpoint";
import { createAgentHub } from "./agent-hub/hub";
import { agentMoveTarget } from "./agent-hub/move-target";
import type { Config } from "./config";
import type { Databases } from "./db/client";
import { nodes } from "./db/schema";
import type { Deps, OpRunner } from "./deps";
import { domainRedirect } from "./http/domain-redirect";
import { health } from "./http/health";
import { createHealthProof } from "./http/health-proof";
import { securityHeaders, servedOverHttps } from "./http/https";
import { httpOpHandler } from "./http/ops-http";
import { createProxyTrust, type ProxyTrust } from "./http/proxy-trust";
import { webApp } from "./http/static";
import { tailnetHostGuard } from "./http/tailnet-host";
import { createJobRunner, type JobRunner } from "./jobs/queue";
import { liveEndpoint } from "./live/endpoint";
import { createLiveHub } from "./live/hub";
import type { Logger } from "./logger";
import { createAlertSink } from "./modules/alerts/sink";
import { modules } from "./modules/index.gen";
import { mcpPath } from "./modules/mcp/server";
import type { PanelModule } from "./modules/module";
import { createNotifier } from "./modules/notifications/email";
import { agentsRefused, beginWrite, joinsRefused, pauseMessage, writePause } from "./modules/panelMove/pause";
import { appContentSecurityPolicy, injectBoot, readBoot } from "./modules/settings/boot";
import { tailnetIdentity } from "./modules/tailscale/facts";
import { collectHandlers } from "./ops/handlers";
import { createApprovalWarnings, createAuthorizer, createOpExecutor, createPrechecker, type ExecuteOp } from "./ops/pipeline";
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
  /** The panel for Tailscale Serve on the unix socket (main.ts listens on it): host pinned, forwarded headers trusted. */
  tailnetApp: AnyElysia;
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
    authorize: () => {
      throw new Error("ops are not ready yet: the panel is still being built");
    },
    precheck: () => {
      throw new Error("ops are not ready yet: the panel is still being built");
    },
    approvalWarning: () => {
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
    jobControl: runner,
    databases,
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
    healthProof: createHealthProof(),
  };

  const panelModules = options.modules ?? modules;
  for (const module of panelModules) runner.register(module.jobs ?? []);
  const handlers = collectHandlers(panelModules);
  const execute = createOpExecutor(deps, handlers, options.rateLimiter ?? createRateLimiter());
  ops.execute = execute;
  ops.authorize = createAuthorizer(db, handlers);
  ops.precheck = createPrechecker(deps, handlers);
  ops.approvalWarning = createApprovalWarnings(deps, handlers);
  const edgeKey = ensureEdgeTicketKey(db, secrets);
  for (const module of panelModules) module.start?.(deps);

  const app = buildApp(deps, execute, edgeKey, moduleRoutes(deps, panelModules));
  // Agents' node health check reads /api/health at the URL they joined (the pinned TLS port).
  const agentApp = new Elysia({ name: "agent-tls" }).use(health(deps)).use(agentRoutes(deps, edgeKey));
  const tailnetDeps: Deps = { ...deps, proxy: trustEveryPeer, listener: "tailnet" };
  const tailnetApp = buildApp(tailnetDeps, execute, edgeKey, moduleRoutes(tailnetDeps, panelModules), { tailnet: true });
  return { app, agentApp, tailnetApp, deps, runner, execute };
}

/** Only tailscaled (root) and the panel reach the socket, and Serve sets the forwarded headers itself. */
const trustEveryPeer: ProxyTrust = {
  trusts: () => true,
  check: async () => true,
  refresh: async () => {},
  start() {},
  stop() {},
};

/** The extra HTTP endpoints of every module (PanelModule.http), as one plugin. */
function moduleRoutes(deps: Deps, panelModules: readonly PanelModule[]): AnyElysia {
  let routes: AnyElysia = new Elysia({ name: "modules" });
  for (const module of panelModules) {
    if (module.http) routes = routes.use(module.http(deps));
  }
  return routes;
}

function buildApp(deps: Deps, execute: ExecuteOp, edgeTicketKey: EdgeTicketKey, modules: AnyElysia, options: { tailnet?: boolean } = {}) {
  // On the tailnet socket the host is pinned before anything else, and Host is set to it for the rest.
  const pinHost = options.tailnet ? tailnetHostGuard(() => tailnetIdentity(deps)) : null;
  return (
    new Elysia()
      // An error no route turned into a response (a broken database, a bug)
      // is a 500 with no detail, never Elysia's default of the message with
      // status 200, which health checks and clients would read as success.
      .onError({ as: "global" }, ({ code, error, set }) => {
        if (code === "NOT_FOUND" || code === "VALIDATION" || code === "PARSE") return;
        if (typeof (error as { status?: unknown })?.status === "number") return;
        deps.logger.error({ err: error, code }, "request failed");
        set.status = 500;
        return Response.json({ error: { code: "INTERNAL", message: "Something went wrong on the panel. Try again." } }, { status: 500 });
      })
      .onRequest(({ request }) => pinHost?.({ request }))
      .onRequest(async ({ request, set, server }) => {
        const peer = server?.requestIP(request)?.address ?? null;
        // A proxy that just joined the panel's network (the panel domain was
        // set, Traefik was recreated) counts from its first request, agent
        // connects included; everything after this reads deps.proxy.trusts().
        await deps.proxy.check(peer);
        // A Response's own headers win, so pages with stricter rules keep them.
        const https = servedOverHttps(deps, request, peer);
        // Never HSTS on the tailnet name: when the tailnet turns HTTPS certificates
        // off, the agent moves the panel to plain HTTP there, and HSTS would keep
        // every browser that visited on a dead https:// for a year while the path
        // counts as working. WireGuard already encrypts and authenticates that path.
        Object.assign(set.headers, securityHeaders({ hsts: https && !options.tailnet }));
      })
      .onRequest(({ request }) => pausedWrite(deps, request))
      .onAfterResponse({ as: "global" }, ({ request }) => writeFinished(request))
      .use(health(deps))
      .use(opRoutes(allOps, httpOpHandler(execute, deps)))
      .use(modules)
      .use(liveEndpoint(deps))
      // Agents connect on the panel port and the TLS port, never through Serve.
      .use((options.tailnet ? new Elysia({ name: "no-agents" }) : agentRoutes(deps, edgeTicketKey)) as AnyElysia)
      .use(
        webApp(deps.config.webDist, {
          renderIndex: (html) => injectBoot(html, readBoot(deps.db)),
          contentSecurityPolicy: appContentSecurityPolicy,
          // Visitors on the tailnet name stay on it.
          redirect: options.tailnet ? undefined : (request) => domainRedirect(deps, request),
        }),
      )
  );
}

/** Module endpoints that write and still run, until their response is out (the move waits for them). */
const moduleWrites = new WeakMap<Request, () => void>();

/** A request to a module endpoint that changes things (not an op, MCP or an agent's connect). */
function writesThroughModule(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  const path = new URL(request.url).pathname;
  return !(path.startsWith(`${apiPrefix}/`) || path === mcpPath || path === agentConnectPath);
}

/**
 * While the panel moves (modules/panelMove/pause.ts), module endpoints that
 * change things (webhooks, deploy trigger URLs, source uploads) answer 503
 * with Retry-After: what they would write is missing from the copy. Ops
 * refuse in the pipeline with their own CONFLICT, and MCP calls run ops.
 * One that passes counts as a write in flight until its response is out
 * (writeFinished), since it may await a provider or the body before it
 * writes and a move starting meanwhile must not copy the database first.
 */
function pausedWrite(deps: Deps, request: Request): Response | undefined {
  if (!writesThroughModule(request)) return undefined;
  const pause = writePause(deps.db);
  if (!pause) {
    moduleWrites.set(request, beginWrite(deps.db));
    return undefined;
  }
  const reason = pause.reason === "moved" ? "panelMoved" : "panelMoving";
  return Response.json(
    { error: { code: "UNAVAILABLE", message: pauseMessage(pause), details: { reason } } },
    { status: 503, headers: { "retry-after": "60" } },
  );
}

/** Ends the count pausedWrite started; Elysia runs it after every response, errors included. */
function writeFinished(request: Request): void {
  moduleWrites.get(request)?.();
  moduleWrites.delete(request);
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
    // A panel that moves takes no joins, and at the switch no connects (modules/panelMove/pause.ts).
    joinsRefused: () => joinsRefused(deps.db),
    refuse: () => agentsRefused(deps.db),
  });
}
