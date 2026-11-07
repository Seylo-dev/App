// domains.retryCertificate ("Regenerate certificate"): which nodes are
// asked, and every refusal: permission, API key scope, once a minute per
// domain, DNS not pointing at the node, an agent without the capability,
// domains without a Let's Encrypt certificate to retry. Every call is audited.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { domains as domainOps } from "@seylo/ops";
import { RouteState, StatusCode } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { agentStatusError } from "../src/agent-hub/calls";
import { auditLog, domains } from "../src/db/schema";
import { type DnsLookups, setDnsLookups } from "../src/modules/domains/dns";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { type FakeAgent, fakeAgent, seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
let owner: Awaited<ReturnType<typeof createUser>>;
let agents: FakeAgent[] = [];

beforeEach(async () => {
  panel = testPanel();
  owner = await createUser(panel, "owner");
});
afterEach(() => {
  for (const agent of agents) agent.disconnect();
  agents = [];
  setSystemTime();
  setDnsLookups(null);
  panel.close();
});

/** shop.example.com resolves to `ip` (none: no record). */
function dnsPointsAt(ip: string | null): void {
  const lookups: DnsLookups = {
    resolve4: async (name) => (name === "shop.example.com" && ip ? [ip] : []),
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveNs: async (name) => (name === "example.com" ? ["ns1.registrar.net"] : []),
  };
  setDnsLookups(lookups);
}

const retryHandler = (request: { serviceId: string; routeId: string }) => ({
  status: {
    routeId: request.routeId,
    state: RouteState.CERTIFICATE_PENDING,
    message: "waiting for the Let's Encrypt certificate of shop.example.com",
  },
  hosts: ["shop.example.com"],
});

/** A service on one node with shop.example.com whose certificate failed; the agent supports retries unless `old`. */
async function failedDomain(options: { old?: boolean; handler?: (request: { serviceId: string; routeId: string }) => unknown } = {}) {
  const project = seedProject(panel);
  const node = seedNode(panel, { name: "de-fsn-1", ipv4: "203.0.113.10" });
  const service = seedService(panel, { projectId: project.id, name: "web", ports: [3000], nodeIds: [node.id] });
  dnsPointsAt("203.0.113.10");
  const added = await callOp(panel, domainOps.add, { serviceId: service.id, host: "shop.example.com" }, { cookie: owner.cookie });
  const domainId: string = added.body.domain.id;
  const agent = options.old
    ? fakeAgent(panel, node.id, {}, ["getNodeFacts"])
    : fakeAgent(panel, node.id, { retryCertificate: options.handler ?? retryHandler });
  agents.push(agent);
  agent.snapshot({
    epoch: 1n,
    services: [
      {
        serviceId: service.id,
        routes: [
          {
            routeId: domainId,
            state: RouteState.CERTIFICATE_FAILED,
            message: "shop.example.com: The certificate authority refused the certificate (403): Invalid response: 404",
          },
        ],
      },
    ],
  });
  return { project, node, service, agent, ref: { serviceId: service.id, domainId } };
}

function auditRows() {
  return panel.deps.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.opId, "domains.retryCertificate"))
    .orderBy(auditLog.id)
    .all()
    .map((r) => ({ outcome: r.outcome, errorCode: r.errorCode, targetType: r.targetType, actorId: r.actorId }));
}

describe("domains.retryCertificate", () => {
  test("asks the node again, shows the domain pending and is audited", async () => {
    const { agent, ref, service } = await failedDomain();
    const before = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie: owner.cookie });
    expect(before.body.domains[0].certificate).toMatchObject({ status: "failed", error: expect.stringContaining("Invalid response: 404") });

    const retried = await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ id: ref.domainId, certificate: { status: "pending", error: null } });
    expect(agent.calls.filter((c) => c.method === "retryCertificate").map((c) => c.request)).toEqual([
      expect.objectContaining({ serviceId: ref.serviceId, routeId: ref.domainId }),
    ]);
    const list = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie: owner.cookie });
    expect(list.body.domains[0].certificate.status).toBe("pending");
    expect(auditRows()).toEqual([{ outcome: "ok", errorCode: null, targetType: "service", actorId: owner.user.id }]);

    // A new failure from the node shows again.
    agent.snapshot({
      epoch: 1n,
      seq: 2n,
      services: [{ serviceId: ref.serviceId, routes: [{ routeId: ref.domainId, state: RouteState.CERTIFICATE_FAILED, message: "again" }] }],
    });
    const failedAgain = await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie: owner.cookie });
    expect(failedAgain.body.domains[0].certificate).toMatchObject({ status: "failed", error: "again" });
  });

  test("once a minute per domain", async () => {
    const start = new Date("2026-11-07T10:00:00Z");
    setSystemTime(start);
    const { agent, ref } = await failedDomain();
    expect((await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie })).status).toBe(200);

    setSystemTime(new Date(start.getTime() + 20_000));
    const again = await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie });
    expect(again.status).toBe(429);
    expect(again.body.error).toMatchObject({ code: "RATE_LIMITED", details: { reason: "certificateRetry", retryAfter: "40" } });
    expect(again.body.error.message).toContain("Try again in 40 seconds");

    setSystemTime(new Date(start.getTime() + 61_000));
    expect((await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie })).status).toBe(200);
    expect(agent.calls.filter((c) => c.method === "retryCertificate")).toHaveLength(2);
    expect(auditRows().map((r) => r.errorCode)).toEqual([null, "RATE_LIMITED", null]);
  });

  test("refuses while DNS does not point at the node", async () => {
    const { agent, ref, service } = await failedDomain();
    dnsPointsAt("198.51.100.99");
    const elsewhere = await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.error.details).toMatchObject({ reason: "dnsNotPointing", dnsStatus: "wrongTarget" });
    expect(elsewhere.body.error.message).toContain("shop.example.com points somewhere else");
    expect(elsewhere.body.error.message).toContain("cannot be issued until it points at the node");

    dnsPointsAt(null);
    const missing = await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie });
    expect(missing.status).toBe(409);
    expect(missing.body.error.details.dnsStatus).toBe("missing");
    expect(agent.calls.filter((c) => c.method === "retryCertificate")).toHaveLength(0);
    // The fresh lookup is stored, so the row shows the DNS problem.
    const row = panel.deps.db.select().from(domains).where(eq(domains.serviceId, service.id)).get();
    expect(row?.dnsStatus).toBe("missing");
    // A refusal does not use up the minute.
    dnsPointsAt("203.0.113.10");
    expect((await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie })).status).toBe(200);
    expect(auditRows().map((r) => r.errorCode)).toEqual(["CONFLICT", "CONFLICT", null]);
  });

  test("an agent without the capability: update the node first", async () => {
    const { agent, ref } = await failedDomain({ old: true });
    const res = await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ reason: "agentTooOld" });
    expect(res.body.error.message).toBe("The agent on de-fsn-1 cannot regenerate certificates yet. Update the node first.");
    expect(agent.calls.filter((c) => c.method === "retryCertificate")).toHaveLength(0);
  });

  test("an offline node", async () => {
    const { agent, ref } = await failedDomain();
    agent.disconnect();
    agents = [];
    const res = await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie });
    expect(res.status).toBe(503);
    expect(res.body.error.details.reason).toBe("offline");
  });

  test("the node's own refusal comes through and leaves the domain as it was", async () => {
    let refuse = true;
    const { node, ref } = await failedDomain({
      handler: (request) => {
        if (refuse) {
          throw agentStatusError(node.id, {
            code: StatusCode.NOT_FOUND,
            message: "This node does not route that domain yet. Wait for the deploy to finish and try again.",
            details: {},
          });
        }
        return retryHandler(request);
      },
    });
    const res = await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain("does not route that domain yet");
    expect(panel.deps.db.select().from(domains).where(eq(domains.id, ref.domainId)).get()?.certStatus).toBe("failed");
    // The minute starts only with a retry that happened.
    refuse = false;
    expect((await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie })).status).toBe(200);
  });

  test("only domains with a Let's Encrypt certificate to get", async () => {
    const { ref } = await failedDomain();
    panel.deps.db.update(domains).set({ certStatus: "valid" }).where(eq(domains.id, ref.domainId)).run();
    const valid = await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie });
    expect(valid.status).toBe(409);
    expect(valid.body.error.details.reason).toBe("certificateValid");

    await callOp(panel, domainOps.update, { ...ref, https: "off" }, { cookie: owner.cookie });
    const off = await callOp(panel, domainOps.retryCertificate, ref, { cookie: owner.cookie });
    expect(off.status).toBe(409);
    expect(off.body.error.details.reason).toBe("notAcme");
  });

  test("needs domains.edit on the service, for people and API keys", async () => {
    const { ref } = await failedDomain();
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", ref.serviceId, ["domains.view"]);
    expect((await callOp(panel, domainOps.retryCertificate, ref, { cookie: member.cookie })).status).toBe(403);

    const viewKey = createApiKey(panel, owner.user.id, { actions: ["domains.view"] });
    expect((await callOp(panel, domainOps.retryCertificate, ref, { bearer: viewKey })).status).toBe(403);
    const readOnly = createApiKey(panel, owner.user.id, { actions: ["*"], readOnly: true });
    expect((await callOp(panel, domainOps.retryCertificate, ref, { bearer: readOnly })).status).toBe(403);
    const editKey = createApiKey(panel, owner.user.id, { actions: ["domains.edit"] });
    const byKey = await callOp(panel, domainOps.retryCertificate, ref, { bearer: editKey });
    expect(byKey.status).toBe(200);

    expect(auditRows().map((r) => [r.outcome, r.errorCode])).toEqual([
      ["error", "FORBIDDEN"],
      ["error", "FORBIDDEN"],
      ["error", "FORBIDDEN"],
      ["ok", null],
    ]);
    expect(domainOps.retryCertificate.kind).toBe("mutation");
  });
});
