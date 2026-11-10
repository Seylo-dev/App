// The MCP card's safety note and its per-tool setup: a tab per AI tool with
// a one-click install button where the tool has an install link (the panel
// builds them, apps/panel/src/modules/mcp/hosts.ts), one line on where the
// snippet goes, and the snippet itself.

import { slug } from "@seylo/brand";
import type { mcp, OpOutput } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { IconExternalLink, IconPlugConnected } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type MessageKey, t } from "../../../i18n/t";

export type McpInfo = OpOutput<typeof mcp.info>;

/** The hosts the card knows, in the order the panel lists them; others the panel adds come after. */
export const mcpHosts = ["claude-code", "claude-desktop", "cursor", "vscode", "codex", "gemini-cli", "goose"] as const;
type McpHost = (typeof mcpHosts)[number];
const installHosts = ["claude-desktop", "cursor", "vscode", "goose"] as const;
type InstallHost = (typeof installHosts)[number];

const known = (host: string): host is McpHost => (mcpHosts as readonly string[]).includes(host);

export function hostLabel(host: string): string {
  return known(host) ? t(`settingsKeys.mcp.hosts.${host}`) : host;
}

function installLabel(host: string): string {
  return (installHosts as readonly string[]).includes(host)
    ? t(`settingsKeys.mcp.install.${host as InstallHost}`)
    : t("settingsKeys.mcp.installIn", { host: hostLabel(host) });
}

/** What the safety note says for the two switches: its tone, title, text and where it links. */
export function safetyCopy(info: Pick<McpInfo, "askBeforeDestructive" | "readOnlyByDefault">): {
  tone: "info" | "warning";
  title: MessageKey;
  text: MessageKey;
  link: { to: "/approvals" | "/activity"; label: MessageKey };
} {
  const access = info.readOnlyByDefault ? "readOnly" : "write";
  const asks = info.askBeforeDestructive ? "Ask" : "NoAsk";
  return {
    tone: info.askBeforeDestructive && info.readOnlyByDefault ? "info" : "warning",
    title: `settingsKeys.mcp.safetyTitle.${access}`,
    text: `settingsKeys.mcp.safety.${access}${asks}`,
    link: info.askBeforeDestructive
      ? { to: "/approvals", label: "settingsKeys.mcp.approvalsLink" }
      : { to: "/activity", label: "settingsKeys.mcp.activityLink" },
  };
}

export function McpSafetyNote({ info }: { info: Pick<McpInfo, "askBeforeDestructive" | "readOnlyByDefault"> }) {
  const copy = safetyCopy(info);
  return (
    <Alert tone={copy.tone} title={t(copy.title)}>
      {t(copy.text)}{" "}
      <Link to={copy.link.to} className="font-medium underline">
        {t(copy.link.label)}
      </Link>
    </Alert>
  );
}

/**
 * A one-click install button. https links (a page that opens the app)
 * open in a new tab without a referrer, since the panel's URL is in the
 * link; app links (goose://) open the app from this tab.
 */
export function InstallLink({ host, href }: { host: string; href: string }) {
  const web = href.startsWith("https:");
  const Icon = web ? IconExternalLink : IconPlugConnected;
  return (
    <Button asChild size="sm" variant="primary" className="self-start">
      <a href={href} {...(web ? { target: "_blank", rel: "noreferrer" } : {})}>
        <Icon size={15} stroke={1.8} />
        {installLabel(host)}
      </a>
    </Button>
  );
}

export function McpHostSetup({ info }: { info: Pick<McpInfo, "snippets" | "installLinks"> }) {
  const hosts = [...mcpHosts.filter((h) => h in info.snippets), ...Object.keys(info.snippets).filter((h) => !known(h))];
  const [host, setHost] = useState(hosts[0] ?? "");
  const snippet = info.snippets[host];
  const link = info.installLinks[host];
  if (hosts.length === 0 || snippet === undefined) return null;
  return (
    <div className="flex flex-col gap-2">
      <Segmented value={host} onValueChange={setHost} aria-label={t("settingsKeys.mcp.host")} className="self-start">
        {hosts.map((h) => (
          <SegmentedItem key={h} value={h}>
            {hostLabel(h)}
          </SegmentedItem>
        ))}
      </Segmented>
      {link && <InstallLink host={host} href={link} />}
      {known(host) && <p className="m-0 text-[12.5px] text-muted-foreground">{t(`settingsKeys.mcp.hostHints.${host}`, { name: slug })}</p>}
      <CodeBlock code={snippet} tone="dark" maxHeight={260} />
    </div>
  );
}
