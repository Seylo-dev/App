// One terminal session over a ticketed WebSocket: binary frames are
// terminal bytes, text frames are JSON control messages (terminals.ts in
// @seylo/ops). Used by the Console, the Shell and database shells.

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

export function useTerminalSession(
  source: TicketSource,
  describe: (info: { generation: number; user: string; workdir: string }) => string,
) {
  const [state, setState] = useState<SessionState>({ status: "idle" });
  const socket = useRef<WebSocket | null>(null);
  const term = useRef<XtermHandle | null>(null);
  const latest = useRef({ source, describe });
  latest.current = { source, describe };

  const close = useCallback(() => {
    const ws = socket.current;
    socket.current = null;
    ws?.close();
  }, []);

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  const connect = useCallback(async () => {
    close();
    setState({ status: "connecting" });
    const size = term.current?.size() ?? { columns: 120, rows: 32 };
    let target: { url: string; ticket: string };
    try {
      target = await latest.current.source.open(size);
    } catch (error) {
      setState({ status: "error", error });
      return;
    }
    const ws = openSocket(withTicket(target.url, target.ticket));
    socket.current = ws;
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
        setState({ status: "ready", info: message });
        term.current?.note(latest.current.describe(message));
        const now = term.current?.size();
        if (now) send({ type: "resize", columns: now.columns, rows: now.rows });
      } else if (message.type === "exit") {
        term.current?.note(t("serviceTerminal.exited", { code: message.exitCode }));
      } else if (message.type === "closed") {
        term.current?.note(message.reason);
      }
    };
    ws.onopen = () => setState((s) => (s.status === "connecting" ? { status: "ready", info: null } : s));
    ws.onclose = (event) => {
      if (socket.current !== ws) return;
      socket.current = null;
      const reason = event.reason || t("serviceTerminal.disconnected");
      setState({ status: "closed", reason });
    };
  }, [close, send]);

  /** Keystrokes or a line of stdin, as binary frames. */
  const input = useCallback((data: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
  }, []);

  useEffect(() => close, [close]);

  return {
    state,
    connect,
    close,
    input,
    resize: (size: { columns: number; rows: number }) => send({ type: "resize", ...size }),
    attach: (handle: XtermHandle) => {
      term.current = handle;
    },
  };
}
