// The Location field of a node the panel looked up shows the detected
// location as its value, marked Detected with DB-IP's credit and a link to
// db-ip.com, until the form is saved (then locationSource is "manual").
// The node list credits DB-IP under the list while a location in it was
// detected. Builds at once is Auto, with what it works out to now, or a
// fixed number.

import { expect, test } from "bun:test";
import { nodes } from "@seylo/ops";
import { TooltipProvider } from "@seylo/ui/components/tooltip";
import { t } from "../../i18n/t";
import type { NodeDetail } from "../../lib/types";
import { renderStatic } from "../../test/render";
import { NodeSettingsForm, parallelBuildsInput } from "./node-settings";
import { NodeTable } from "./node-table";

const node = (values: Partial<NodeDetail>) =>
  ({
    id: "node-1",
    name: "de-fsn-1",
    location: null,
    tags: [],
    status: "online",
    isPanelNode: false,
    publicIpv4: "88.198.10.1",
    publicIpv6: null,
    publicAddress: null,
    wildcardDomain: null,
    agentVersion: "0.2.5",
    updateAvailable: false,
    canBuild: false,
    canBuildWarning: null,
    maxParallelBuilds: 1,
    parallelBuildsAuto: false,
    wings: { detected: false, version: null, sharedProxy: false },
    gamesFirstCpu: false,
    facts: null,
    usage: null,
    serviceCount: 0,
    health: { checkedAt: null, worst: null },
    lastSeenAt: null,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    capabilities: [],
    logRetention: { maxBytesPerService: 100 * 1024 * 1024, maxAgeDays: 14 },
    services: [],
    desiredRevision: 0,
    appliedRevision: null,
    panelAddress: null,
    ...values,
  }) as NodeDetail;

const form = (detail: NodeDetail) => renderStatic(() => <NodeSettingsForm node={detail} onRemoved={() => {}} />);
// The markup escapes apostrophes.
const html = (text: string) => text.replaceAll("'", "&#x27;");

test("a detected location is the field's value, marked Detected with DB-IP's credit", async () => {
  const out = await form(node({ location: "Falkenstein, Germany", locationSource: "detected" }));
  expect(out).toContain('value="Falkenstein, Germany"');
  expect(out).toContain(`>${t("nodes.form.locationDetected")}</span>`);
  expect(out).toContain(html(t("nodes.form.locationDetectedBefore")));
  expect(out).toContain(`href="https://db-ip.com"`);
  expect(out).toContain(`>${t("nodes.geolocationByDbIp")}</a>`);
  expect(out).toContain('aria-describedby="node-location-note"');
  expect(`${t("nodes.form.locationDetectedBefore")} ${t("nodes.geolocationByDbIp")}${t("nodes.form.locationDetectedAfter")}`).toBe(
    "From the server's IP address, Geolocation by DB-IP. Change it if it is wrong.",
  );
});

test("a saved location, or none, is not marked", async () => {
  for (const values of [
    { location: "Falkenstein, Germany", locationSource: "manual" as const },
    { location: "Rack 4" },
    { location: null, locationSource: "manual" as const },
    { location: null },
  ]) {
    const out = await form(node(values));
    expect(out).not.toContain(`>${t("nodes.form.locationDetected")}</span>`);
    expect(out).not.toContain("db-ip.com");
    expect(out).toContain('placeholder="Falkenstein, Germany"');
  }
});

test("the node list shows the detected location and credits DB-IP under the list", async () => {
  const list = (locationSource?: "detected" | "manual") =>
    renderStatic(
      () => (
        <TooltipProvider>
          <NodeTable onOpen={() => {}} />
        </TooltipProvider>
      ),
      [[nodes.list, {}, { nodes: [node({ location: "Falkenstein, Germany", ...(locationSource ? { locationSource } : {}) })] }]],
    );
  const detected = await list("detected");
  expect(detected).toContain("Falkenstein, Germany");
  expect(detected).toContain(t("nodes.detectedLocations"));
  expect(detected).toContain(`href="https://db-ip.com"`);
  for (const source of ["manual", undefined] as const) {
    const out = await list(source);
    expect(out).toContain("Falkenstein, Germany");
    expect(out).not.toContain("db-ip.com");
  }
});

const gib = 1024 ** 3;
const facts = (cpuCores: number, memoryTotalBytes: number) => ({
  hostname: "il-ra",
  os: "ubuntu 24.04",
  kernel: "6.8.0",
  arch: "amd64",
  cpuCores,
  memoryTotalBytes,
  diskTotalBytes: 0,
  diskFreeBytes: 0,
  dockerVersion: "29.0.1",
  cgroupVersion: 2,
  bootTime: null,
});
/** The Builds at once trigger (a button) with its attributes and text. */
const buildsTrigger = (out: string) => /<button[^>]*id="node-parallel"[^>]*>.*?<\/button>/s.exec(out)?.[0] ?? "";

test("Builds at once on Auto says what it runs now and how it is worked out", async () => {
  const out = await form(node({ canBuild: true, parallelBuildsAuto: true, maxParallelBuilds: 7, facts: facts(28, 157 * gib) }));
  const trigger = buildsTrigger(out);
  expect(trigger).toContain(">Auto - 7 now<");
  expect(trigger).toContain('aria-describedby="node-parallel-hint"');
  expect(out).toMatch(/<label[^>]*for="node-parallel"[^>]*>Builds at once<\/label>/);
  expect(out).toContain(
    `<span id="node-parallel-hint" class="text-xs text-muted-foreground">${t("nodes.form.parallelBuildsAutoHint")}</span>`,
  );
  expect(t("nodes.form.parallelBuildsAutoHint")).toBe("1 per 4 cores and 4 GB of memory, up to 16.");
  // The number input is gone.
  expect(out).not.toMatch(/<input[^>]*id="node-parallel"/);
});

test("Auto on a node that has not reported its hardware says so", async () => {
  const out = await form(node({ canBuild: true, parallelBuildsAuto: true, maxParallelBuilds: 1, facts: null }));
  expect(buildsTrigger(out)).toContain(">Auto - 1 now<");
  expect(out).toContain(html(t("nodes.form.parallelBuildsAutoNoFacts")));
  expect(out).not.toContain(`>${t("nodes.form.parallelBuildsAutoHint")}<`);
});

test("a fixed number shows the number, with no Auto hint", async () => {
  const out = await form(node({ canBuild: true, parallelBuildsAuto: false, maxParallelBuilds: 3, facts: facts(32, 121 * gib) }));
  const trigger = buildsTrigger(out);
  expect(trigger).toContain(">3<");
  expect(trigger).not.toContain("Auto");
  expect(trigger).not.toContain("aria-describedby");
  expect(out).not.toContain('id="node-parallel-hint"');
});

test("Save sends Auto without a number, and a number alone, which the panel makes fixed", () => {
  expect(parallelBuildsInput("auto")).toEqual({ parallelBuildsAuto: true });
  expect(parallelBuildsInput("4")).toEqual({ maxParallelBuilds: 4 });
  expect(parallelBuildsInput("16")).toEqual({ maxParallelBuilds: 16 });
});
