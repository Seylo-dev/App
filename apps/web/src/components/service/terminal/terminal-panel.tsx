// The dark terminal card of the Console tab and the Overview (Service.dc.html):
// a Console | Shell switch, a subtitle, search / pause / download / clear,
// the xterm view, and for the console a stdin line with Send. A new
// sessionKey (the switch moving from Console to Shell) closes the session
// and opens the next one in a fresh terminal, while the header and the
// switch stay put, so focus and the switch's sliding background stay too.

import { cn } from "@seylo/ui/lib/utils";
import { IconDownload, IconPlayerPause, IconPlayerPlay, IconSearch, IconTrash } from "@tabler/icons-react";
import { type FormEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { downloadText } from "../deploy-log";
import { isNotBuilt } from "../op-state";
import type { SessionState, TicketSource } from "./use-terminal-session";
import { useTerminalSession } from "./use-terminal-session";
import { type XtermHandle, XtermView } from "./xterm-view";

const cardClass =
  "flex flex-col overflow-hidden rounded-card bg-terminal shadow-[0_1px_2px_rgb(15_23_42/0.08),0_8px_24px_rgb(15_23_42/0.12)]";
const barClass = "flex flex-wrap items-center gap-1 bg-terminal-bar px-2.5 py-2";

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
  height,
  fill = false,
  start,
  actions,
  sessionKey = "",
  prefill,
  onPrefilled,
  onStdin,
  pendingLine,
  onPendingSent,
}: {
  label: string;
  /** The Console | Shell switch, or a title. */
  switcher: ReactNode;
  /** Left out where the header has no room for it (the Overview card); hidden on a phone. */
  subtitle?: string;
  source: TicketSource;
  describe: (info: { generation: number; user: string; workdir: string }) => string;
  /** Console: a line input that writes to the process's stdin. */
  stdin?: boolean;
  /** Shell: keystrokes go straight to the PTY. */
  keyboard?: boolean;
  fileName: string;
  /** Without `height`: the least height; the card grows with the terminal's rows, or with `fill` with the page. */
  minHeight?: number;
  /** A fixed height (the Overview card). */
  height?: number;
  /**
   * Fills the rest of the page, at least minHeight (the Console tab). With
   * `height` or `fill` the card's height never depends on the mode: the
   * stdin line takes its room from the terminal, which fits what is left.
   */
  fill?: boolean;
  /** When set, the session waits for a click on a button with this label instead of opening by itself. */
  start?: string;
  /** After the header's buttons, for example "Open full". */
  actions?: ReactNode;
  /** Which session this is: a new value closes the open one and starts the next in a fresh terminal. */
  sessionKey?: string;
  /** Typed once the shell says it is ready, without Enter: the person reads it and runs it (node-shell.tsx). */
  prefill?: string;
  onPrefilled?: () => void;
  /** Takes a stdin line instead of the session (a watched console, which sends nothing): it opens the session that does. */
  onStdin?: (line: string) => void;
  /** A stdin line sent once the session is ready, with Enter, as if typed (the line that opened it). */
  pendingLine?: string;
  onPendingSent?: () => void;
}) {
  const session = useTerminalSession(source, describe);
  const view = useRef<XtermHandle | null>(null);
  const [paused, setPaused] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [line, setLine] = useState("");
  const stdinId = useId();
  const { connect, input, reset } = session;

  // A new session starts with the controls as they are for a new terminal.
  const [shownKey, setShownKey] = useState(sessionKey);
  if (shownKey !== sessionKey) {
    setShownKey(sessionKey);
    setPaused(false);
    setSearching(false);
    setQuery("");
    setLine("");
  }

  const prefilled = useRef(false);
  // The old session closes as the key changes, before the new terminal mounts,
  // so nothing of it reaches the new one; leaving the page closes it too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cleanup is meant to run when sessionKey changes.
  useLayoutEffect(
    () => () => {
      prefilled.current = false;
      reset();
    },
    [sessionKey, reset],
  );
  const shellReady = session.state.status === "ready" && session.state.info !== null;
  useEffect(() => {
    if (!prefill || prefilled.current || !shellReady) return;
    prefilled.current = true;
    // Never an Enter: line breaks would run what comes before them.
    input(prefill.replace(/[\r\n]/g, ""));
    onPrefilled?.();
  }, [prefill, shellReady, input, onPrefilled]);
  // The pending line waits for a session that became ready after it was set:
  // in the render that sets it, the session it replaces may still look ready.
  const pendingFrom = useRef<{ line: string; state: SessionState } | null>(null);
  const sessionState = session.state;
  useEffect(() => {
    if (pendingLine === undefined) {
      pendingFrom.current = null;
      return;
    }
    if (pendingFrom.current?.line !== pendingLine) pendingFrom.current = { line: pendingLine, state: sessionState };
    if (!shellReady || sessionState === pendingFrom.current.state) return;
    pendingFrom.current = null;
    input(`${pendingLine}\n`);
    view.current?.write(`\x1b[33m> ${pendingLine}\x1b[0m\r\n`);
    onPendingSent?.();
  }, [pendingLine, shellReady, sessionState, input, onPendingSent]);

  // Connect once the terminal exists (its size goes into the ticket request),
  // and again for each new terminal of a new session; with `start`, only
  // when its button is clicked. Read from a ref: a change of `start` alone
  // (it comes with a new session) must not open a second ticket.
  const waits = useRef(start !== undefined);
  waits.current = start !== undefined;
  const [views, setViews] = useState(0);
  useEffect(() => {
    if (views > 0 && !waits.current) void connect();
  }, [views, connect]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!line) return;
    if (onStdin) onStdin(line);
    else {
      session.input(`${line}\n`);
      view.current?.write(`\x1b[33m> ${line}\x1b[0m\r\n`);
    }
    setLine("");
  };

  const state = session.state;
  const iconButton =
    "flex cursor-pointer rounded-chip border-0 bg-transparent p-[7px] text-terminal-muted hover:text-terminal-foreground aria-pressed:text-terminal-foreground";
  // A fixed or filling card: the terminal fits the room the header and the stdin line leave, and never sets the card's height.
  const fixed = height !== undefined || fill;
  const where = state.status === "ready" && state.info && (state.info.user || state.info.workdir) ? state.info : null;

  const xterm = (
    <XtermView
      // Console and Shell differ in xterm options that are set once (stdin, cursor, line endings): a new session gets a new terminal.
      key={sessionKey}
      aria-label={label}
      className={fixed ? "absolute inset-0" : "flex-1"}
      onData={keyboard ? (d) => session.input(d) : undefined}
      onResize={keyboard ? (size) => session.resize(size) : undefined}
      onReady={(h) => {
        view.current = h;
        session.attach(h);
        setViews((n) => n + 1);
      }}
    />
  );

  return (
    <section
      aria-label={label}
      className={cn(cardClass, height === undefined && fill && "flex-1")}
      style={height !== undefined ? { height } : { minHeight }}
    >
      <div className={barClass}>
        {switcher}
        {/*
          The subtitle and the user:folder chip share what the switch and the
          buttons leave (flex-basis 0, the subtitle gives way first), so the
          chip showing up as a shell connects never pushes the buttons onto a
          second row.
        */}
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden pl-2.5">
          {subtitle && (
            <span title={subtitle} className="hidden min-w-0 shrink-[16] truncate text-xs text-terminal-muted sm:block">
              {subtitle}
            </span>
          )}
          {where && (
            <span
              title={t("serviceTerminal.where")}
              className="min-w-0 max-w-[40ch] truncate rounded-chip bg-terminal-field px-2 py-0.5 font-mono text-[11.5px] text-terminal-foreground"
            >
              {where.user && <span className="text-terminal-prompt">{where.user}</span>}
              {where.user && where.workdir && <span className="text-terminal-muted">:</span>}
              {where.workdir}
            </span>
          )}
        </div>
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
              className="h-7 w-32 rounded-chip border-0 bg-terminal-field px-2 font-mono text-xs text-terminal-foreground outline-none placeholder:text-terminal-muted sm:w-48"
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
          {actions}
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col px-[18px] pt-4 pb-2">
        {fixed ? <div className="relative min-h-0 flex-1">{xterm}</div> : xterm}
        {start !== undefined && state.status === "idle" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <button
              type="button"
              onClick={() => void session.connect()}
              className="cursor-pointer rounded-chip border-0 bg-primary px-3.5 py-[7px] text-[12.5px] font-medium text-primary-foreground transition-interactive hover:bg-primary-hover"
            >
              {start}
            </button>
          </div>
        )}
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
        <form
          onSubmit={send}
          className="mx-2.5 mb-2.5 flex shrink-0 items-center gap-2.5 rounded-control bg-terminal-bar py-1.5 pr-1.5 pl-3"
        >
          <label htmlFor={stdinId} className="font-mono text-[13px] text-terminal-prompt">
            &gt;
          </label>
          <input
            id={stdinId}
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

/**
 * A terminal-shaped card with no session: the same dark card and header
 * (the switch, no buttons) with one line in the middle. The Overview shows
 * it while nothing runs yet, at the console card's height, so the page never
 * moves when the app starts.
 */
export function TerminalNote({
  label,
  switcher,
  height,
  children,
}: {
  label: string;
  switcher: ReactNode;
  height: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className={cardClass} style={{ height }}>
      <div className={barClass}>{switcher}</div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[12.5px] text-terminal-muted">{children}</div>
    </section>
  );
}
