// Shared setup for the agent hub tests: a listening panel, join tokens, fake
// agents and a few seeded rows (project, service, placement, deployment).

import { eq } from "drizzle-orm";
import { deployments, joinTokens, projects, servicePlacements, services } from "../src/db/schema";
import { panelWebsocket } from "../src/http/ws-guard";
import { flusherFor } from "../src/modules/nodes/index";
import { hashToken } from "../src/security/tokens";
import { allCapabilities, FakeAgent, type FakeAgentOptions } from "./fake-agent";
import type { TestPanel } from "./helpers";

export function listen(panel: TestPanel): string {
  panel.app.listen({ hostname: "127.0.0.1", port: 0, websocket: panelWebsocket });
  return `http://127.0.0.1:${panel.app.server?.port}`;
}

/** A join token; canBuild left out is the column default (off), so joined fake agents build only when a test says so. */
export function addJoinToken(panel: TestPanel, token = `tok-${crypto.randomUUID()}`, options: { canBuild?: boolean } = {}): string {
  panel.deps.db
    .insert(joinTokens)
    .values({ tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000), canBuild: options.canBuild })
    .run();
  return token;
}

/** Joins a fake agent (all capabilities unless given) and waits for its first full sync. */
export async function joinAgent(panel: TestPanel, url: string, options: Partial<FakeAgentOptions> = {}): Promise<FakeAgent> {
  const agent = new FakeAgent({
    url,
    panelId: panel.deps.panelId,
    capabilities: allCapabilities,
    ...options,
    token: options.token ?? (options.nodeId ? undefined : addJoinToken(panel)),
  });
  await agent.connect();
  if (agent.rejected) return agent;
  if (agent.requests("SyncDesired").length === 0 && (options.capabilities ?? allCapabilities).includes("state.sync.v1")) {
    await flusherFor(panel.deps)?.flush();
    await agent.waitFor("SyncDesired");
  }
  return agent;
}

export function seedProject(panel: TestPanel, name = `p-${crypto.randomUUID().slice(0, 6)}`) {
  return panel.deps.db.insert(projects).values({ name, nameKey: name }).returning().get();
}

export function seedService(
  panel: TestPanel,
  projectId: string,
  nodeId: string,
  options: { name?: string; kind?: (typeof services.$inferInsert)["kind"]; spec?: unknown; image?: string | null; replicas?: number } = {},
) {
  const name = options.name ?? `svc-${crypto.randomUUID().slice(0, 6)}`;
  const service = panel.deps.db
    .insert(services)
    .values({
      projectId,
      name,
      nameKey: name,
      kind: options.kind ?? "app",
      spec: options.spec ?? { ports: [{ containerPort: 8080, protocol: "tcp" }] },
    })
    .returning()
    .get();
  panel.deps.db
    .insert(servicePlacements)
    .values({ serviceId: service.id, nodeId, replicas: options.replicas ?? 1 })
    .run();
  if (options.image !== null) {
    const deployment = panel.deps.db
      .insert(deployments)
      .values({
        serviceId: service.id,
        generation: 1,
        trigger: "manual",
        status: "live",
        imageRef: options.image ?? "docker.io/library/nginx:1.27",
        imageDigest: "sha256:abc",
      })
      .returning()
      .get();
    // The services module runs a service's target deployment.
    panel.deps.db
      .update(services)
      .set({ targetDeploymentId: deployment.id, liveDeploymentId: deployment.id })
      .where(eq(services.id, service.id))
      .run();
  }
  return service;
}
