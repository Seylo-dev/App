// The dark terminal card of the Console and Shell tabs (Service.dc.html):
// a Console | Shell switch, a subtitle, search / pause / download / clear,
// the xterm view, and for the console a stdin line with Send.

import { cn } from "@seylo/ui/lib/utils";
import { IconDownload, IconPlayerPause, IconPlayerPlay, IconSearch, IconTrash } from "@tabler/icons-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { downloadText } from "../deploy-log";
import { isNotBuilt } from "../op-state";
import type { TicketSource } from "./use-terminal-session";
import { useTerminalSession } from "./use-terminal-session";
import { type XtermHandle, XtermView } from "./xterm-view";

export function TerminalPanel({
  label,
  switcher,
  subtitle,
  source,
  describe,
  stdin = false,
  keyboard = false,
  fileName,
  minHeight = 520,
}: {
  label: string;
  /** Console | Shell links, or a title. */
  switcher: ReactNode;
  subtitle: string;
  source: TicketSource;
  describe: (info: { generation: number; user: string; workdir: string }) => string;
  /** Console: a line input that writes to the process's stdin. */
  stdin?: boolean;
  /** Shell: keystrokes go straight to the PTY. */
  keyboard?: boolean;
  fileName: string;
  minHeight?: number;
}) {
  const session = useTerminalSession(source, describe);
  const view = useRef<XtermHandle | null>(null);
  const [paused, setPaused] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [line, setLine] = useState("");
  const { connect } = session;

  // Connect once the terminal exists (its size goes into the ticket request).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (mounted) void connect();
  }, [mounted, connect]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!line) return;
    session.input(`${line}\n`);
    view.current?.write(`\x1b[33m> ${line}\x1b[0m\r\n`);
    setLine("");
  };

  const state = session.state;
  const iconButton =
    "flex cursor-pointer rounded-chip border-0 bg-transparent p-[7px] text-terminal-muted hover:text-terminal-foreground aria-pressed:text-terminal-foreground";

  return (
    <section
      aria-label={label}
      className="flex flex-col overflow-hidden rounded-card bg-terminal shadow-[0_1px_2px_rgb(15_23_42/0.08),0_8px_24px_rgb(15_23_42/0.12)]"
      style={{ minHeight }}
    >
      <div className="flex flex-wrap items-center gap-1 bg-terminal-bar px-2.5 py-2">
        {switcher}
        <span className="ml-2.5 text-xs text-terminal-muted">{subtitle}</span>
        {state.status === "ready" && state.info && (state.info.user || state.info.workdir) && (
          <span
            title={t("serviceTerminal.where")}
            className="ml-2 inline-flex max-w-[40ch] items-center gap-1 truncate rounded-chip bg-terminal-field px-2 py-0.5 font-mono text-[11.5px] text-terminal-foreground"
          >
            {state.info.user && <span className="text-terminal-prompt">{state.info.user}</span>}
            {state.info.user && state.info.workdir && <span className="text-terminal-muted">:</span>}
            {state.info.workdir && <span className="truncate">{state.info.workdir}</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {searching && (
            <input
              aria-label={t("serviceTerminal.search")}
              // biome-ignore lint/a11y/noAutofocus: opened by the search button on purpose
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (e.shiftKey) view.current?.findPrevious(query);
                  else view.current?.findNext(query);
                }
                if (e.key === "Escape") {
                  setSearching(false);
                  view.current?.clearSearch();
                }
              }}
              placeholder={t("serviceTerminal.searchPlaceholder")}
              className="h-7 w-48 rounded-chip border-0 bg-terminal-field px-2 font-mono text-xs text-terminal-foreground outline-none placeholder:text-terminal-muted"
            />
          )}
          <button
            type="button"
            aria-label={t("serviceTerminal.search")}
            aria-pressed={searching}
            className={iconButton}
            onClick={() => {
              setSearching((v) => !v);
              view.current?.clearSearch();
            }}
          >
            <IconSearch size={15} stroke={1.8} />
          </button>
          <button
            type="button"
            aria-label={paused ? t("serviceTerminal.resume") : t("serviceTerminal.pause")}
            aria-pressed={paused}
            className={iconButton}
            onClick={() => {
              view.current?.setPaused(!paused);
              setPaused(!paused);
            }}
          >
            {paused ? <IconPlayerPlay size={15} stroke={1.8} /> : <IconPlayerPause size={15} stroke={1.8} />}
          </button>
          <button
            type="button"
            aria-label={t("serviceTerminal.download")}
            className={iconButton}
            onClick={() => downloadText(fileName, view.current?.text() ?? "")}
          >
            <IconDownload size={15} stroke={1.8} />
          </button>
          <button type="button" aria-label={t("serviceTerminal.clear")} className={iconButton} onClick={() => view.current?.clear()}>
            <IconTrash size={15} stroke={1.8} />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col px-[18px] pt-4 pb-2">
        <XtermView
          aria-label={label}
          className="flex-1"
          scrollback={keyboard ? 10_000 : 100_000}
          onData={keyboard ? (d) => session.input(d) : undefined}
          onResize={keyboard ? (size) => session.resize(size) : undefined}
          onReady={(h) => {
            view.current = h;
            session.attach(h);
            setMounted(true);
          }}
        />
        {(state.status === "error" || state.status === "closed" || state.status === "connecting") && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <div className="pointer-events-auto flex max-w-[90%] flex-wrap items-center gap-3 rounded-control bg-terminal-bar px-4 py-2.5 text-[12.5px] text-terminal-foreground shadow-popover">
              {state.status === "connecting" && <span className="text-terminal-muted">{t("serviceTerminal.connecting")}</span>}
              {state.status === "closed" && <span>{state.reason}</span>}
              {state.status === "error" && (
                <span>
                  {isNotBuilt(state.error) ? t("service.notBuilt.title") : errorMessage(state.error, t("serviceTerminal.failed"))}
                </span>
              )}
              {state.status !== "connecting" && (
                <button
                  type="button"
                  onClick={() => void session.connect()}
                  className="cursor-pointer rounded-chip border-0 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                >
                  {t("serviceTerminal.reconnect")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {stdin && (
        <form onSubmit={send} className="mx-2.5 mb-2.5 flex items-center gap-2.5 rounded-control bg-terminal-bar py-1.5 pr-1.5 pl-3">
          <label htmlFor="console-stdin" className="font-mono text-[13px] text-terminal-prompt">
            &gt;
          </label>
          <input
            id="console-stdin"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            disabled={state.status !== "ready"}
            placeholder={t("serviceTerminal.stdinPlaceholder")}
            autoComplete="off"
            className="h-[30px] min-w-0 flex-1 border-0 bg-transparent font-mono text-[13px] text-terminal-foreground outline-none placeholder:text-terminal-muted"
          />
          <button
            type="submit"
            disabled={state.status !== "ready" || !line}
            className={cn(
              "cursor-pointer rounded-chip border-0 bg-primary px-3.5 py-[7px] text-[12.5px] font-medium text-primary-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {t("serviceTerminal.send")}
          </button>
        </form>
      )}
    </section>
  );
}
