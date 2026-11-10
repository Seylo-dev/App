// A node's Location is filled in from its public address when it joins: the
// panel asks the site API's /geo once, in the background, and stores "City,
// Country" marked "detected" until someone saves the field (then "manual",
// never filled in again). No lookup while telemetry is locked off on the
// container, for private addresses, or for a node someone already named; a
// lookup without an answer waits for the next panel start
// (modules/nodes/location.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodes as nodeOps, setup } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { issueSetupToken } from "../src/auth/setup-token";
import { nodes } from "../src/db/schema";
import { detectNodeLocation, type GeoFetch, locationLabel, lookupAddress, setGeoFetch } from "../src/modules/nodes/location";
import type { FakeAgent } from "./fake-agent";
import { callOp, createUser, refuseGeoLookups, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";
import { noLimits } from "./people-helpers";

const ATTRIBUTION = "Geolocation by DB-IP (https://db-ip.com)";
const falkenstein = { city: "Falkenstein", region: "Saxony", country: "Germany", countryCode: "DE", attribution: ATTRIBUTION };

let panel: TestPanel;
let url: string;
let asked: { url: string; init: RequestInit }[];
let answer: (ip: string) => Response | Promise<Response>;
const agents: FakeAgent[] = [];
const dirs: string[] = [];

/** Answers lookups with `answer` and records them. */
function fakeGeo(): GeoFetch {
  return async (lookupUrl, init) => {
    asked.push({ url: lookupUrl, init });
    return answer(new URL(lookupUrl).searchParams.get("ip") ?? "");
  };
}

beforeEach(() => {
  asked = [];
  answer = () => Response.json(falkenstein);
  setGeoFetch(fakeGeo());
  panel = testPanel({ rateLimiter: noLimits });
  url = listen(panel);
});
afterEach(async () => {
  setGeoFetch(refuseGeoLookups);
  for (const agent of agents.splice(0)) await agent.close();
  if (panel.app.server) await panel.app.stop(true);
  panel.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const rowOf = (id: string, on: TestPanel = panel) => {
  const row = on.deps.db.select().from(nodes).where(eq(nodes.id, id)).get();
  if (!row) throw new Error("no node");
  return row;
};

function addNode(values: Partial<typeof nodes.$inferInsert> = {}, on: TestPanel = panel) {
  return on.deps.db
    .insert(nodes)
    .values({ name: `n-${crypto.randomUUID().slice(0, 6)}`, publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), ...values })
    .returning()
    .get();
}

describe("when a node joins", () => {
  test("its empty location is filled in from its public address, once, and marked detected", async () => {
    const { cookie } = await createUser(panel, "owner");
    const agent = await joinAgent(panel, url, { facts: { publicIpv4: "88.198.10.1" } });
    agents.push(agent);
    await until(() => rowOf(agent.nodeId).location !== null);

    expect(asked.map((a) => a.url)).toEqual(["https://api.seylo.dev/geo?ip=88.198.10.1"]);
    // A short timeout, and nothing but the address goes out.
    expect(asked[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(asked[0]?.init.body).toBeUndefined();
    const row = rowOf(agent.nodeId);
    expect(row).toMatchObject({ location: "Falkenstein, Germany", locationSource: "detected" });
    expect(row.locationLookedUpAt).toBeInstanceOf(Date);

    const detail = await callOp(panel, nodeOps.get, { nodeId: agent.nodeId }, { cookie });
    expect(detail.body).toMatchObject({ location: "Falkenstein, Germany", locationSource: "detected" });
    const listed = await callOp(panel, nodeOps.list, {}, { cookie });
    expect(listed.body.nodes[0]).toMatchObject({ location: "Falkenstein, Germany", locationSource: "detected" });

    // Connecting again asks nothing.
    await agent.close();
    agents.push(await joinAgent(panel, url, { nodeId: agent.nodeId, key: agent.key, facts: { publicIpv4: "88.198.10.1" } }));
    await Bun.sleep(50);
    expect(asked).toHaveLength(1);
  });

  test("the join never waits for the lookup or fails with it", async () => {
    let release = () => {};
    answer = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(Response.json(falkenstein));
      });
    const agent = await joinAgent(panel, url, { facts: { publicIpv4: "88.198.10.1" } });
    agents.push(agent);
    expect(agent.accepted).not.toBeNull();
    await until(() => asked.length === 1);
    expect(rowOf(agent.nodeId).location).toBeNull();
    release();
    await until(() => rowOf(agent.nodeId).location !== null);

    // A lookup that throws leaves the node as it was.
    setGeoFetch(refuseGeoLookups);
    const second = await joinAgent(panel, url, { facts: { publicIpv4: "88.198.10.2" } });
    agents.push(second);
    await Bun.sleep(50);
    expect(rowOf(second.nodeId)).toMatchObject({ location: null, locationSource: null, locationLookedUpAt: null });
  });

  test("an IPv6-only node is looked up by its IPv6 address, a NAT node by the address it connected from", async () => {
    const v6 = await joinAgent(panel, url, { facts: { publicIpv6: "2a01:4f8:c0c:1234::1" } });
    agents.push(v6);
    await until(() => asked.length === 1);
    expect(asked[0]?.url).toBe(`https://api.seylo.dev/geo?ip=${encodeURIComponent("2a01:4f8:c0c:1234::1")}`);

    expect(lookupAddress({ publicIpv4: "10.0.0.5", publicIpv6: null, publicAddress: "54.12.0.9" })).toBe("54.12.0.9");
    expect(lookupAddress({ publicIpv4: "88.198.10.1", publicIpv6: "2a01:4f8::1", publicAddress: null })).toBe("88.198.10.1");
    expect(lookupAddress({ publicIpv4: null, publicIpv6: null, publicAddress: "[2a01:4f8::9]" })).toBe("2a01:4f8::9");
  });
});

describe("the owner's word wins", () => {
  test("saving the field, kept as detected or cleared, makes it manual and it is never filled in again", async () => {
    const { cookie } = await createUser(panel, "owner");
    const node = addNode({ publicIpv4: "88.198.10.1", location: "Falkenstein, Germany", locationSource: "detected" });

    // Other settings leave the mark alone.
    const other = await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, maxParallelBuilds: 2 }, { cookie });
    expect(other.body).toMatchObject({ location: "Falkenstein, Germany", locationSource: "detected" });

    // Keeping it as it is.
    const kept = await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, location: "Falkenstein, Germany" }, { cookie });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ location: "Falkenstein, Germany", locationSource: "manual" });

    // Cleared: empty, and no new lookup.
    const cleared = await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, location: null }, { cookie });
    expect(cleared.body).toMatchObject({ location: null, locationSource: "manual" });
    expect(detectNodeLocation(panel.deps, node.id)).toBeNull();
    expect(asked).toEqual([]);

    // An empty string clears it the same way.
    const fresh = addNode({ publicIpv4: "88.198.10.3" });
    await callOp(panel, nodeOps.updateSettings, { nodeId: fresh.id, location: "  " }, { cookie });
    expect(rowOf(fresh.id)).toMatchObject({ location: null, locationSource: "manual" });
    expect(detectNodeLocation(panel.deps, fresh.id)).toBeNull();
  });

  test("a location saved while the lookup runs is kept", async () => {
    const { cookie } = await createUser(panel, "owner");
    const node = addNode({ publicIpv4: "88.198.10.1" });
    let release = () => {};
    answer = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(Response.json(falkenstein));
      });
    const lookup = detectNodeLocation(panel.deps, node.id);
    expect(lookup).not.toBeNull();
    await until(() => asked.length === 1);
    await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, location: "Home lab" }, { cookie });
    release();
    await lookup;
    expect(rowOf(node.id)).toMatchObject({ location: "Home lab", locationSource: "manual" });
  });

  test("a location typed before the panel detected locations is never looked up", () => {
    const node = addNode({ publicIpv4: "88.198.10.1", location: "Rack 4" });
    expect(detectNodeLocation(panel.deps, node.id)).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("what is never asked", () => {
  test("nothing while SEYLO_TELEMETRY=off or DO_NOT_TRACK=1 locks telemetry off on the container", async () => {
    (panel.deps.config as { telemetryOffBy?: string | null }).telemetryOffBy = "DO_NOT_TRACK";
    const node = addNode({ publicIpv4: "88.198.10.1" });
    expect(detectNodeLocation(panel.deps, node.id)).toBeNull();
    const agent = await joinAgent(panel, url, { facts: { publicIpv4: "88.198.10.2" } });
    agents.push(agent);
    await Bun.sleep(50);
    expect(asked).toEqual([]);
    expect(rowOf(agent.nodeId).location).toBeNull();
  });

  test("private, reserved and host-name addresses never leave the panel", () => {
    for (const values of [
      { publicIpv4: "10.0.0.5" },
      { publicIpv4: "192.168.64.9", publicIpv6: "fd00::5" },
      { publicIpv4: "203.0.113.7" },
      { publicIpv6: "2001:db8::7" },
      { publicIpv4: "100.64.1.2" },
      { publicAddress: "node1.example.com" },
      { publicAddress: "127.0.0.1" },
      {},
    ]) {
      const node = addNode(values);
      expect([values, detectNodeLocation(panel.deps, node.id)]).toEqual([values, null]);
    }
    expect(asked).toEqual([]);
  });
});

describe("answers", () => {
  test("City, Country; the country alone; nothing without a country", () => {
    expect(locationLabel(falkenstein)).toBe("Falkenstein, Germany");
    expect(locationLabel({ city: null, region: null, country: "Israel", countryCode: "IL" })).toBe("Israel");
    expect(locationLabel({ city: "Singapore", country: "Singapore" })).toBe("Singapore");
    expect(locationLabel({ city: "Somewhere", country: null })).toBeNull();
    expect(locationLabel({ city: null, region: null, country: null, countryCode: null })).toBeNull();
    expect(locationLabel({ city: "Tel\u0000 Aviv\n", country: "Israel" })).toBe("Tel Aviv, Israel");
    expect(locationLabel({ city: "x".repeat(61), country: "Germany" })).toBe("Germany");
    expect(locationLabel({ city: "y".repeat(50), country: "z".repeat(40) })).toBe("z".repeat(40));
    for (const bad of [null, "Germany", 42, [], { country: 7 }]) expect(locationLabel(bad)).toBeNull();
  });

  test("an answer without a country is recorded, so the node is not asked about again", async () => {
    answer = () => Response.json({ city: null, region: null, country: null, countryCode: null, attribution: ATTRIBUTION });
    const node = addNode({ publicIpv4: "88.198.10.1" });
    await detectNodeLocation(panel.deps, node.id);
    expect(rowOf(node.id)).toMatchObject({ location: null, locationSource: null });
    expect(rowOf(node.id).locationLookedUpAt).toBeInstanceOf(Date);
  });

  test("400 (an address the API calls private) is an answer; 503, 429, 404 and what is not its JSON wait for the next start", async () => {
    answer = () => Response.json({ error: "not_public" }, { status: 400 });
    const refused = addNode({ publicIpv4: "88.198.10.1" });
    await detectNodeLocation(panel.deps, refused.id);
    expect(rowOf(refused.id).locationLookedUpAt).toBeInstanceOf(Date);

    for (const [reply, answered] of [
      [() => Response.json({ error: "unavailable" }, { status: 503 }), false],
      [() => new Response("rate-limit reached", { status: 429 }), false],
      [() => new Response("Not found", { status: 404 }), false],
      // A 200 that is not the API's JSON (a proxy's page, a wrong SEYLO_GEO_URL) is no answer either.
      [() => new Response(JSON.stringify({ ...falkenstein, padding: "x".repeat(10_000) })), false],
      [() => new Response("<html>"), false],
      [() => Response.json(["Germany"]), false],
      // An answer that knows nothing is one.
      [() => Response.json({ city: null, region: null, country: null, countryCode: null }), true],
    ] as const) {
      answer = reply;
      const node = addNode({ publicIpv4: "88.198.10.2" });
      await detectNodeLocation(panel.deps, node.id);
      const row = rowOf(node.id);
      expect(row.location).toBeNull();
      expect(row.locationLookedUpAt !== null).toBe(answered);
      // Not asked again while this panel runs.
      expect(detectNodeLocation(panel.deps, node.id)).toBeNull();
    }
  });

  test("nodes without a location get one lookup at start, and one without an answer is asked again after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seylo-node-location-"));
    dirs.push(dir);
    const panelPath = join(dir, "panel.db");
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    // The node was there before the panel detected locations.
    setGeoFetch(refuseGeoLookups);
    const first = testPanel({ panelPath, masterKey });
    const node = addNode({ publicIpv4: "88.198.10.1" }, first);
    const named = addNode({ publicIpv4: "88.198.10.2", location: "Rack 4" }, first);
    await Bun.sleep(20);
    first.close();

    // Down: nothing recorded.
    answer = () => Response.json({ error: "unavailable" }, { status: 503 });
    setGeoFetch(fakeGeo());
    const second = testPanel({ panelPath, masterKey });
    await until(() => asked.length === 1);
    await Bun.sleep(20);
    expect(rowOf(node.id, second)).toMatchObject({ location: null, locationLookedUpAt: null });
    second.close();

    // The next start asks again and gets it; the named node is never asked about.
    answer = () => Response.json(falkenstein);
    const third = testPanel({ panelPath, masterKey });
    await until(() => rowOf(node.id, third).location !== null);
    expect(rowOf(node.id, third)).toMatchObject({ location: "Falkenstein, Germany", locationSource: "detected" });
    expect(rowOf(named.id, third)).toMatchObject({ location: "Rack 4", locationSource: null });
    expect(asked.map((a) => new URL(a.url).searchParams.get("ip"))).toEqual(["88.198.10.1", "88.198.10.1"]);
    third.close();

    // Answered: a fourth start asks nothing.
    const fourth = testPanel({ panelPath, masterKey });
    await Bun.sleep(50);
    expect(asked).toHaveLength(2);
    fourth.close();
  });
});

describe("nodes that only get an address later", () => {
  test("the panel node behind 1:1 NAT is looked up once the setup link gives it its address", async () => {
    const node = addNode({ isPanelNode: true, facts: { privateIpv4: "10.0.1.5" } });
    expect(detectNodeLocation(panel.deps, node.id)).toBeNull();
    const { token } = issueSetupToken(panel.deps.db);
    const created = await callOp(
      panel,
      setup.createOwner,
      { token, email: "o@example.com", password: "correct horse battery" },
      { headers: { host: "54.12.0.9:3000" } },
    );
    expect(created.status).toBe(200);
    await until(() => rowOf(node.id).location !== null);
    expect(asked.map((a) => a.url)).toEqual(["https://api.seylo.dev/geo?ip=54.12.0.9"]);
  });

  test("setting a public address looks the node up", async () => {
    const { cookie } = await createUser(panel, "owner");
    const node = addNode({ publicIpv4: "10.0.0.5" });
    await callOp(panel, nodeOps.updateSettings, { nodeId: node.id, publicAddress: "54.12.0.9" }, { cookie });
    await until(() => rowOf(node.id).location !== null);
    expect(rowOf(node.id)).toMatchObject({ location: "Falkenstein, Germany", locationSource: "detected" });
  });
});
