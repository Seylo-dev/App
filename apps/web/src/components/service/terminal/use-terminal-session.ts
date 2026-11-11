// One terminal session over a ticketed WebSocket: binary frames are
// terminal bytes, text frames are JSON control messages (terminals.ts in
// @seylo/ops). Used by the Console tab in both modes, the Overview's console card, database and host shells.

import type { terminals } from "@seylo/ops";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { openSocket, withTicket } from "../socket";
import type { XtermHandle } from "./xterm-view";

type ServerMessage = (typeof terminals.TerminalServerMessage)["static"];
type ClientMessage = (typeof terminals.TerminalClientMessage)["static"];

export type SessionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "ready"; info: { containerId: string; generation: number; user: string; workdir: string } | null }
  | { status: "closed"; reason: string }
  | { status: "error"; error: unknown };

export interface TicketSource {
  /** Asks the panel for a ticket and returns the socket path (with or without ?t=) and ticket. */
  open: (size: { columns: number; rows: number }) => Promise<{ url: string; ticket: string }>;
}

const encoder = new TextEncoder();

/** How long a console keeps trying to reach the new process after the old one exited (a restart, a deploy). */
export const followExitForMs = 2 * 60_000;
const followFirstDelayMs = 1000;
const followMaxDelayMs = 8000;

/**
 * The next try while following an exit: how long to wait and the wait
 * after it (doubling to followMaxDelayMs), or null once the window
 * (until) has passed or never opened.
 */
export function followStep(f: { until: number; delay: number }, now: number): { wait: number; nextDelay: number } | null {
  if (f.until === 0 || now >= f.until) return null;
  return { wait: f.delay, nextDelay: Math.min(followMaxDelayMs, f.delay * 2) };
}

/**
 * options.followExit (the console): when the process exits, the session
 * opens again by itself, first after a second, then backing off to 8 s,
 * for up to 2 minutes, so a restart or a deploy lands on the new process
 * without a click. A shell never does: there an exit is someone typing exit.
 */
export function useTerminalSession(
  source: TicketSource,
  describe: (info: { generation: number; user: string; workdir: string }) => string,
  options: { followExit?: boolean } = {},
) {
  const [state, setState] = useState<SessionState>({ status: "idle" });
  const socket = useRef<WebSocket | null>(null);
  const term = useRef<XtermHandle | null>(null);
  const latest = useRef({ source, describe });
  latest.current = { source, describe };
  // Bumped by every close: a ticket that arrives after the session was closed
  // (the page was left, the mode switched, a newer connect started) opens no socket.
  const attempt = useRef(0);
  const followExit = useRef(options.followExit ?? false);
  followExit.current = options.followExit ?? false;
  // Following the process after it exited: until when, the next wait, and the pending try.
  const follow = useRef<{ until: number; delay: number; timer: ReturnType<typeof setTimeout> | null }>({
    until: 0,
    delay: followFirstDelayMs,
    timer: null,
  });

  const close = useCallback(() => {
    attempt.current++;
    if (follow.current.timer) clearTimeout(follow.current.timer);
    follow.current.timer = null;
    const ws = socket.current;
    socket.current = null;
    ws?.close();
  }, []);

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  // Tries again after the current wait while following an exit; false once the 2 minutes are over.
  const followAgain = useRef<(mine: number) => boolean>(() => false);

  const connect = useCallback(
    async (following = false) => {
      close();
      if (!following) follow.current = { until: 0, delay: followFirstDelayMs, timer: null };
      const mine = attempt.current;
      setState({ status: "connecting" });
      const size = term.current?.size() ?? { columns: 120, rows: 32 };
      let target: { url: string; ticket: string };
      try {
        target = await latest.current.source.open(size);
      } catch (error) {
        if (attempt.current !== mine) return;
        // The new process is not up yet (no running container): wait and ask again.
        if (following && followAgain.current(mine)) return;
        setState({ status: "error", error });
        return;
      }
      if (attempt.current !== mine) return;
      const ws = openSocket(withTicket(target.url, target.ticket));
      socket.current = ws;
      let exited = false;
      ws.onmessage = (event) => {
        if (socket.current !== ws) return;
        if (typeof event.data !== "string") {
          term.current?.write(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === "ready") {
          // On the new process: the next exit is followed from the start again.
          follow.current = { until: 0, delay: followFirstDelayMs, timer: null };
          setState({ status: "ready", info: message });
          term.current?.note(latest.current.describe(message));
          const now = term.current?.size();
          if (now) send({ type: "resize", columns: now.columns, rows: now.rows });
        } else if (message.type === "exit") {
          exited = true;
          term.current?.note(t("serviceTerminal.exited", { code: message.exitCode }));
        } else if (message.type === "closed") {
          term.current?.note(message.reason);
        }
      };
      ws.onopen = () => setState((s) => (s.status === "connecting" ? { status: "ready", info: null } : s));
      ws.onclose = (event) => {
        if (socket.current !== ws) return;
        socket.current = null;
        // The console's process exited (a restart, a deploy): go after the new one.
        if (exited && followExit.current) {
          if (follow.current.until === 0) follow.current.until = Date.now() + followExitForMs;
          if (followAgain.current(attempt.current)) return;
        }
        const reason = event.reason || t("serviceTerminal.disconnected");
        setState({ status: "closed", reason });
      };
    },
    [close, send],
  );

  followAgain.current = (mine: number) => {
    const f = follow.current;
    const step = followStep(f, Date.now());
    if (!step) return false;
    const wait = step.wait;
    f.delay = step.nextDelay;
    setState({ status: "closed", reason: t("serviceTerminal.reconnecting") });
    f.timer = setTimeout(() => {
      f.timer = null;
      // Left the page, switched mode or clicked Reconnect meanwhile: that wins.
      if (attempt.current === mine) void connect(true);
    }, wait);
    return true;
  };

  /** Keystrokes or a line of stdin, as binary frames. */
  const input = useCallback((data: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
  }, []);

  /** Closes the session and forgets its state, for a new session in the same panel (Console to Shell). */
  const reset = useCallback(() => {
    close();
    setState({ status: "idle" });
  }, [close]);

  useEffect(() => close, [close]);

  return {
    state,
    connect,
    close,
    reset,
    input,
    resize: (size: { columns: number; rows: number }) => send({ type: "resize", ...size }),
    attach: (handle: XtermHandle) => {
      term.current = handle;
    },
  };
}
