// One terminal session over a ticketed WebSocket for the terminal card:
// session.ts holds the attempts, the socket and the console's retries; this
// hook gives it React state and the page's nudges. Used by the Console tab
// in both modes, the Overview's console card, database and host shells.

import { useEffect, useRef, useState } from "react";
import { live } from "../../../lib/live";
import { openSocket } from "../socket";
import { type ConsoleFollow, createTerminalSession, type SessionState, type TicketSource } from "./session";
import type { XtermHandle } from "./xterm-view";

export type { ConsoleFollow, SessionState, TicketSource } from "./session";

const tabHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * options.follow (the console): the session follows the service's live
 * status (createTerminalSession in session.ts). Each change of what runs or
 * of its generation, the browser tab becoming visible again, the network
 * and the panel's live socket coming back nudge it. A shell never follows.
 */
export function useTerminalSession(
  source: TicketSource,
  describe: (info: { generation: number; user: string; workdir: string }) => string,
  options: { follow?: ConsoleFollow } = {},
) {
  const [state, setState] = useState<SessionState>({ status: "idle" });
  const term = useRef<XtermHandle | null>(null);
  const latest = useRef({ source, describe, follow: options.follow });
  latest.current = { source, describe, follow: options.follow };
  const [session] = useState(() =>
    createTerminalSession({
      setState,
      source: () => latest.current.source,
      describe: (info) => latest.current.describe(info),
      follow: () => latest.current.follow,
      term: () => term.current,
      openSocket,
      hidden: tabHidden,
    }),
  );

  const run = options.follow?.run;
  const key = options.follow?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a nudge for each change of what runs or of its generation.
  useEffect(() => session.nudge(false), [run, key]);

  const following = options.follow !== undefined;
  useEffect(() => {
    if (!following) return;
    const visible = () => {
      if (document.visibilityState === "visible") session.nudge(true);
    };
    const online = () => session.nudge(true);
    // The panel's live socket back (a panel restart, the network): the panel answers again.
    const liveUp = () => {
      if (live.isUp()) session.nudge(true);
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    const stopLive = live.onUpChange(liveUp);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
      stopLive();
    };
  }, [following, session]);

  useEffect(() => session.close, [session]);

  return {
    state,
    connect: session.connect,
    begin: session.begin,
    close: session.close,
    reset: session.reset,
    input: session.input,
    resize: (size: { columns: number; rows: number }) => session.send({ type: "resize", ...size }),
    attach: (handle: XtermHandle) => {
      term.current = handle;
    },
  };
}
