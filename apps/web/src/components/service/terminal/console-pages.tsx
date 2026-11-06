// The Console (main process output + stdin) and Shell (a PTY in a running
// container) tabs, and the pre-logged-in database shell. All three share
// TerminalPanel; only the ticket op and the keyboard mode differ.

import { databases, terminals } from "@seylo/ops";
import { useOpClient } from "@seylo/ops/react";
import { cn } from "@seylo/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useMemo, useRef } from "react";
import { t } from "../../../i18n/t";
import type { ServiceDetail } from "../use-service";
import { TerminalPanel } from "./terminal-panel";

/**
 * The note written into the terminal when it connects. Older agents send no
 * user or working folder (empty strings), so those parts are left out.
 */
export function connectedNote(name: string, info: { generation: number; user: string; workdir: string }, idle: string): string {
  const parts = [t("serviceTerminal.connected", { name, generation: info.generation })];
  if (info.user) parts.push(t("serviceTerminal.connectedAs", { user: info.user }));
  if (info.workdir) parts.push(t("serviceTerminal.connectedIn", { workdir: info.workdir }));
  return `${parts.join(" ")} · ${t("serviceTerminal.connectedIdle", { idle })}`;
}

function idleText(seconds: number): string {
  return seconds >= 60
    ? t("serviceTerminal.idleMinutes", { count: Math.round(seconds / 60) })
    : t("serviceTerminal.idleSeconds", { count: seconds });
}

function Switcher({ service, current }: { service: ServiceDetail; current: "console" | "shell" }) {
  const item = (to: "console" | "shell", label: string) => (
    <Link
      to={to === "console" ? "/p/$projectId/s/$serviceId/console" : "/p/$projectId/s/$serviceId/shell"}
      params={{ projectId: service.projectId, serviceId: service.id }}
      aria-current={current === to ? "page" : undefined}
      className={cn(
        "rounded-chip px-3 py-[5px] text-[12.5px] font-medium",
        current === to ? "bg-terminal-field text-terminal-foreground" : "text-terminal-muted hover:text-terminal-foreground",
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label={t("serviceTerminal.switch")} className="flex gap-0.5 rounded-control bg-terminal p-[3px]">
      {item("console", t("service.tabs.console"))}
      {item("shell", t("service.tabs.shell"))}
    </nav>
  );
}

export function ConsolePage({ service }: { service: ServiceDetail }) {
  const client = useOpClient();
  const idle = useRef(0);
  const source = useMemo(
    () => ({
      open: async () => {
        const ticket = await client.call(terminals.openConsole, { serviceId: service.id, tail: 200 });
        idle.current = ticket.idleTimeoutSeconds;
        return ticket;
      },
    }),
    [client, service.id],
  );
  return (
    <TerminalPanel
      key={service.id}
      label={t("service.tabs.console")}
      switcher={<Switcher service={service} current="console" />}
      subtitle={t("serviceTerminal.consoleSubtitle")}
      source={source}
      describe={(info) => connectedNote(service.name, info, idleText(idle.current))}
      stdin
      fileName={`${service.name}-console.log`}
    />
  );
}

export function ShellPage({ service }: { service: ServiceDetail }) {
  const client = useOpClient();
  const idle = useRef(0);
  const source = useMemo(
    () => ({
      open: async (size: { columns: number; rows: number }) => {
        const ticket = await client.call(terminals.openShell, { serviceId: service.id, columns: size.columns, rows: size.rows });
        idle.current = ticket.idleTimeoutSeconds;
        return ticket;
      },
    }),
    [client, service.id],
  );
  return (
    <TerminalPanel
      key={service.id}
      label={t("service.tabs.shell")}
      switcher={<Switcher service={service} current="shell" />}
      subtitle={t("serviceTerminal.shellSubtitle")}
      source={source}
      describe={(info) => connectedNote(service.name, info, idleText(idle.current))}
      keyboard
      fileName={`${service.name}-shell.log`}
    />
  );
}

/** psql / mysql / mongosh / redis-cli, already signed in. */
export function DatabaseShell({ service, minHeight = 420 }: { service: ServiceDetail; minHeight?: number }) {
  const client = useOpClient();
  const clientName = useRef("");
  const source = useMemo(
    () => ({
      open: async () => {
        const ticket = await client.call(databases.openShell, { serviceId: service.id });
        clientName.current = ticket.client;
        return { url: ticket.socketPath, ticket: ticket.ticket };
      },
    }),
    [client, service.id],
  );
  return (
    <TerminalPanel
      label={t("serviceDatabase.shell")}
      switcher={<span className="px-2 text-[12.5px] font-medium text-terminal-foreground">{t("serviceDatabase.shell")}</span>}
      subtitle={t("serviceDatabase.shellSubtitle")}
      source={source}
      describe={() => t("serviceDatabase.shellConnected", { client: clientName.current, name: service.name })}
      keyboard
      fileName={`${service.name}-shell.log`}
      minHeight={minHeight}
    />
  );
}
