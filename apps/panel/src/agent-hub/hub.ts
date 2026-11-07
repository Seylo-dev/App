// The agent hub: deps.agents. It tracks which nodes are connected, calls
// their agents (calls.ts), keeps their actual state in memory
// (node-state.ts), fans agent events out to modules, and holds the
// desired-state dirty queue (../desired). One session per node: a second
// connection for the same node is rejected during the handshake.
//
// How modules use it (CONTRACTS.md "Agent hub" has the long form):
//
//   const res = await ctx.agents.call(nodeId, "fsList", { root, path });          // typed unary call
//   const logs = ctx.agents.open(nodeId, "logsFollow", { target: { case: "serviceId", value: id } });
//   for await (const batch of logs) ...                                            // streaming call
//   ctx.agents.state.serviceStatuses(serviceId)                                    // actual state, no round trip
//   ctx.agents.onEvent("deployProgress", (nodeId, progress) => ...)                // in a module's start()
//   ctx.agents.desired.markDirty({ serviceId })                                    // after changing rows

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { OpError } from "@seylo/ops";
import type { CrashReport, Event, NodeFacts } from "@seylo/proto";
import { createDesiredStateSync, type DesiredStateSync } from "../desired/dirty";
import {
  type AgentMethodName,
  type AgentRequest,
  type AgentResponse,
  type AgentStream,
  agentMethod,
  type CallOptions,
  defaultCallTimeoutMs,
  methodCapability,
  missingCapability,
  nodeOffline,
  type RawAgentStream,
  type RawMethodName,
  type StreamingMethodName,
  type StreamOptions,
  type UnaryMethodName,
  wireMethodName,
} from "./calls";
import { createNodeStateStore, type NodeStateStore } from "./node-state";
import type { PanelServiceHandlers } from "./panel-service-types";
import { isRawMethod, isStreamingMethod, messageStream, type OpenedStream, rawStream } from "./streams";

/** How long a node's service scope is reused for best-effort events, and after how long a miss looks again. */
const scopeCacheMs = 1000;
const scopeRecheckMs = 100;
/** Most service entries a metrics event keeps (once each) when no scope is set. */
const maxMetricsServices = 1000;

/** Byte-level transport of one session; AgentSession implements it. Hub-internal. */
export interface AgentTransport {
  /** Sends CALL and resolves with the RESULT's response bytes; rejects with an OpError (calls.ts). */
  call(wireMethod: string, request: Uint8Array, options: CallOptions & { method: AgentMethodName }): Promise<Uint8Array>;
  /** Sends OPEN and returns the stream's channel; throws an OpError when the session is gone. */
  open(wireMethod: string, request: Uint8Array, options: StreamOptions & { method: AgentMethodName }): OpenedStream;
}

export interface ConnectedAgent {
  readonly nodeId: string;
  readonly sessionId: string;
  /** Facts from the agent's hello; they carry its capabilities. */
  readonly facts: NodeFacts | null;
  readonly transport: AgentTransport;
  /** The Host header the agent dialed (lowercased), for example the panel domain or "<ip>:<port>". */
  readonly host?: string | null;
  /** The panel base URL the agent dialed, for example "https://panel.example.com" or "https://203.0.113.4:3443". */
  readonly address?: string | null;
  /** Closes the connection; the agent reconnects with backoff. */
  close(reason: string): void;
}

/** Event payload kinds: "stateDelta", "deployProgress", "buildProgress", "healthChanged", "metrics", ... */
export type AgentEventKind = NonNullable<Event["payload"]["case"]>;
export type AgentEventPayload<K extends AgentEventKind> = Extract<Event["payload"], { case: K }>["value"];

/**
 * How an event arrived. Durable events came through PanelService.ReportEvent
 * from the agent's on-disk outbox: they are stored (agent_reports) before
 * listeners run and are delivered once per (node, outboxId) even when the
 * agent retries. Best-effort events came as EVENT frames.
 */
export interface AgentEventMeta {
  durable: boolean;
  /** Agent outbox id of a durable event (decimal string); null for best-effort events. */
  outboxId: string | null;
}

export type AgentEventListener = (nodeId: string, event: Event, meta: AgentEventMeta) => void;
export type AgentEventKindListener<K extends AgentEventKind> = (
  nodeId: string,
  payload: AgentEventPayload<K>,
  event: Event,
  meta: AgentEventMeta,
) => void;
/** A crash report, already stored in crash_reports (crashId is its row id). */
export type AgentCrashListener = (nodeId: string, report: CrashReport, meta: { outboxId: string; crashId: string }) => void;
export type AgentConnectionListener = (nodeId: string, online: boolean) => void;

export interface AgentHub {
  // Sessions (used by the agent endpoint).
  /** False when the node already has a live session. */
  register(agent: ConnectedAgent): boolean;
  unregister(agent: ConnectedAgent): void;
  emitEvent(nodeId: string, event: Event, meta?: AgentEventMeta): void;
  /** For the PanelService ReportCrash handler, after the crash is stored. */
  emitCrash(nodeId: string, report: CrashReport, meta: { outboxId: string; crashId: string }): void;
  /** Closes the node's session (if any) and drops its in-memory state; for nodes.remove. */
  forgetNode(nodeId: string, reason: string): void;
  /** Closes the node's connection and keeps its state; the agent reconnects on its own (moves to the panel domain). */
  reconnect(nodeId: string, reason: string): void;
  /** The Host header of the node's current connection, or null (offline or unknown). */
  dialedHost(nodeId: string): string | null;
  /** The panel base URL of the node's current connection, or null (offline or unknown). */
  dialedAddress(nodeId: string): string | null;

  /** PanelService handlers (panel-service.ts); null until the nodes module attaches them. */
  readonly panelService: PanelServiceHandlers | null;
  attachPanelService(handlers: PanelServiceHandlers): void;
  /** Oldest agent version allowed to connect; null = no floor. */
  minimumAgentVersion(): string | null;
  /** The updates module sets the policy (panel version N-2 and the release manifest's minAgent). */
  setAgentVersionPolicy(policy: () => string | null): void;
  /**
   * The services a node may report on (service-scope.ts); events, state and
   * metrics about other services are dropped. Unset: everything passes.
   */
  setServiceScope(scope: (nodeId: string) => ReadonlySet<string>): void;
  /** Whether the node may report on the service (true while no scope is set). */
  mayReport(nodeId: string, serviceId: string): boolean;

  isOnline(nodeId: string): boolean;
  onlineNodeIds(): string[];

  /**
   * Capabilities the node's agent advertised (NodeFacts.capabilities), or
   * null while it is offline. Check before offering a feature in the UI.
   */
  capabilities(nodeId: string): ReadonlySet<string> | null;
  /** True when the node is online and advertised the method's capability. */
  supports(nodeId: string, method: AgentMethodName): boolean;

  /** Unary call. Rejects with an OpError: offline, capability, timeout, cancelled or the agent's status (calls.ts). */
  call<M extends UnaryMethodName>(nodeId: string, method: M, request: AgentRequest<M>, options?: CallOptions): Promise<AgentResponse<M>>;
  /**
   * Streaming call. Throws an OpError right away when the node is offline or
   * lacks the capability; later failures reject `done` and the iterator.
   */
  open<M extends StreamingMethodName>(nodeId: string, method: M, request: AgentRequest<M>, options?: StreamOptions): AgentStream<M>;
  /** Raw byte call (files, volume transfer, tunnels). Same error rules as open(). */
  openRaw<M extends RawMethodName>(nodeId: string, method: M, request: AgentRequest<M>, options?: StreamOptions): RawAgentStream<M>;

  /** Every event of every node. Returns an unsubscribe function. */
  onEvent(listener: AgentEventListener): () => void;
  /** Events of one payload kind, already unwrapped. Subscribe in a module's start(). */
  onEvent<K extends AgentEventKind>(kind: K, listener: AgentEventKindListener<K>): () => void;
  /** A node connected (true) or disconnected (false). */
  onConnection(listener: AgentConnectionListener): () => void;
  /** Crash reports, once per crash (deduped by outbox id), after they are stored. */
  onCrash(listener: AgentCrashListener): () => void;

  /** In-memory actual state of every node (node-state.ts). */
  readonly state: NodeStateStore;
  /** Desired-state dirty queue (../desired/dirty.ts). */
  readonly desired: DesiredStateSync;
}

export function createAgentHub(onError: (error: unknown) => void): AgentHub {
  const agents = new Map<string, ConnectedAgent>();
  const listeners = new Set<AgentEventListener>();
  const kindListeners = new Map<AgentEventKind, Set<AgentEventKindListener<AgentEventKind>>>();
  const connectionListeners = new Set<AgentConnectionListener>();
  const crashListeners = new Set<AgentCrashListener>();
  let panelService: PanelServiceHandlers | null = null;
  let versionPolicy: () => string | null = () => null;
  let serviceScope: ((nodeId: string) => ReadonlySet<string>) | null = null;
  /** Nodes with a GetStateSnapshot in flight, and whether another one is wanted after it. */
  const resyncing = new Map<string, { again: boolean }>();
  const dropLogged = new Set<string>();

  const scopeOf = (nodeId: string): ReadonlySet<string> | null => {
    if (!serviceScope) return null;
    try {
      return serviceScope(nodeId);
    } catch (error) {
      onError(error);
      return null;
    }
  };
  /**
   * Scopes for best-effort events, cached: the scope costs two queries and a
   * node may send hundreds of events a second. A service missing from a
   * cached scope is looked up again once the entry is scopeRecheckMs old,
   * so a new placement counts within that time. Durable reports and
   * snapshots always use a fresh scope.
   */
  const scopeCache = new Map<string, { at: number; scope: ReadonlySet<string> | null }>();
  const cachedScopeOf = (nodeId: string, wanted: readonly string[]): ReadonlySet<string> | null => {
    const now = performance.now();
    const hit = scopeCache.get(nodeId);
    const fresh = hit && now - hit.at < scopeCacheMs;
    const complete = hit?.scope ? wanted.every((id) => hit.scope?.has(id)) : true;
    if (hit && fresh && (complete || now - hit.at < scopeRecheckMs)) return hit.scope;
    const scope = scopeOf(nodeId);
    if (scopeCache.size > 10_000) scopeCache.clear();
    scopeCache.set(nodeId, { at: now, scope });
    return scope;
  };
  const dropped = (nodeId: string, serviceId: string, what: string) => {
    const key = `${nodeId}|${serviceId}`;
    if (dropLogged.has(key)) return;
    if (dropLogged.size > 10_000) dropLogged.clear();
    dropLogged.add(key);
    onError(new Error(`node ${nodeId} reported ${what} for service ${serviceId}, which does not run there; dropped`));
  };

  /**
   * The event with only what the node may say: null when it is about a
   * service the node does not run; metrics keep the node's own services.
   */
  const scoped = (nodeId: string, event: Event, durable: boolean): Event | null => {
    const payload = event.payload;
    const single =
      payload.case === "deployProgress" || payload.case === "healthChanged" || payload.case === "cronRun"
        ? payload.value.serviceId
        : payload.case === "stateDelta" && payload.value.change.case === "serviceUpdated"
          ? payload.value.change.value.serviceId
          : null;
    const wanted = single !== null ? [single] : payload.case === "metrics" ? payload.value.services.map((s) => s.serviceId) : [];
    const scope = wanted.length === 0 ? null : durable ? scopeOf(nodeId) : cachedScopeOf(nodeId, wanted);
    if (single !== null) {
      if (!scope || scope.has(single)) return event;
      dropped(nodeId, single, payload.case ?? "an event");
      return null;
    }
    if (payload.case === "metrics") {
      // One entry per service the node runs: repeats would each keep a live point.
      const seen = new Set<string>();
      const kept = payload.value.services.filter((s) => {
        if (seen.has(s.serviceId) || seen.size >= maxMetricsServices || (scope && !scope.has(s.serviceId))) return false;
        seen.add(s.serviceId);
        return true;
      });
      if (kept.length === payload.value.services.length) return event;
      return { ...event, payload: { case: "metrics", value: { ...payload.value, services: kept } } } as Event;
    }
    return event;
  };
  const state = createNodeStateStore(onError);
  const desired = createDesiredStateSync();

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      onError(error);
    }
  };

  const connected = (nodeId: string, method: AgentMethodName): ConnectedAgent => {
    const agent = agents.get(nodeId);
    if (!agent) throw nodeOffline(nodeId);
    if (!state.get(nodeId)?.capabilities.has(methodCapability(method))) throw missingCapability(nodeId, method);
    return agent;
  };

  const hub: AgentHub = {
    register(agent) {
      if (agents.has(agent.nodeId)) return false;
      agents.set(agent.nodeId, agent);
      if (agent.facts) state.setFacts(agent.nodeId, agent.facts);
      state.setOnline(agent.nodeId, true);
      for (const listener of connectionListeners) safely(() => listener(agent.nodeId, true));
      // After the session finished the handshake (it sends HelloAccepted right after register returns).
      queueMicrotask(() => resync(agent.nodeId));
      return true;
    },
    unregister(agent) {
      // Only the session that registered may remove itself, so a rejected
      // duplicate closing does not drop the live one.
      if (agents.get(agent.nodeId)?.sessionId !== agent.sessionId) return;
      agents.delete(agent.nodeId);
      state.setOnline(agent.nodeId, false);
      for (const listener of connectionListeners) safely(() => listener(agent.nodeId, false));
    },
    emitEvent(nodeId, original, meta = { durable: false, outboxId: null }) {
      const event = scoped(nodeId, original, meta.durable);
      if (!event) return;
      safely(() => track(nodeId, event));
      for (const listener of listeners) safely(() => listener(nodeId, event, meta));
      const kind = event.payload.case;
      if (!kind) return;
      for (const listener of kindListeners.get(kind) ?? []) safely(() => listener(nodeId, event.payload.value as never, event, meta));
    },
    emitCrash(nodeId, report, meta) {
      for (const listener of crashListeners) safely(() => listener(nodeId, report, meta));
    },
    forgetNode(nodeId, reason) {
      agents.get(nodeId)?.close(reason);
      state.forget(nodeId);
    },
    reconnect(nodeId, reason) {
      agents.get(nodeId)?.close(reason);
    },
    dialedHost(nodeId) {
      return agents.get(nodeId)?.host ?? null;
    },
    dialedAddress(nodeId) {
      return agents.get(nodeId)?.address ?? null;
    },

    get panelService() {
      return panelService;
    },
    attachPanelService(handlers) {
      panelService = handlers;
    },
    minimumAgentVersion: () => {
      try {
        return versionPolicy();
      } catch (error) {
        onError(error);
        return null;
      }
    },
    setAgentVersionPolicy(policy) {
      versionPolicy = policy;
    },
    setServiceScope(scope) {
      serviceScope = scope;
    },
    mayReport(nodeId, serviceId) {
      const scope = scopeOf(nodeId);
      return !scope || scope.has(serviceId);
    },

    isOnline: (nodeId) => agents.has(nodeId),
    onlineNodeIds: () => [...agents.keys()],
    capabilities: (nodeId) => (agents.has(nodeId) ? (state.get(nodeId)?.capabilities ?? new Set()) : null),
    supports: (nodeId, method) => agents.has(nodeId) && (state.get(nodeId)?.capabilities.has(methodCapability(method)) ?? false),

    async call(nodeId, method, request, options = {}) {
      const agent = connected(nodeId, method);
      const desc = agentMethod(method);
      const bytes = toBinary(desc.input, create(desc.input, request as never));
      const response = await agent.transport.call(wireMethodName(method), bytes, {
        ...options,
        timeoutMs: options.timeoutMs ?? defaultCallTimeoutMs,
        method,
      });
      return fromBinary(desc.output, response) as AgentResponse<typeof method>;
    },
    open(nodeId, method, request, options = {}) {
      if (!isStreamingMethod(method)) throw new OpError("INTERNAL", `${method} is not a streaming method; use call().`);
      const agent = connected(nodeId, method);
      const desc = agentMethod(method);
      const bytes = toBinary(desc.input, create(desc.input, request as never));
      const opened = agent.transport.open(wireMethodName(method), bytes, { ...options, method });
      return messageStream(nodeId, method, opened);
    },
    openRaw(nodeId, method, request, options = {}) {
      if (!isRawMethod(method)) throw new OpError("INTERNAL", `${method} is not a raw method.`);
      const agent = connected(nodeId, method);
      const desc = agentMethod(method);
      const bytes = toBinary(desc.input, create(desc.input, request as never));
      const opened = agent.transport.open(wireMethodName(method), bytes, { ...options, method });
      return rawStream(nodeId, method, opened);
    },

    onEvent(kindOrListener: AgentEventKind | AgentEventListener, maybeListener?: AgentEventKindListener<AgentEventKind>) {
      if (typeof kindOrListener === "function") {
        listeners.add(kindOrListener);
        return () => listeners.delete(kindOrListener);
      }
      const set = kindListeners.get(kindOrListener) ?? new Set();
      kindListeners.set(kindOrListener, set);
      const listener = maybeListener as AgentEventKindListener<AgentEventKind>;
      set.add(listener);
      return () => set.delete(listener);
    },
    onConnection(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    onCrash(listener) {
      crashListeners.add(listener);
      return () => crashListeners.delete(listener);
    },

    state,
    desired,
  };

  /** Keeps the state store current from events. */
  function track(nodeId: string, event: Event) {
    switch (event.payload.case) {
      case "stateDelta":
        if (state.applyDelta(nodeId, event.payload.value) === "resync") resync(nodeId);
        return;
      case "healthChanged":
        state.applyHealth(nodeId, event.payload.value);
        return;
      case "metrics":
        state.setMetrics(nodeId, event.payload.value);
        return;
      case "nodeFacts":
        state.setFacts(nodeId, event.payload.value);
        return;
      default:
        return;
    }
  }

  /**
   * Fetches a fresh snapshot; agents without state sync are left unsynced.
   * One call per node at a time: deltas that arrive while it is in flight ask
   * for at most one more, instead of one snapshot each.
   */
  function resync(nodeId: string) {
    if (!hub.supports(nodeId, "getStateSnapshot")) return;
    const running = resyncing.get(nodeId);
    if (running) {
      running.again = true;
      return;
    }
    const entry = { again: false };
    resyncing.set(nodeId, entry);
    hub
      .call(nodeId, "getStateSnapshot", {})
      .then(
        (res) => {
          if (!res.snapshot) return;
          const scope = scopeOf(nodeId);
          const snapshot = scope
            ? { ...res.snapshot, services: res.snapshot.services.filter((s) => scope.has(s.serviceId)) }
            : res.snapshot;
          state.applySnapshot(nodeId, snapshot as typeof res.snapshot);
        },
        (error) => {
          if (!(error instanceof OpError && error.details?.reason === "offline")) onError(error);
        },
      )
      .finally(() => {
        resyncing.delete(nodeId);
        if (entry.again && hub.isOnline(nodeId)) resync(nodeId);
      });
  }

  return hub;
}
