// Test fixtures: projects, nodes and services written straight to
// the database, and a fake agent registered on the hub that answers unary
// calls with handlers the test provides and records every request.

import { create, fromBinary, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { NodeFactsSchema, type StateSnapshot, StateSnapshotSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { type AgentMethodName, agentMethod, methodCapability } from "../src/agent-hub/calls";
import type { ConnectedAgent } from "../src/agent-hub/hub";
import { deployments, nodes, projects, servicePlacements, services } from "../src/db/schema";
import type { Panel } from "../src/panel";

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export function seedProject(panel: Panel, name = `proj-${unique()}`) {
  return panel.deps.db.insert(projects).values({ name, nameKey: name.toLowerCase() }).returning().get();
}

export function seedNode(
  panel: Panel,
  options: { name?: string; ipv4?: string | null; ipv6?: string | null; wildcard?: string | null } = {},
) {
  return panel.deps.db
    .insert(nodes)
    .values({
      name: options.name ?? `node-${unique()}`,
      publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
      publicIpv4: options.ipv4 === undefined ? "203.0.113.10" : options.ipv4,
      publicIpv6: options.ipv6 ?? null,
      wildcardDomain: options.wildcard === undefined ? "n1.example.com" : options.wildcard,
    })
    .returning()
    .get();
}

export function seedService(
  panel: Panel,
  options: {
    projectId: string;
    name: string;
    kind?: (typeof services.$inferInsert)["kind"];
    ports?: number[];
    nodeIds?: string[];
    /** A live deployment of nginx:1.27, so the nodes get the service (and its domains' routes). */
    deployed?: boolean;
  },
) {
  const row = panel.deps.db
    .insert(services)
    .values({
      projectId: options.projectId,
      name: options.name,
      nameKey: options.name,
      kind: options.kind ?? "app",
      spec: {
        source: { type: "image", image: "nginx:1.27", registryId: null },
        ports: (options.ports ?? [3000]).map((p) => ({ containerPort: p, protocol: "tcp" })),
      },
    })
    .returning()
    .get();
  for (const nodeId of options.nodeIds ?? []) panel.deps.db.insert(servicePlacements).values({ serviceId: row.id, nodeId }).run();
  if (options.deployed) return seedLiveDeployment(panel, row.id);
  return row;
}

/** A live deployment of the service, its target: its nodes get it and its domains' routes. */
export function seedLiveDeployment(panel: Panel, serviceId: string) {
  const deployment = panel.deps.db
    .insert(deployments)
    .values({ serviceId, generation: 1, status: "live", trigger: "manual", imageRef: "nginx:1.27", finishedAt: new Date() })
    .returning()
    .get();
  return panel.deps.db
    .update(services)
    .set({ targetDeploymentId: deployment.id, liveDeploymentId: deployment.id, generation: 1 })
    .where(eq(services.id, serviceId))
    .returning()
    .get();
}

/** Handlers get the decoded request message and return a response init object (or nothing). */
export type FakeHandlers = Partial<Record<AgentMethodName, (request: any) => unknown>>;

export interface FakeAgent {
  nodeId: string;
  calls: { method: string; request: unknown }[];
  disconnect(): void;
  /** Feeds a state snapshot into the panel's node state, as if the agent sent it. */
  snapshot(init: MessageInitShape<typeof StateSnapshotSchema>): StateSnapshot;
}

/**
 * Registers a connected agent for nodeId; methods without a handler answer an
 * empty response. features are capabilities without methods it advertises
 * too (database.engines.v2).
 */
export function fakeAgent(
  panel: Panel,
  nodeId: string,
  handlers: FakeHandlers = {},
  methods: AgentMethodName[] = [],
  features: string[] = [],
): FakeAgent {
  const calls: FakeAgent["calls"] = [];
  const names = [...new Set([...methods, ...(Object.keys(handlers) as AgentMethodName[])])];
  const capabilities = [...new Set([...names.map((m) => methodCapability(m)), ...features])];
  const sessionId = unique();
  const agent = {
    nodeId,
    sessionId,
    facts: create(NodeFactsSchema, { hostname: "fake", capabilities }),
    transport: {
      async call(_wire: string, bytes: Uint8Array, options: { method: AgentMethodName }) {
        const method = options.method;
        const desc = agentMethod(method);
        const request = fromBinary(desc.input, bytes);
        calls.push({ method, request });
        const handler = handlers[method];
        const response = handler ? await handler(request as never) : {};
        return toBinary(desc.output, create(desc.output, response as never));
      },
      open() {
        throw new Error("this fake agent answers unary calls only");
      },
    },
    close() {},
  } as unknown as ConnectedAgent;
  if (!panel.deps.agents.register(agent)) throw new Error("node already connected");
  return {
    nodeId,
    calls,
    disconnect: () => panel.deps.agents.unregister(agent),
    snapshot(init) {
      const snap = create(StateSnapshotSchema, init);
      panel.deps.agents.state.applySnapshot(nodeId, snap);
      return snap;
    },
  };
}

/**
 * Waits until deploys queued by databases.create or boxes.create settled,
 * including the deployments module's debounced live publish (400 ms), so
 * nothing touches the database after the test closed it.
 */
export async function settleDeploys(panel: Panel): Promise<void> {
  const { engineFor } = await import("../src/modules/deployments/engine");
  await engineFor(panel.deps).idle();
  await Bun.sleep(450);
}
