// Domains that have no route on their service's node (modules/domains/
// no-route.ts). Two custom domains behind Cloudflare's proxy read
// "Certificate waits for DNS" for hours: Cloudflare reached the node, but
// the node had no route for them, since their app had never deployed (its
// builds failed), so the origin check could never pass and the hold never
// ended, while the panel kept checking. domains.list now says why
// (noRoute), the checks wait for a deployment and start again when one
// goes live, compose stacks and cron services take no domains, and a node
// that cannot write a service's route file names its error.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { deployments as deploymentOps, domains as domainOps, projects, services as serviceOps } from "@seylo/ops";
import { DeployStage, RouteState } from "@seylo/proto";
import { and, eq } from "drizzle-orm";
import { deployments, domains, jobs, nodes, services as serviceTable } from "../src/db/schema";
import type { JobContext } from "../src/jobs/queue";
import { type DnsLookups, setDnsLookups } from "../src/modules/domains/dns";
import {
  type OriginFetch,
  originCapability,
  originCheckJobType,
  originPath,
  originSignedBytes,
  setOriginFetch,
} from "../src/modules/domains/origin";
import { recheckJob } from "../src/modules/domains/recheck";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { type FakeAgent, fakeAgent, seedLiveDeployment, seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
let agents: FakeAgent[] = [];

beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
});
afterEach(() => {
  for (const agent of agents) agent.disconnect();
  agents = [];
  setSystemTime();
  setDnsLookups(null);
  setOriginFetch(null);
  panel.close();
});

/** shop.example.com behind Cloudflare's proxy (only Cloudflare's addresses answer). */
const proxied: DnsLookups = {
  resolve4: async (name) => (name.endsWith(".example.com") ? ["104.16.1.1"] : []),
  resolve6: async () => [],
  resolveCname: async () => [],
  resolveNs: async (name) => (name === "example.com" ? ["ada.ns.cloudflare.com"] : []),
};

function nodeKey(): { publicKey: Buffer; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url"), privateKey };
}

/** The node's edge answering the origin check, and every URL it was asked. */
function edge(key: KeyObject): OriginFetch & { urls: string[] } {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const proof = sign(null, originSignedBytes(u.hostname, u.pathname.slice(originPath.length)), key).toString("base64url");
    return new Response(`${proof}\n`, { status: 200, headers: { "content-type": "text/plain" } });
  };
  return Object.assign(fetcher, { urls });
}

/** A service on one node whose agent answers origin checks; `deployed` gives it a live deployment. */
function setup(options: { deployed?: boolean; kind?: "app" | "compose" | "cron" } = {}) {
  const key = nodeKey();
  const project = seedProject(panel);
  const node = seedNode(panel, { name: "node-1", ipv4: "203.0.113.10" });
  panel.deps.db.update(nodes).set({ publicKey: key.publicKey }).where(eq(nodes.id, node.id)).run();
  const service = seedService(panel, {
    projectId: project.id,
    name: "web",
    kind: options.kind,
    ports: [3000],
    nodeIds: [node.id],
    deployed: options.deployed,
  });
  const agent = fakeAgent(panel, node.id, {}, ["getNodeFacts"], [originCapability]);
  agents.push(agent);
  setDnsLookups(proxied);
  const fetcher = edge(key.privateKey);
  setOriginFetch(fetcher);
  const listed = async () =>
    (await callOp(panel, domainOps.list, { serviceId: service.id }, { cookie })).body.domains as {
      id: string;
      host: string;
      origin?: string;
      noRoute?: Record<string, unknown>;
      certificate: { waitingForDns?: boolean };
    }[];
  return { key, node, service, agent, fetcher, listed };
}

const originChecks = () =>
  panel.deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, originCheckJobType), eq(jobs.status, "queued")))
    .all();

describe("a service that has not deployed yet", () => {
  test("its domains say so, and nothing checks them through the node until a deployment goes live", async () => {
    const s = setup();
    const added = await callOp(panel, domainOps.add, { serviceId: s.service.id, host: "shop.example.com" }, { cookie });
    expect(added.status).toBe(200);
    expect(added.body.domain.noRoute).toEqual({ reason: "notDeployed" });
    const domainId: string = added.body.domain.id;
    // No origin check after domains.add: the node has no route that could answer it.
    expect(originChecks()).toHaveLength(0);
    expect(await s.listed()).toMatchObject([
      { host: "shop.example.com", noRoute: { reason: "notDeployed" }, certificate: { waitingForDns: true } },
    ]);

    // Check again looks the record up, but asks nothing through it.
    const checked = await callOp(panel, domainOps.checkDns, { serviceId: s.service.id, domainId }, { cookie });
    expect(checked.body.status).toBe("proxied");
    expect(checked.body.origin).toBeUndefined();
    expect(s.fetcher.urls).toHaveLength(0);

    // The re-check of waiting domains leaves it alone, however long it waits.
    const before = panel.deps.db.select().from(domains).where(eq(domains.id, domainId)).get()?.dnsCheckedAt;
    setSystemTime(new Date(Date.now() + 2 * 86_400_000));
    await recheckJob.run({}, panel.deps as JobContext);
    expect(panel.deps.db.select().from(domains).where(eq(domains.id, domainId)).get()?.dnsCheckedAt).toEqual(before ?? null);
    expect(s.fetcher.urls).toHaveLength(0);

    // Regenerate certificate has nothing to regenerate on the node.
    const retry = await callOp(panel, domainOps.retryCertificate, { serviceId: s.service.id, domainId }, { cookie });
    expect(retry.status).toBe(409);
    expect(retry.body.error.details.reason).toBe("notDeployed");
    expect(retry.body.error.message).toBe(
      "web has not deployed yet: its domains go live, and their certificates are asked for, once a deployment goes live.",
    );

    // Deployed: the re-check takes it up again, the origin check through the node proves it and the certificate starts.
    seedLiveDeployment(panel, s.service.id);
    s.agent.snapshot({
      epoch: 1n,
      services: [{ serviceId: s.service.id, routes: [{ routeId: domainId, state: RouteState.CERTIFICATE_PENDING }] }],
    });
    await recheckJob.run({}, panel.deps as JobContext);
    expect(s.fetcher.urls).toHaveLength(1);
    const after = (await s.listed())[0];
    expect(after?.noRoute).toBeUndefined();
    expect(after?.origin).toBe("node");
    expect(after?.certificate.waitingForDns).toBeUndefined();
  });

  test("a first deployment on its way is named, and a target without an image counts as none", async () => {
    const s = setup();
    const added = await callOp(panel, domainOps.add, { serviceId: s.service.id, host: "shop.example.com" }, { cookie });
    expect(added.status).toBe(200);
    const building = panel.deps.db
      .insert(deployments)
      .values({ serviceId: s.service.id, generation: 1, status: "building", trigger: "manual" })
      .returning()
      .get();
    expect((await s.listed())[0]?.noRoute).toEqual({ reason: "notDeployed", deploymentId: building.id });
    // A target deployment that never got an image ships nothing either.
    panel.deps.db.update(deployments).set({ status: "failed" }).where(eq(deployments.id, building.id)).run();
    panel.deps.db.update(serviceTable).set({ targetDeploymentId: building.id }).where(eq(serviceTable.id, s.service.id)).run();
    expect((await s.listed())[0]?.noRoute).toEqual({ reason: "notDeployed" });
  });

  test("its first deployment going live checks the waiting domains at once", async () => {
    const fleet = new FakeFleet(panel);
    const nodeId = fleet.addNode("node-a");
    // Its agent answers origin checks, so the certificate waits for one; DNS is checked against its address.
    fleet.caps.set(nodeId, new Set(["state.sync.v1", originCapability]));
    panel.deps.db.update(nodes).set({ publicIpv4: "203.0.113.10" }).where(eq(nodes.id, nodeId)).run();
    const projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id;
    const created = await callOp(
      panel,
      serviceOps.create,
      {
        projectId,
        name: "web",
        kind: "app",
        nodeId,
        source: { type: "image", image: "nginx:1.27", registryId: null },
        ports: [{ containerPort: 3000, protocol: "tcp" }],
      } as never,
      { cookie },
    );
    expect(created.status).toBe(200);
    const serviceId: string = created.body.id;
    setDnsLookups(proxied);
    const added = await callOp(panel, domainOps.add, { serviceId, host: "shop.example.com" }, { cookie });
    expect(added.body.domain.noRoute).toEqual({ reason: "notDeployed" });
    expect(originChecks()).toHaveLength(0);

    const deployed = await callOp(panel, deploymentOps.deploy, { serviceId }, { cookie });
    expect(deployed.status).toBe(200);
    await fleet.settle();
    const generation = panel.deps.db.select().from(deployments).where(eq(deployments.id, deployed.body.id)).get()?.generation ?? 0;
    fleet.deployProgress(nodeId, serviceId, generation, DeployStage.SUCCEEDED);
    await fleet.settle();
    expect(panel.deps.db.select().from(deployments).where(eq(deployments.id, deployed.body.id)).get()?.status).toBe("live");
    expect(originChecks().map((j) => (j.payload as { domainId: string }).domainId)).toEqual([added.body.domain.id]);
  });
});

describe("compose stacks and cron services", () => {
  for (const [kind, reason, message] of [
    [
      "compose",
      "stackParent",
      "web is a compose stack, which runs no container of its own, so a domain on it routes nowhere. Put the domain on the stack member that serves it, on that member's Domains tab.",
    ],
    ["cron", "cronService", "web is a cron service: it runs on its schedule and serves no requests, so a domain cannot reach it."],
  ] as const) {
    test(`a ${kind} service takes no domains, and one it has says where it belongs`, async () => {
      const s = setup({ kind, deployed: kind === "cron" });
      const add = await callOp(panel, domainOps.add, { serviceId: s.service.id, host: "shop.example.com" }, { cookie });
      expect(add.status).toBe(400);
      expect(add.body.error).toMatchObject({ message, details: { reason } });
      const auto = await callOp(panel, domainOps.addAuto, { serviceId: s.service.id }, { cookie });
      expect(auto.body.error?.details.reason).toBe(reason);

      // A domain from before (added through the API, which did not check): listed with why it routes nowhere.
      const stray = panel.deps.db
        .insert(domains)
        .values({ serviceId: s.service.id, host: "shop.example.com", targetPort: 3000, dnsStatus: "proxied", certStatus: "pending" })
        .returning()
        .get();
      expect((await s.listed())[0]?.noRoute).toEqual({ reason });
      const update = await callOp(panel, domainOps.update, { serviceId: s.service.id, domainId: stray.id, targetPort: 8080 }, { cookie });
      expect(update.body.error?.details.reason).toBe(reason);
      // It can still go.
      expect((await callOp(panel, domainOps.remove, { serviceId: s.service.id, domainId: stray.id }, { cookie })).status).toBe(200);
      expect(s.fetcher.urls).toHaveLength(0);
    });
  }
});

describe("a node that cannot write the service's routes", () => {
  test("the domains it has no route for name the node and its error; once it writes them, the waiting ones are checked", async () => {
    const s = setup({ deployed: true });
    const first = await callOp(panel, domainOps.add, { serviceId: s.service.id, host: "www.example.com" }, { cookie });
    const second = await callOp(panel, domainOps.add, { serviceId: s.service.id, host: "shop.example.com" }, { cookie });
    const error = "invalid route: the host belongs to another service: shop.example.com (service other)";
    // The node serves the file it wrote before the second domain: only the first has a route there.
    s.agent.snapshot({
      epoch: 1n,
      services: [
        {
          serviceId: s.service.id,
          routes: [{ routeId: first.body.domain.id, state: RouteState.CERTIFICATE_PENDING }],
          routeWriteError: { message: error },
        },
      ],
    });
    const rows = await s.listed();
    expect(rows.find((d) => d.host === "www.example.com")?.noRoute).toBeUndefined();
    expect(rows.find((d) => d.host === "shop.example.com")?.noRoute).toEqual({
      reason: "routeWriteFailed",
      nodeId: s.node.id,
      nodeName: "node-1",
      error,
    });

    // Written at last: the row clears, and its origin check runs now rather than at the re-check's pace.
    panel.deps.db.delete(jobs).where(eq(jobs.type, originCheckJobType)).run();
    s.agent.snapshot({
      epoch: 2n,
      services: [
        {
          serviceId: s.service.id,
          routes: [first.body.domain.id, second.body.domain.id].map((routeId) => ({ routeId, state: RouteState.CERTIFICATE_PENDING })),
        },
      ],
    });
    expect((await s.listed()).every((d) => d.noRoute === undefined)).toBe(true);
    expect(
      originChecks()
        .map((j) => (j.payload as { domainId: string }).domainId)
        .sort(),
    ).toEqual([first.body.domain.id, second.body.domain.id].sort());
  });
});
