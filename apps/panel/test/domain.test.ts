// The panel domain as a private path (settings/domain.ts, 0.2.1): checked
// every 5 minutes instead of hourly while IP access is closed or meant to
// be, down only after 2 failed checks in a row, and IP access follows its
// debounced state.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { nodes } from "../src/db/schema";
import type { JobContext } from "../src/jobs/queue";
import { ensurePanelService } from "../src/modules/nodes/panel-service";
import { checkDomain, domainCheckJob, domainWorking, setDomainProbes } from "../src/modules/settings/domain";
import { panelPublishBindCapability, readIpAccessApplied } from "../src/modules/settings/ip-access";
import { domainPath } from "../src/modules/settings/private-paths";
import { getSetting, setSetting } from "../src/settings";
import { type TestPanel, testPanel } from "./helpers";
import { type FakeAgent, fakeAgent } from "./seed-helpers";

const domain = "panel.example.com";
let panel: TestPanel;
let agent: FakeAgent;
let https = true;
let probes = 0;

beforeEach(() => {
  panel = testPanel();
  panel.deps.config.image = `ghcr.io/seylo-dev/seylo:0.2.1@sha256:${"f".repeat(64)}`;
  const nodeId = panel.deps.db
    .insert(nodes)
    .values({ name: "here", publicKey: Buffer.alloc(32, 4), publicIpv4: "203.0.113.10", isPanelNode: true })
    .returning()
    .get().id;
  ensurePanelService(panel.deps);
  agent = fakeAgent(panel, nodeId, {}, [], [panelPublishBindCapability]);
  setSetting(panel.deps.db, "panelDomain", domain);
  https = true;
  probes = 0;
  setDomainProbes({
    resolve: async () => ["203.0.113.10"],
    https: async () => {
      probes++;
      return https;
    },
  });
});
afterEach(() => {
  setDomainProbes(null);
  agent.disconnect();
  panel.close();
});

const run = () => domainCheckJob.run({}, panel.deps as JobContext);

test("a domain that worked is down only after 2 failed checks in a row", async () => {
  const t0 = new Date("2026-11-08T10:00:00Z");
  expect((await checkDomain(panel.deps, t0))?.working).toBe(true);
  expect(domainPath.state(panel.deps)).toEqual({ url: `https://${domain}`, working: true, since: t0 });
  https = false;
  const once = await checkDomain(panel.deps, new Date(t0.getTime() + 300_000));
  expect(once).toMatchObject({ state: "issuing_certificate", working: true, failedChecks: 1, since: t0.getTime() });
  const twice = await checkDomain(panel.deps, new Date(t0.getTime() + 600_000));
  expect(twice).toMatchObject({ working: false, failedChecks: 2, since: t0.getTime() + 600_000 });
  // One good check makes it work again.
  https = true;
  expect(await checkDomain(panel.deps, new Date(t0.getTime() + 900_000))).toMatchObject({ working: true, failedChecks: 0 });
});

test("a status row from 0.2.0 (no debounce fields) counts by its state", () => {
  expect(domainWorking({ domain, state: "active", message: "", checkedAt: 1 }, domain)).toEqual({ working: true, since: null });
  expect(domainWorking({ domain, state: "pending_dns", message: "", checkedAt: 1 }, domain).working).toBe(false);
  expect(domainWorking({ domain: "old.example.com", state: "active", message: "", checkedAt: 1 }, domain).working).toBe(false);
});

test("an active domain is checked hourly while IP access is open, on every run while it is meant to be closed", async () => {
  await run();
  expect(probes).toBe(1);
  await run();
  expect(probes).toBe(1);
  setSetting(panel.deps.db, "panelServeOnIp", false);
  await run();
  expect(probes).toBe(2);
  await run();
  expect(probes).toBe(3);
});

test("the job closes and reopens IP access with the debounced domain", async () => {
  setSetting(panel.deps.db, "panelServeOnIp", false);
  // The agent's connect found no working path yet.
  expect(readIpAccessApplied(panel.deps).closed).toBe(false);
  await run();
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: true, reason: "the panel domain works again" });
  https = false;
  await run();
  expect(readIpAccessApplied(panel.deps).closed).toBe(true);
  await run();
  expect(readIpAccessApplied(panel.deps)).toMatchObject({ closed: false, reason: `the panel domain ${domain} stopped working` });
  expect(getSetting(panel.deps.db, "panelDomainStatus")?.working).toBe(false);
});
