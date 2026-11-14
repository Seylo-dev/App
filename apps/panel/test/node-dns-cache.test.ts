// The node DNS cache (0.2.17): nodes.setDnsCache (permission, audit, the
// capability gate for older agents, the desired state) and
// nodes.dnsCacheStatus over the agent's GetDnsCacheStatus.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { nodes as nodeOps } from "@seylo/ops";
import { DnsCacheState } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { auditLog, nodes } from "../src/db/schema";
import { upstreamPerMinute } from "../src/modules/nodes/dns-cache";
import { allCapabilities, type FakeAgent } from "./fake-agent";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen, seedProject, seedService } from "./hub-helpers";

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
const agents: FakeAgent[] = [];

beforeEach(async () => {
  panel = testPanel();
  url = listen(panel);
  owner = await createUser(panel, "owner");
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

async function join(options: Parameters<typeof joinAgent>[2] = {}) {
  const agent = await joinAgent(panel, url, options);
  agents.push(agent);
  return agent;
}

describe("nodes.setDnsCache", () => {
  test("turns the cache on, reaches the agent in its settings and is audited", async () => {
    const agent = await join();
    const before = await callOp(panel, nodeOps.get, { nodeId: agent.nodeId }, { cookie: owner.cookie });
    expect(before.body).toMatchObject({ dnsCache: false, dnsCacheSupported: true });

    const syncs = agent.requests("SyncDesired").length;
    const res = await callOp(panel, nodeOps.setDnsCache, { nodeId: agent.nodeId, enabled: true }, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: agent.nodeId, dnsCache: true });
    await panel.deps.agents.desired.settled();
    const sent = await agent.waitFor("SyncDesired", syncs + 1);
    expect(sent.at(-1).state.settings.dnsCache).toMatchObject({ enabled: true });

    const audited = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "nodes.setDnsCache")).all();
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actorId: owner.user.id, input: { nodeId: agent.nodeId, enabled: true } });

    // Off again: the next desired state says so.
    await callOp(panel, nodeOps.setDnsCache, { nodeId: agent.nodeId, enabled: false }, { cookie: owner.cookie });
    await panel.deps.agents.desired.settled();
    const off = await agent.waitFor("SyncDesired", syncs + 2);
    expect(off.at(-1).state.settings.dnsCache?.enabled ?? false).toBe(false);
  });

  test("an agent before 0.2.17 cannot turn it on; turning it off always works", async () => {
    const old = await join({ capabilities: allCapabilities.filter((c) => c !== nodeOps.dnsCacheCapability) });
    const detail = await callOp(panel, nodeOps.get, { nodeId: old.nodeId }, { cookie: owner.cookie });
    expect(detail.body.dnsCacheSupported).toBe(false);

    const refused = await callOp(panel, nodeOps.setDnsCache, { nodeId: old.nodeId, enabled: true }, { cookie: owner.cookie });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("agentTooOld");
    expect(JSON.stringify(refused.body)).toContain("0.2.17");
    expect(panel.deps.db.select({ on: nodes.dnsCache }).from(nodes).where(eq(nodes.id, old.nodeId)).get()?.on).toBe(false);

    const off = await callOp(panel, nodeOps.setDnsCache, { nodeId: old.nodeId, enabled: false }, { cookie: owner.cookie });
    expect(off.status).toBe(200);

    // The status of such a node is unknown, and the agent is not asked.
    const status = await callOp(panel, nodeOps.dnsCacheStatus, { nodeId: old.nodeId }, { cookie: owner.cookie });
    expect(status.body).toMatchObject({ supported: false, online: true, state: "unknown", containers: [] });
    expect(old.requests("GetDnsCacheStatus")).toHaveLength(0);
  });

  test("members without nodes.manage are refused, viewers without nodes.view too", async () => {
    const agent = await join();
    const member = await createUser(panel, "member");
    expect((await callOp(panel, nodeOps.setDnsCache, { nodeId: agent.nodeId, enabled: true }, { cookie: member.cookie })).status).toBe(403);
    expect((await callOp(panel, nodeOps.dnsCacheStatus, { nodeId: agent.nodeId }, { cookie: member.cookie })).status).toBe(403);
    expect(panel.deps.db.select({ on: nodes.dnsCache }).from(nodes).where(eq(nodes.id, agent.nodeId)).get()?.on).toBe(false);
  });
});

describe("nodes.dnsCacheStatus", () => {
  test("reads the agent's status with service names, hit rate and upstream questions per minute", async () => {
    const agent = await join();
    const project = seedProject(panel);
    const web = seedService(panel, project.id, agent.nodeId, { name: "web" });
    const minutes = Array.from({ length: 60 }, (_, i) => ({ queries: 20, upstream: i === 59 ? 50 : 2 }));
    agent.handle("GetDnsCacheStatus", () => ({
      state: DnsCacheState.BLOCKED,
      reason: "a test container on seylo-p-0123456789abcdef gets no answer from it",
      fixHint: 'With ufw: `ufw allow to 169.254.53.53 port 53 comment "seylo dns"`.',
      address: "169.254.53.53",
      upstreams: ["8.8.8.8", "1.1.1.1"],
      fallbacks: ["8.8.8.8", "1.1.1.1"],
      entries: 12,
      queriesTotal: 200n,
      hitsTotal: 150n,
      staleTotal: 1n,
      upstreamQueriesTotal: 50n,
      upstreamFailuresTotal: 3n,
      minutes,
      checkedAt: timestampFromDate(new Date("2026-11-14T10:00:00Z")),
      checkPassed: false,
      containers: [
        {
          name: "seylo-web-2",
          serviceId: web.id,
          kind: "service",
          usesCache: true,
          created: timestampFromDate(new Date("2026-11-14T09:00:00Z")),
        },
        { name: "seylo-cron-x", serviceId: "", kind: "cron", usesCache: false },
      ],
    }));
    const res = await callOp(panel, nodeOps.dnsCacheStatus, { nodeId: agent.nodeId }, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "blocked",
      supported: true,
      online: true,
      address: "169.254.53.53",
      hitRate: 0.75,
      upstreamPerMinute: 2,
      queries: 200,
      upstreamFailures: 3,
      checkPassed: false,
      checkedAt: "2026-11-14T10:00:00.000Z",
      fixHint: expect.stringContaining("ufw allow to 169.254.53.53 port 53"),
    });
    expect(res.body.containers).toEqual([
      { name: "seylo-cron-x", serviceId: null, serviceName: null, kind: "cron", usesCache: false, created: null },
      { name: "seylo-web-2", serviceId: web.id, serviceName: "web", kind: "service", usesCache: true, created: "2026-11-14T09:00:00.000Z" },
    ]);
  });

  test("an offline node is unknown", async () => {
    const agent = await join();
    await agent.close();
    await Bun.sleep(50);
    const res = await callOp(panel, nodeOps.dnsCacheStatus, { nodeId: agent.nodeId }, { cookie: owner.cookie });
    expect(res.body).toMatchObject({ online: false, state: "unknown" });
  });

  test("upstream questions per minute leave the running minute out", () => {
    expect(upstreamPerMinute([])).toBe(0);
    expect(upstreamPerMinute([{ upstream: 100 }])).toBe(0);
    expect(upstreamPerMinute([...Array.from({ length: 12 }, () => ({ upstream: 3 })), { upstream: 999 }])).toBe(3);
  });
});
