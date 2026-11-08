import { expect, test } from "bun:test";
import { settings } from "@seylo/ops";
import { renderStatic } from "../../../test/render";
import { LockChecklist } from "./lock-checklist";
import type { TailscaleStatus } from "./shared";

const status = {
  backendState: "Running",
  viaTailnet: true,
  serve: { state: "active", panelAnswers: true, url: "https://here.tail1234.ts.net", wanted: true },
} as unknown as TailscaleStatus;

const general = (over: Record<string, unknown> = {}) => ({
  name: "Acme",
  domain: "panel.acme.dev",
  domainStatus: { state: "active", message: "" },
  defaultNodeId: null,
  publicUrl: "https://panel.acme.dev",
  uptimeAllowInternalTargets: false,
  auditRetentionDays: null,
  domainNodes: [],
  ...over,
});

const access = (over: Record<string, unknown> = {}) => ({
  serveOnIp: true,
  agentPortOpen: true,
  onFailure: "reopen",
  panelPort: 3000,
  agentPort: 3443,
  actual: { ip: "open", agentPort: "open" },
  privatePaths: [{ kind: "tailnet", url: "https://here.tail1234.ts.net", working: true, since: null, usingNow: true }],
  blocked: [],
  agentPortBlocked: [],
  reclosesAt: null,
  lastChange: null,
  recovery: { sshTunnel: "ssh -L 3000:127.0.0.1:3000 root@203.0.113.10", cli: "sudo seylo panel ip-access on" },
  ...over,
});

const render = (generalState: Record<string, unknown>, accessState: Record<string, unknown>) =>
  renderStatic(
    () => <LockChecklist status={status} />,
    [
      [settings.general, {}, generalState],
      [settings.panelAccess, {}, accessState],
    ],
  );

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

test("the domain row names the nodes that connect over it and go offline without it", async () => {
  const out = text(
    await render(
      general({
        domainNodes: [
          { id: "node00000000000b", name: "b1" },
          { id: "node00000000000c", name: "c1" },
        ],
      }),
      access(),
    ),
  );
  expect(out).toContain("Remove the panel domain panel.acme.dev");
  expect(out).toContain("b1 and c1 connect over https://panel.acme.dev and go offline without it.");
  expect(out).toContain("join it again with a new command from Nodes > Add node (--force)");

  const none = text(await render(general(), access()));
  expect(none).toContain("Remove the panel domain panel.acme.dev");
  expect(none).not.toContain("go offline without it");
});

test("the agents' port row says it stays open when only the panel node's own agent holds it", async () => {
  const message = "here, the panel's own node, connects over https://203.0.113.10:3443 instead of 127.0.0.1.";
  const out = text(
    await render(general(), access({ agentPortBlocked: [{ code: "panelNodeNotLoopback", message, nodeIds: ["node00000000000a"] }] })),
  );
  expect(out).toContain("The agents' port 3443 stays open");
  expect(out).toContain(message);
  expect(out).not.toContain("closes too");

  // Nothing holds it: it closes with IP access.
  expect(text(await render(general(), access()))).toContain("The agents' port 3443 closes too: no other node connects over it");
});
