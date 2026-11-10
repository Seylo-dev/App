import { expect, test } from "bun:test";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import { InstallLink, McpHostSetup, McpSafetyNote, mcpHosts, safetyCopy } from "./mcp-setup";

const cursor = "https://cursor.com/en/install-mcp?name=seylo&config=eyJ1cmwiOiJodHRwczovL3BhbmVsLmFjbWUuZGV2L21jcCJ9";
const goose = "goose://extension?url=https%3A%2F%2Fpanel.acme.dev%2Fmcp&type=streamable_http&id=seylo&name=seylo";

test("install buttons: https pages open in a new tab without a referrer, app links open the app here", async () => {
  const web = await renderStatic(() => <InstallLink host="cursor" href={cursor} />);
  expect(web).toContain(`href="${cursor.replaceAll("&", "&amp;")}"`);
  expect(web).toContain('target="_blank"');
  expect(web).toContain('rel="noreferrer"');
  expect(web).toContain("Add to Cursor");
  const app = await renderStatic(() => <InstallLink host="goose" href={goose} />);
  expect(app).toContain(`href="${goose.replaceAll("&", "&amp;")}"`);
  expect(app).not.toContain("target=");
  expect(app).toContain("Add to goose");
  // A host the card does not know yet still gets a labelled button.
  expect(await renderStatic(() => <InstallLink host="zed" href="https://zed.dev/x" />)).toContain("Install in zed");
});

test("the setup opens on Claude Code: its command and where it goes, no button, every known tool as a tab", async () => {
  const snippets = Object.fromEntries(mcpHosts.map((host) => [host, `${host} snippet`]));
  const html = await renderStatic(() => <McpHostSetup info={{ snippets, installLinks: { cursor } }} />);
  for (const host of mcpHosts) expect(html).toContain(`>${t(`settingsKeys.mcp.hosts.${host}`)}<`);
  expect(html).toContain("claude-code snippet");
  expect(html).toContain("then run /mcp in Claude Code and pick seylo to sign in.");
  expect(html).not.toContain("Add to Cursor");
});

test("the safety note follows both switches", async () => {
  expect(safetyCopy({ askBeforeDestructive: true, readOnlyByDefault: true })).toEqual({
    tone: "info",
    title: "settingsKeys.mcp.safetyTitle.readOnly",
    text: "settingsKeys.mcp.safety.readOnlyAsk",
    link: { to: "/approvals", label: "settingsKeys.mcp.approvalsLink" },
  });
  expect(safetyCopy({ askBeforeDestructive: false, readOnlyByDefault: true })).toMatchObject({
    tone: "warning",
    title: "settingsKeys.mcp.safetyTitle.readOnly",
    text: "settingsKeys.mcp.safety.readOnlyNoAsk",
    link: { to: "/activity" },
  });
  expect(safetyCopy({ askBeforeDestructive: true, readOnlyByDefault: false })).toMatchObject({
    tone: "warning",
    title: "settingsKeys.mcp.safetyTitle.write",
    text: "settingsKeys.mcp.safety.writeAsk",
    link: { to: "/approvals" },
  });
  expect(safetyCopy({ askBeforeDestructive: false, readOnlyByDefault: false })).toMatchObject({
    title: "settingsKeys.mcp.safetyTitle.write",
    text: "settingsKeys.mcp.safety.writeNoAsk",
  });

  const safe = await renderStatic(() => <McpSafetyNote info={{ askBeforeDestructive: true, readOnlyByDefault: true }} />);
  expect(safe).toContain("Read-only by default");
  expect(safe).toContain('href="/approvals"');
  const open = await renderStatic(() => <McpSafetyNote info={{ askBeforeDestructive: false, readOnlyByDefault: false }} />);
  expect(open).toContain("Changes allowed by default");
  expect(open).toContain('href="/activity"');
  expect(open).not.toContain("Open Approvals");
});
