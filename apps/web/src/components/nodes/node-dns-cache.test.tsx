// The DNS cache switch in the node's settings: disabled with the version
// it needs on an older agent; while on, its state, address, hit rate,
// upstream lookups per minute, the fix when it is blocked and which
// containers use it and which get it at their next redeploy; the Wings
// note next to Wings.

import { expect, test } from "bun:test";
import { nodes, type OpOutput } from "@seylo/ops";
import { t } from "../../i18n/t";
import type { NodeDetail } from "../../lib/types";
import { renderStatic } from "../../test/render";
import { DnsCacheSetting } from "./node-dns-cache";

const node = (values: Partial<NodeDetail>) =>
  ({
    id: "node-1",
    name: "de-fsn-1",
    status: "online",
    wings: { detected: false, version: null, sharedProxy: false },
    dnsCache: false,
    dnsCacheSupported: true,
    services: [{ serviceId: "svc-web", serviceName: "web", projectId: "prj-1", projectName: "Shop", replicas: 1, phase: "running" }],
    ...values,
  }) as NodeDetail;

type Status = OpOutput<typeof nodes.dnsCacheStatus>;

const status = (values: Partial<Status>): Status => ({
  nodeId: "node-1",
  enabled: true,
  supported: true,
  online: true,
  state: "active",
  reason: "",
  fixHint: "",
  address: "169.254.53.53",
  upstreams: ["8.8.8.8", "1.1.1.1"],
  fallbacks: ["8.8.8.8", "1.1.1.1"],
  entries: 40,
  queries: 1000,
  hits: 920,
  stale: 0,
  upstreamQueries: 80,
  upstreamFailures: 0,
  hitRate: 0.92,
  upstreamPerMinute: 1.5,
  minutes: [],
  checkedAt: "2026-11-14T10:00:00.000Z",
  checkPassed: true,
  containers: [
    { name: "seylo-svc-web-3", serviceId: "svc-web", serviceName: "web", kind: "service", usesCache: true, created: null },
    { name: "seylo-svc-api-1", serviceId: "svc-api", serviceName: "api", kind: "service", usesCache: false, created: null },
    { name: "seylo-cron-x", serviceId: null, serviceName: null, kind: "cron", usesCache: false, created: null },
  ],
  ...values,
});

const render = (detail: NodeDetail, answer?: Status) =>
  renderStatic(() => <DnsCacheSetting node={detail} />, answer ? [[nodes.dnsCacheStatus, { nodeId: detail.id }, answer]] : []);

const html = (text: string) => text.replaceAll("'", "&#x27;");
// The switch's own tag.
const switchTag = (out: string) => out.match(/<button[^>]*id="toggle-dns-cache"[^>]*>/)?.[0] ?? "";

test("an agent before 0.2.17: the switch is disabled and says what it needs", async () => {
  const out = await render(node({ dnsCacheSupported: false }));
  expect(out).toContain(t("nodeDnsCache.title"));
  expect(out).toContain(html(t("nodeDnsCache.oldAgent", { version: "0.2.17" })));
  expect(switchTag(out)).toContain('disabled=""');
  expect(out).not.toContain('data-testid="dns-cache-state"');
});

test("off: the switch and what it does, honestly, and no status", async () => {
  const out = await render(node({}), status({ state: "off", containers: [] }));
  expect(out).toContain(html(t("nodeDnsCache.hint")));
  expect(t("nodeDnsCache.hint")).toContain("does not help with many different names");
  expect(t("nodeDnsCache.hint")).toContain("it is no limit");
  expect(out).not.toContain('data-testid="dns-cache-state"');
  expect(switchTag(out)).not.toBe("");
  expect(switchTag(out)).not.toContain('disabled=""');
});

test("active: state, address, hit rate, upstream lookups and the two lists", async () => {
  const out = await render(node({ dnsCache: true }), status({}));
  expect(out).toContain(`>${t("nodeDnsCache.state.active")}</span>`);
  expect(out).toContain("169.254.53.53");
  expect(out).toMatch(/data-testid="dns-cache-hit-rate">92%</);
  expect(out).toMatch(/data-testid="dns-cache-upstream">1.5</);
  const using = out.slice(out.indexOf('data-testid="dns-cache-using"'), out.indexOf('data-testid="dns-cache-waiting"'));
  expect(using).toContain("seylo-svc-web-3");
  expect(using).toContain('href="/p/prj-1/s/svc-web"');
  const waiting = out.slice(out.indexOf('data-testid="dns-cache-waiting"'));
  expect(waiting).toContain("seylo-svc-api-1");
  expect(waiting).toContain(t("nodeDnsCache.kind.cron"));
  expect(out).toContain(html(t("nodeDnsCache.notYet")));
  expect(out).toContain(html(t("nodeDnsCache.applies")));
});

test("blocked: the reason and the fix with its command", async () => {
  const out = await render(
    node({ dnsCache: true }),
    status({
      state: "blocked",
      reason: "a test container on seylo-p-0123456789abcdef gets no answer from it",
      fixHint: 'With ufw: `ufw allow to 169.254.53.53 port 53 comment "seylo dns"`.',
      checkPassed: false,
    }),
  );
  expect(out).toContain(`>${t("nodeDnsCache.state.blocked")}</span>`);
  expect(out).toContain("gets no answer from it");
  expect(out).toContain("<code");
  expect(out).toContain("ufw allow to 169.254.53.53 port 53 comment &quot;seylo dns&quot;");
});

test("off but still used: draining, with the containers that still use it", async () => {
  const out = await render(node({ dnsCache: false }), status({ state: "draining", enabled: false }));
  expect(out).toContain(html(t("nodeDnsCache.state.draining")));
  expect(out).toContain(html(t("nodeDnsCache.stillUsing")));
  expect(out).toContain(html(t("nodeDnsCache.stateHint.draining")));
  expect(out).not.toContain('data-testid="dns-cache-waiting"');
});

test("next to Wings it says where game servers take their DNS from", async () => {
  const out = await render(node({ wings: { detected: true, version: "1.11", sharedProxy: true } }));
  expect(out).toContain(html(t("nodeDnsCache.wings")));
  expect(t("nodeDnsCache.wings")).toContain("docker.network.dns");
});
