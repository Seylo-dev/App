// The desired-state compiler on an in-memory database: DB rows -> one
// node's DesiredState, without any agent. The base spec comes from the
// services module and env/routing from the networking contributor; these tests
// cover what the compiler adds and that the pieces come together.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CronConcurrency, ServiceKind } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { cronJobs, deployments, domains, nodes, projectEnv, serviceEnv, servicePlacements, services } from "../src/db/schema";
import { compileDesiredState, compileServiceSpec, type DesiredContributor } from "../src/desired";
import { type TestPanel, testPanel } from "./helpers";
import { seedProject, seedService } from "./hub-helpers";

let panel: TestPanel;
let nodeA: string;
let nodeB: string;

function addNode(name: string, ipv4: string | null, extra: Partial<typeof nodes.$inferInsert> = {}) {
  return panel.deps.db
    .insert(nodes)
    .values({ name, publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), publicIpv4: ipv4, ...extra })
    .returning()
    .get().id;
}

beforeEach(() => {
  panel = testPanel();
  nodeA = addNode("a", "203.0.113.1", {
    gamesFirstCpu: true,
    wildcardDomain: "a.example.com",
    logMaxAgeDays: 3,
    canBuild: true,
    maxParallelBuilds: 2,
  });
  nodeB = addNode("b", "203.0.113.2");
});
afterEach(() => panel.close());

const options = (revision = 5n) => ({ revision, secrets: panel.deps.secrets, contributors: panel.deps.agents.desired.contributors() });

describe("compileDesiredState", () => {
  test("node settings, networks, cron jobs and load-balancer upstreams", () => {
    const { db } = panel.deps;
    const project = seedProject(panel);
    const web = seedService(panel, project.id, nodeA, {
      name: "web",
      replicas: 2,
      spec: { ports: [{ containerPort: 3000, protocol: "tcp" }], stickySessions: true },
    });
    db.insert(servicePlacements).values({ serviceId: web.id, nodeId: nodeB }).run();
    db.insert(cronJobs)
      .values({ serviceId: web.id, name: "nightly", schedule: "0 3 * * *", command: "bun run cleanup", concurrency: "replace" })
      .run();
    db.insert(cronJobs).values({ serviceId: web.id, name: "off", schedule: "* * * * *", command: "true", enabled: false }).run();

    const state = compileDesiredState(db, nodeA, options());
    expect(state.revision).toBe(5n);
    expect(state.networks.map((n) => n.projectId)).toEqual([project.id]);
    expect(state.settings).toMatchObject({ gamesFirstCpu: true, wildcardDomain: "a.example.com", maxParallelBuilds: 2 });
    expect(state.settings?.logRetention?.maxAge?.seconds).toBe(3n * 86400n);
    expect(compileDesiredState(db, nodeB, options()).settings?.maxParallelBuilds).toBe(0);

    const spec = state.services[0];
    expect(spec).toMatchObject({
      id: web.id,
      name: "web",
      kind: ServiceKind.APP,
      replicas: 2,
      image: { reference: "docker.io/library/nginx:1.27" },
    });
    expect(spec?.loadBalancer).toMatchObject({
      stickySessions: true,
      remoteUpstreams: [{ nodeId: nodeB, url: "https://203.0.113.2:5757" }],
    });
    expect(spec?.cronJobs.map((j) => [j.command, j.concurrency, j.disabled])).toEqual(
      expect.arrayContaining([
        [["sh", "-c", "bun run cleanup"], CronConcurrency.REPLACE, false],
        [["sh", "-c", "true"], CronConcurrency.FORBID, true],
      ]),
    );
    expect(state.settings?.autoUpdate).toBe(false);

    // A node sharing the Wings Traefik has no LB entry point: its copy is left out.
    db.update(nodes)
      .set({ facts: { wings: { traefikDynamicDir: "/etc/pelican/proxy/dynamic" } } })
      .where(eq(nodes.id, nodeB))
      .run();
    expect(compileDesiredState(db, nodeA, options()).services[0]?.loadBalancer?.remoteUpstreams).toEqual([]);

    // Nodes on one private network (no public address) are reached at their private IPv4.
    db.update(nodes)
      .set({ publicIpv4: null, publicIpv6: null, facts: { privateIpv4: "10.0.0.7" } })
      .where(eq(nodes.id, nodeB))
      .run();
    expect(compileDesiredState(db, nodeA, options()).services[0]?.loadBalancer?.remoteUpstreams).toMatchObject([
      { nodeId: nodeB, url: "https://10.0.0.7:5757" },
    ]);
    // The owner's public address (1:1 NAT clouds) wins over every detected one.
    db.update(nodes).set({ publicAddress: "2600:1f18::9" }).where(eq(nodes.id, nodeB)).run();
    expect(compileDesiredState(db, nodeA, options()).services[0]?.loadBalancer?.remoteUpstreams).toMatchObject([
      { nodeId: nodeB, url: "https://[2600:1f18::9]:5757" },
    ]);
  });

  test("env references and routes come in through the networking contributor", () => {
    const { db, secrets } = panel.deps;
    const project = seedProject(panel);
    seedService(panel, project.id, nodeA, { name: "api", spec: { ports: [{ containerPort: 8080, protocol: "tcp" }] } });
    const web = seedService(panel, project.id, nodeA, { name: "web", spec: { ports: [{ containerPort: 3000, protocol: "tcp" }] } });
    const ref = (target: string, variable: string) => `$${"{{"}${target}.${variable}}}`;
    db.insert(serviceEnv)
      .values({
        serviceId: web.id,
        contentSealed: secrets.seal(`API=${ref("api", "INTERNAL_URL")}\nREGION=${ref("project", "REGION")}\nPLAIN=1\n`, "service.env"),
      })
      .run();
    db.insert(projectEnv)
      .values({ projectId: project.id, contentSealed: secrets.seal("REGION=eu\n", "project.env") })
      .run();
    db.insert(domains).values({ serviceId: web.id, host: "shop.example.com", targetPort: 3000, isPrimary: true }).run();

    const spec = compileServiceSpec(db, nodeA, web.id, options());
    const env = Object.fromEntries(spec?.env.map((e) => [e.name, e.value]) ?? []);
    expect(env).toMatchObject({ API: "http://api:8080", REGION: "eu", PLAIN: "1" });
    expect(spec?.routing?.routes.map((r) => r.hosts)).toEqual([["shop.example.com"]]);
  });

  test("never-deployed services and compose stacks are left out; the target deployment decides the image", () => {
    const { db } = panel.deps;
    const project = seedProject(panel);
    seedService(panel, project.id, nodeA, { name: "draft", image: null });
    const stack = seedService(panel, project.id, nodeA, { name: "stack", kind: "compose", image: null });
    const worker = seedService(panel, project.id, nodeB, { name: "worker" });
    db.update(services).set({ parentId: stack.id }).where(eq(services.id, worker.id)).run();

    expect(compileDesiredState(db, nodeA, options()).services).toEqual([]);
    expect(compileDesiredState(db, nodeB, options()).services.map((s) => s.name)).toEqual(["worker"]);
    db.insert(deployments).values({ serviceId: worker.id, generation: 2, trigger: "manual", status: "failed", imageRef: "img:bad" }).run();
    expect(compileDesiredState(db, nodeB, options()).services[0]?.image?.reference).toBe("docker.io/library/nginx:1.27");
  });

  test("contributors refine specs and node settings", () => {
    const project = seedProject(panel);
    const svc = seedService(panel, project.id, nodeA, { name: "api" });
    const extra: DesiredContributor = {
      name: "test",
      service: (ctx) => {
        ctx.spec.networkAliases = [...ctx.spec.networkAliases, "api-alias"];
      },
      node: (ctx) => {
        ctx.settings.acmeEmail = "certs@example.com";
      },
    };
    const withExtra = { ...options(), contributors: [...panel.deps.agents.desired.contributors(), extra] };
    expect(compileServiceSpec(panel.deps.db, nodeA, svc.id, withExtra)?.networkAliases).toContain("api-alias");
    expect(compileDesiredState(panel.deps.db, nodeA, withExtra).settings?.acmeEmail).toBe("certs@example.com");
  });
});
