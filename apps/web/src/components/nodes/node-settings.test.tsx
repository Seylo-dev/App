// The Location field of a node the panel looked up shows the detected
// location as its value, marked Detected with DB-IP's credit and a link to
// db-ip.com, until the form is saved (then locationSource is "manual").
// The node list credits DB-IP under the list while a location in it was
// detected.

import { expect, test } from "bun:test";
import { nodes } from "@seylo/ops";
import { TooltipProvider } from "@seylo/ui/components/tooltip";
import { t } from "../../i18n/t";
import type { NodeDetail } from "../../lib/types";
import { renderStatic } from "../../test/render";
import { NodeSettingsForm } from "./node-settings";
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
