// A service's terminal: the Console tab (console or shell mode, the mode in
// ?mode=shell), the Overview's console card, and the pre-logged-in database
// shell. All share TerminalPanel. The console attaches to the main process
// (its output, and stdin a line at a time); the shell is a new PTY inside a
// running container. The Console | Shell switch changes the mode in place:
// the open session closes and the other one opens in the same card.

import { databases, terminals } from "@seylo/ops";
import { useOpClient } from "@seylo/ops/react";
import { Card } from "@seylo/ui/components/card";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { IconLock } from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useMemo, useRef } from "react";
import { t } from "../../../i18n/t";
import { TerminalSkeleton } from "../service-skeletons";
import type { ServiceDetail } from "../use-service";
import { pickMode, type TerminalMode, useTerminalModes } from "./access";
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

/**
 * Console | Shell in the terminal header. It changes the mode in place (no
 * page change); the current item's background slides to the one you pick,
 * like every other tab group. With one allowed mode it is just its name.
 */
export function ModeSwitch({
  mode,
  modes,
  onChange,
}: {
  mode: TerminalMode;
  modes: readonly TerminalMode[];
  onChange: (mode: TerminalMode) => void;
}) {
  if (modes.length < 2)
    return <span className="px-2 text-[12.5px] font-medium text-terminal-foreground">{t(`serviceTerminal.modes.${mode}`)}</span>;
  return (
    <Segmented
      tone="terminal"
      aria-label={t("serviceTerminal.switch")}
      value={mode}
      onValueChange={(next) => onChange(next as TerminalMode)}
    >
      {modes.map((m) => (
        <SegmentedItem key={m} value={m} className="px-3 font-medium">
          {t(`serviceTerminal.modes.${m}`)}
        </SegmentedItem>
      ))}
    </Segmented>
  );
}

/** The Console tab's least height: on a short window the stdin line still shows without much scrolling. */
export const consoleMinHeight = 440;

/** The Console tab while the service or the person's modes load: the terminal's shape at the tab's size. */
export function ConsoleSkeleton() {
  return <TerminalSkeleton minHeight={consoleMinHeight} />;
}

/** One service's terminal in console or shell mode, with the switch; a new mode is a new session in the same card. */
export function ServiceTerminal({
  service,
  mode,
  modes,
  onModeChange,
  height,
  fill = false,
  start,
  actions,
  subtitle = true,
}: {
  service: ServiceDetail;
  mode: TerminalMode;
  modes: readonly TerminalMode[];
  onModeChange: (mode: TerminalMode) => void;
  /** A fixed height (the Overview card); else see `fill`. */
  height?: number;
  /** Fills the rest of the page (the Console tab), the same height in both modes. */
  fill?: boolean;
  /** Waits for a click on a button with this label before it opens a session. */
  start?: string;
  actions?: ReactNode;
  /** The one-line description next to the switch. */
  subtitle?: boolean;
}) {
  const client = useOpClient();
  const idle = useRef(0);
  const shell = mode === "shell";
  const source = useMemo(
    () => ({
      open: async (size: { columns: number; rows: number }) => {
        // Console: attach to the main process. Shell: a new PTY sized like the terminal.
        const ticket = shell
          ? await client.call(terminals.openShell, { serviceId: service.id, columns: size.columns, rows: size.rows })
          : await client.call(terminals.openConsole, { serviceId: service.id, tail: 200 });
        idle.current = ticket.idleTimeoutSeconds;
        return ticket;
      },
    }),
    [client, service.id, shell],
  );
  return (
    <TerminalPanel
      sessionKey={mode}
      label={t(`serviceTerminal.modes.${mode}`)}
      switcher={<ModeSwitch mode={mode} modes={modes} onChange={onModeChange} />}
      subtitle={subtitle ? t(shell ? "serviceTerminal.shellSubtitle" : "serviceTerminal.consoleSubtitle") : undefined}
      source={source}
      describe={(info) => connectedNote(service.name, info, idleText(idle.current))}
      stdin={!shell}
      keyboard={shell}
      fileName={`${service.name}-${mode}.log`}
      height={height}
      fill={fill}
      minHeight={consoleMinHeight}
      start={start}
      actions={actions}
    />
  );
}

/** For a person with neither terminals.console nor terminals.shell here. */
export function TerminalNoAccess() {
  return (
    <Card>
      <EmptyState compact icon={<IconLock />} title={t("serviceTerminal.noAccess")} />
    </Card>
  );
}

/** The Console tab: the terminal in the mode of ?mode= (console when left out). */
export function ConsolePage({ service }: { service: ServiceDetail }) {
  const search = useSearch({ from: "/_app/p/$projectId/s/$serviceId/console" });
  const navigate = useNavigate({ from: "/p/$projectId/s/$serviceId/console" });
  const modes = useTerminalModes(service);
  if (!modes) return <ConsoleSkeleton />;
  const mode = pickMode(search.mode ?? "console", modes);
  if (!mode) return <TerminalNoAccess />;
  return (
    <ServiceTerminal
      key={service.id}
      service={service}
      mode={mode}
      modes={modes}
      fill
      // The mode lives in the URL, so links and reloads keep it; switching replaces the entry, like a filter.
      onModeChange={(next) =>
        void navigate({ search: (prev) => ({ ...prev, mode: next === "shell" ? "shell" : undefined }), replace: true })
      }
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
