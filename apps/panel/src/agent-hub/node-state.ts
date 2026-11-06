// The panel's in-memory copy of each node's actual state, so reads need no
// round trip to the node (state.proto). Fed by the hub: a snapshot after
// every connect (GetStateSnapshot), then StateDelta, HealthChanged,
// MetricsReport and NodeFacts events. Nothing here is persisted; after a
// panel restart the next snapshot rebuilds it.
//
// Readers (any module, through deps.agents.state): get(nodeId),
// serviceStatuses(serviceId), latestMetrics(nodeId), serviceUsage(serviceId),
// onChange(listener). The write methods are for the hub only.

import type { HealthChanged, MetricsReport, NodeFacts, ServiceStatus, ServiceUsage, StateDelta, StateSnapshot } from "@seylo/proto";

export interface NodeStateView {
  readonly nodeId: string;
  readonly online: boolean;
  /** When the current session started; null while offline. */
  readonly connectedAt: Date | null;
  /** Last facts from the hello, GetNodeFacts or a NodeFacts event; survives disconnects. */
  readonly facts: NodeFacts | null;
  /** Capabilities from facts; empty while unknown. */
  readonly capabilities: ReadonlySet<string>;
  /** False until the first snapshot of this session arrived; services are stale until then. */
  readonly synced: boolean;
  readonly epoch: bigint;
  readonly seq: bigint;
  /** Desired-state revision the agent has fully applied. */
  readonly appliedRevision: bigint;
  /** Services on this node by service id. */
  readonly services: ReadonlyMap<string, ServiceStatus>;
  /** Last metrics sample (about every 10 s); kept after a disconnect so graphs show the last value. */
  readonly latestMetrics: MetricsReport | null;
}

export type NodeStateChange =
  | { kind: "online"; online: boolean }
  | { kind: "facts" }
  | { kind: "snapshot" }
  | { kind: "service"; serviceId: string; removed: boolean }
  | { kind: "applied"; revision: bigint }
  | { kind: "metrics" };

export type NodeStateListener = (nodeId: string, change: NodeStateChange) => void;

/** What applyDelta tells the hub: "resync" means fetch a new snapshot (epoch changed or a seq gap). */
export type DeltaResult = "applied" | "stale" | "resync";

export interface NodeStateStore {
  get(nodeId: string): NodeStateView | null;
  /** Every node the store knows (online or seen this process). */
  all(): NodeStateView[];
  /** The service's status on every node that reports it (several when placed on several nodes). */
  serviceStatuses(serviceId: string): { nodeId: string; status: ServiceStatus }[];
  latestMetrics(nodeId: string): MetricsReport | null;
  /** The service's latest usage on every node, from each node's latest metrics sample. */
  serviceUsage(serviceId: string): { nodeId: string; at: Date | null; usage: ServiceUsage }[];
  /** Called after every change; returns an unsubscribe function. Listeners must be cheap. */
  onChange(listener: NodeStateListener): () => void;

  // Hub only.
  setOnline(nodeId: string, online: boolean, at?: Date): void;
  setFacts(nodeId: string, facts: NodeFacts): void;
  applySnapshot(nodeId: string, snapshot: StateSnapshot): void;
  applyDelta(nodeId: string, delta: StateDelta): DeltaResult;
  applyHealth(nodeId: string, change: HealthChanged): void;
  setMetrics(nodeId: string, report: MetricsReport): void;
  /** The node was removed from the panel. */
  forget(nodeId: string): void;
}

interface MutableNode {
  nodeId: string;
  online: boolean;
  connectedAt: Date | null;
  facts: NodeFacts | null;
  capabilities: Set<string>;
  synced: boolean;
  epoch: bigint;
  seq: bigint;
  appliedRevision: bigint;
  services: Map<string, ServiceStatus>;
  latestMetrics: MetricsReport | null;
}

export function createNodeStateStore(onError: (error: unknown) => void = () => {}): NodeStateStore {
  const nodes = new Map<string, MutableNode>();
  const listeners = new Set<NodeStateListener>();

  const node = (nodeId: string): MutableNode => {
    let n = nodes.get(nodeId);
    if (!n) {
      n = {
        nodeId,
        online: false,
        connectedAt: null,
        facts: null,
        capabilities: new Set(),
        synced: false,
        epoch: 0n,
        seq: 0n,
        appliedRevision: 0n,
        services: new Map(),
        latestMetrics: null,
      };
      nodes.set(nodeId, n);
    }
    return n;
  };

  const emit = (nodeId: string, change: NodeStateChange) => {
    for (const listener of listeners) {
      try {
        listener(nodeId, change);
      } catch (error) {
        onError(error);
      }
    }
  };

  return {
    get: (nodeId) => nodes.get(nodeId) ?? null,
    all: () => [...nodes.values()],
    serviceStatuses(serviceId) {
      const out: { nodeId: string; status: ServiceStatus }[] = [];
      for (const n of nodes.values()) {
        const status = n.services.get(serviceId);
        if (status) out.push({ nodeId: n.nodeId, status });
      }
      return out;
    },
    latestMetrics: (nodeId) => nodes.get(nodeId)?.latestMetrics ?? null,
    serviceUsage(serviceId) {
      const out: { nodeId: string; at: Date | null; usage: ServiceUsage }[] = [];
      for (const n of nodes.values()) {
        const report = n.latestMetrics;
        const usage = report?.services.find((s) => s.serviceId === serviceId);
        if (report && usage) out.push({ nodeId: n.nodeId, at: report.time ? timestampDate(report.time) : null, usage });
      }
      return out;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setOnline(nodeId, online, at = new Date()) {
      const n = node(nodeId);
      n.online = online;
      n.connectedAt = online ? at : null;
      // A new session must send a new snapshot before its services count.
      n.synced = false;
      emit(nodeId, { kind: "online", online });
    },
    setFacts(nodeId, facts) {
      const n = node(nodeId);
      n.facts = facts;
      n.capabilities = new Set(facts.capabilities);
      emit(nodeId, { kind: "facts" });
    },
    applySnapshot(nodeId, snapshot) {
      const n = node(nodeId);
      n.epoch = snapshot.epoch;
      n.seq = snapshot.seq;
      n.appliedRevision = snapshot.appliedRevision;
      n.services = new Map(snapshot.services.map((s) => [s.serviceId, s]));
      n.synced = true;
      emit(nodeId, { kind: "snapshot" });
    },
    applyDelta(nodeId, delta) {
      const n = node(nodeId);
      if (!n.synced || delta.epoch !== n.epoch) return "resync";
      if (delta.seq <= n.seq) return "stale";
      if (delta.seq !== n.seq + 1n) {
        n.synced = false;
        return "resync";
      }
      n.seq = delta.seq;
      switch (delta.change.case) {
        case "serviceUpdated":
          n.services.set(delta.change.value.serviceId, delta.change.value);
          emit(nodeId, { kind: "service", serviceId: delta.change.value.serviceId, removed: false });
          break;
        case "serviceRemoved":
          n.services.delete(delta.change.value);
          emit(nodeId, { kind: "service", serviceId: delta.change.value, removed: true });
          break;
        case "appliedRevision":
          n.appliedRevision = delta.change.value;
          emit(nodeId, { kind: "applied", revision: delta.change.value });
          break;
        default:
          // A change kind this panel does not know yet (newer agent): the seq still counts.
          break;
      }
      return "applied";
    },
    applyHealth(nodeId, change) {
      const status = nodes.get(nodeId)?.services.get(change.serviceId);
      const instance = status?.instances.find((i) => i.containerId === change.containerId);
      if (!instance) return;
      instance.health = change.current;
      emit(nodeId, { kind: "service", serviceId: change.serviceId, removed: false });
    },
    setMetrics(nodeId, report) {
      node(nodeId).latestMetrics = report;
      emit(nodeId, { kind: "metrics" });
    },
    forget(nodeId) {
      nodes.delete(nodeId);
    },
  };
}

function timestampDate(t: { seconds: bigint; nanos: number }): Date {
  return new Date(Number(t.seconds) * 1000 + Math.floor(t.nanos / 1e6));
}
