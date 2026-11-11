import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  AgentService,
  EventSchema,
  HealthState,
  ServiceStatusSchema,
  StateDeltaSchema,
  StateSnapshotSchema,
  StatusCode,
  StreamMode,
} from "@seylo/proto";
import { agentStatusError, methodCapability, methodStreamMode, type RawMethodName } from "../src/agent-hub/calls";
import { createAgentHub } from "../src/agent-hub/hub";
import { createNodeStateStore } from "../src/agent-hub/node-state";
import { createDesiredStateSync } from "../src/desired/dirty";

const svc = (id: string, containerId = "c1") =>
  create(ServiceStatusSchema, { serviceId: id, instances: [{ containerId, health: HealthState.HEALTHY }] });

describe("method metadata", () => {
  test("the raw method list matches the stream_mode options in the proto", () => {
    const raw: RawMethodName[] = [
      "fsRead",
      "exportVolume",
      "exportRegistry",
      "fsWrite",
      "uploadBuildContext",
      "importVolume",
      "importPanelData",
      "importRegistry",
      "tunnel",
    ];
    const fromProto = Object.keys(AgentService.method)
      .filter((name) => methodStreamMode(name as never) !== StreamMode.UNSPECIFIED)
      .sort();
    expect(fromProto).toEqual([...raw].sort());
  });

  test("every method has a capability", () => {
    for (const name of Object.keys(AgentService.method)) expect(methodCapability(name as never)).toMatch(/^[a-z-]+\.[a-z.-]+\.v\d+$/);
  });

  test("agent statuses map to op error codes; internal errors hide the agent's message", () => {
    expect(agentStatusError("n", { code: StatusCode.INVALID_ARGUMENT, message: "bad path", details: {} })).toMatchObject({
      code: "BAD_REQUEST",
      message: "bad path",
    });
    const internal = agentStatusError("n", { code: StatusCode.INTERNAL, message: "open /var/lib/x: EIO", details: {} });
    expect(internal.code).toBe("INTERNAL");
    expect(internal.message).not.toContain("/var/lib");
    expect(internal.details?.agentStatus).toBe("INTERNAL");
  });
});

describe("node state store", () => {
  test("snapshot then in-order deltas apply; gaps and new epochs ask for a resync", () => {
    const store = createNodeStateStore();
    const changes: string[] = [];
    store.onChange((_nodeId, change) => changes.push(change.kind));
    store.setOnline("n1", true);
    expect(store.applyDelta("n1", create(StateDeltaSchema, { epoch: 1n, seq: 1n }))).toBe("resync");

    store.applySnapshot("n1", create(StateSnapshotSchema, { epoch: 1n, seq: 10n, services: [svc("a")] }));
    expect(store.get("n1")?.synced).toBe(true);
    const updated = create(StateDeltaSchema, { epoch: 1n, seq: 11n, change: { case: "serviceUpdated", value: svc("b") } });
    expect(store.applyDelta("n1", updated)).toBe("applied");
    expect(store.applyDelta("n1", updated)).toBe("stale");
    expect(store.applyDelta("n1", create(StateDeltaSchema, { epoch: 1n, seq: 12n, change: { case: "serviceRemoved", value: "a" } }))).toBe(
      "applied",
    );
    expect([...(store.get("n1")?.services.keys() ?? [])]).toEqual(["b"]);
    expect(store.applyDelta("n1", create(StateDeltaSchema, { epoch: 1n, seq: 14n }))).toBe("resync");
    expect(store.get("n1")?.synced).toBe(false);
    expect(store.applyDelta("n1", create(StateDeltaSchema, { epoch: 2n, seq: 1n }))).toBe("resync");
    expect(changes).toEqual(["online", "snapshot", "service", "service"]);
  });

  test("health changes and metrics update the view; usage is found per service", () => {
    const store = createNodeStateStore();
    store.applySnapshot("n1", create(StateSnapshotSchema, { epoch: 1n, services: [svc("a")] }));
    store.applyHealth("n1", { serviceId: "a", containerId: "c1", current: HealthState.UNHEALTHY } as never);
    expect(store.serviceStatuses("a")[0]?.status.instances[0]?.health).toBe(HealthState.UNHEALTHY);
    store.setMetrics("n1", { services: [{ serviceId: "a", cpuPercent: 4, memoryUsedBytes: 100n }] } as never);
    expect(store.serviceUsage("a")).toMatchObject([{ nodeId: "n1", usage: { cpuPercent: 4 } }]);
    store.setOnline("n1", false);
    // Last usage stays visible while offline; services are stale until the next snapshot.
    expect(store.latestMetrics("n1")).not.toBeNull();
    expect(store.get("n1")?.synced).toBe(false);
  });
});

describe("hub events", () => {
  test("listeners by kind get the unwrapped payload and the store follows events", () => {
    const errors: unknown[] = [];
    const hub = createAgentHub((error) => errors.push(error));
    const seen: string[] = [];
    hub.onEvent("deployProgress", (nodeId, progress) => seen.push(`${nodeId}:${progress.serviceId}`));
    hub.onEvent("metrics", () => {
      throw new Error("listener bug");
    });
    hub.emitEvent("n1", create(EventSchema, { payload: { case: "deployProgress", value: { serviceId: "a" } } }));
    hub.emitEvent("n1", create(EventSchema, { payload: { case: "metrics", value: { services: [] } } }));
    expect(seen).toEqual(["n1:a"]);
    expect(errors).toHaveLength(1);
    expect(hub.state.latestMetrics("n1")).not.toBeNull();
  });
});

describe("desired dirty queue", () => {
  test("marks coalesce into one wakeup and settled() waits for the flusher", async () => {
    const sync = createDesiredStateSync();
    await sync.settled();
    let wakeups = 0;
    sync.onDirty(() => wakeups++);
    sync.markDirty({ serviceId: "a" });
    sync.markDirty({ nodeId: "n1" });
    let settled = false;
    const waiting = sync.settled().then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    expect(wakeups).toBe(1);
    expect(sync.takeDirty()).toEqual([{ serviceId: "a" }, { nodeId: "n1" }]);
    expect(settled).toBe(false);
    sync.markSettled();
    await waiting;
    expect(settled).toBe(true);
  });
});

describe("node ops behind the pipeline", () => {
  test("nodes.list answers signed-in owners and refuses anonymous callers", async () => {
    const { testPanel, createUser, sessionHeaders } = await import("./helpers");
    const panel = testPanel();
    try {
      const owner = await createUser(panel, "owner");
      const response = await panel.app.handle(new Request("http://localhost/api/v1/nodes.list", { headers: sessionHeaders(owner.cookie) }));
      expect(response.status).toBe(200);
      expect(((await response.json()) as { nodes: unknown[] }).nodes).toEqual([]);
      const anonymous = await panel.app.handle(new Request("http://localhost/api/v1/nodes.list"));
      expect(anonymous.status).toBe(401);
    } finally {
      panel.close();
    }
  });
});
