// A node's Panel address in its settings (follow the panel's domain, or
// stay on the address it connects to, with who chose it when that was the
// node or an alert), the reason an offline node's row gives (the hello the
// panel refused, else when it was last seen), and the node page's "Was
// offline from ... to ...: <reason>" from the agent's own report.

import { expect, test } from "bun:test";
import { nodes } from "@seylo/ops";
import { TooltipProvider } from "@seylo/ui/components/tooltip";
import { t } from "../../i18n/t";
import { formatPointTime } from "../../lib/format";
import type { NodeDetail } from "../../lib/types";
import { renderStatic } from "../../test/render";
import { NodeSettingsForm } from "./node-settings";
import { LastOffline } from "./node-sheet";
import { NodeTable } from "./node-table";

const node = (values: Partial<NodeDetail>) =>
  ({
    id: "node-1",
    name: "il-tlv",
    location: null,
    tags: [],
    status: "online",
    isPanelNode: false,
    publicIpv4: "203.0.113.20",
    publicIpv6: null,
    publicAddress: null,
    wildcardDomain: null,
    agentVersion: "0.2.14",
    updateAvailable: false,
    canBuild: false,
    canBuildWarning: null,
    maxParallelBuilds: 1,
    wings: { detected: true, version: "1.11.0", sharedProxy: false },
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
    panelAddress: "https://203.0.113.10:3443",
    ...values,
  }) as NodeDetail;

const html = (text: string) => text.replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
const form = (detail: NodeDetail) => renderStatic(() => <NodeSettingsForm node={detail} onRemoved={() => {}} />);
const checked = (out: string, value: string) =>
  new RegExp(`aria-checked="true"[^>]*value="${value}"|value="${value}"[^>]*aria-checked="true"`).test(out);

test("the Panel address shows the choice, with who made it when that was not someone here", async () => {
  const follow = await form(node({ panelAddressChoice: "follow", panelAddressChoiceBy: "default", panelAddressChoiceAt: null }));
  expect(follow).toContain(t("nodes.form.panelAddress"));
  expect(follow).toContain(html(t("nodes.form.panelAddressFollow")));
  expect(follow).toContain(html(t("nodes.form.panelAddressStayHint")));
  expect(checked(follow, "follow")).toBe(true);
  expect(checked(follow, "stay")).toBe(false);

  const inspected = await form(
    node({ panelAddressChoice: "stay", panelAddressChoiceBy: "inspectedCertificate", panelAddressChoiceAt: null }),
  );
  expect(checked(inspected, "stay")).toBe(true);
  expect(inspected).toContain(html(t("nodes.form.panelAddressBy.inspectedCertificate")));

  const setPanel = await form(
    node({ panelAddressChoice: "stay", panelAddressChoiceBy: "node", panelAddressChoiceAt: "2026-11-12T17:50:00.000Z" }),
  );
  expect(setPanel).toContain("set-panel");
  const joined = await form(
    node({ panelAddressChoice: "stay", panelAddressChoiceBy: "join", panelAddressChoiceAt: "2026-11-12T17:50:00.000Z" }),
  );
  expect(joined).toContain(html(t("nodes.form.panelAddressBy.join")));
  // The owner's own choice needs no note.
  const owner = await form(
    node({ panelAddressChoice: "stay", panelAddressChoiceBy: "owner", panelAddressChoiceAt: "2026-11-12T17:50:00.000Z" }),
  );
  for (const note of ["inspectedCertificate", "join"] as const) expect(owner).not.toContain(html(t(`nodes.form.panelAddressBy.${note}`)));
});

test("the panel node has no Panel address", async () => {
  const out = await form(node({ isPanelNode: true, panelAddress: "http://127.0.0.1:3000" }));
  expect(out).not.toContain(t("nodes.form.panelAddress"));
});

test("an offline node's row says why: the refused hello, else when it was last seen", async () => {
  const list = (values: Partial<NodeDetail>) =>
    renderStatic(
      () => (
        <TooltipProvider>
          <NodeTable onOpen={() => {}} />
        </TooltipProvider>
      ),
      [[nodes.list, {}, { nodes: [node(values)] }]],
    );
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const refused = await list({
    status: "offline",
    lastSeenAt: minutesAgo(30),
    rejectedHello: {
      reason: "AGENT_TOO_OLD",
      message: "This agent (0.2.1) is too old for this panel. It needs 0.2.5 or newer.",
      at: minutesAgo(3),
    },
  });
  expect(refused).toContain("Refused 3 min ago: This agent (0.2.1) is too old for this panel. It needs 0.2.5 or newer.");
  const away = await list({ status: "offline", lastSeenAt: minutesAgo(7) });
  expect(away).toContain("Last seen 7 min ago");
  const online = await list({ status: "online", lastSeenAt: minutesAgo(0) });
  expect(online).not.toContain("Last seen");
});

test("the node page says how long the node was away and why, for a week", async () => {
  const from = Date.parse("2026-11-12T17:39:00.000Z");
  const to = Date.parse("2026-11-12T17:46:00.000Z");
  const reason = 'dial panel: x509: certificate signed by unknown authority (issued by "Fortinet")';
  const detail = node({ lastOffline: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), reason, failedAttempts: 12 } });
  const out = await renderStatic(() => <LastOffline node={detail} now={to + 60_000} />);
  expect(out).toContain(html(t("nodes.sheet.lastOffline", { from: formatPointTime(from, true), to: formatPointTime(to, false), reason })));
  expect(out).toContain("Was offline from");
  expect(await renderStatic(() => <LastOffline node={detail} now={to + 8 * 86_400_000} />)).toBe("");
  expect(await renderStatic(() => <LastOffline node={node({})} now={to} />)).toBe("");
});
