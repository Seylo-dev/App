// When a console connects by itself (the Console tab in console mode and
// the Overview's console card; never a shell, where every session is a new
// audited process and an exit is someone typing exit). The console follows
// the service's live status from the service query: while something runs,
// a closed session opens again after a wait (1 s doubling to 8 s, for as
// long as it keeps running), until retryLimit tries in a row came to
// nothing; while nothing runs it says so and connects once the app starts;
// a refusal that will not change by itself (no permission, the service
// gone, an agent too old) stops at Reconnect. useTerminalSession applies
// these; they are pure so they can be tested.

import { OpError } from "@seylo/ops";
import type { MessageKey } from "../../../i18n/t";
import { hasRunningInstance, type RunSource } from "../status";

/**
 * What the console can attach to now. "running": a container runs (see
 * hasRunningInstance). "starting": one may be on its way, so it tries and
 * waits. "unknown": the panel cannot tell (the node does not answer).
 * "stopped": nothing runs: stopped, crashed and left by the crash policy,
 * never deployed, a first deploy with no container yet. While a deploy goes
 * on, what runs meanwhile (runtimeStatus, when the panel sends it).
 */
export type ConsoleRun = "running" | "starting" | "unknown" | "stopped";

export function consoleRun(service: RunSource): ConsoleRun {
  if (hasRunningInstance(service)) return "running";
  const now = service.runtimeStatus ?? service.status;
  if (now === "starting" && !service.stopped) return "starting";
  if (now === "unknown" && !service.stopped) return "unknown";
  return "stopped";
}

/** Whether the console has something to try: a container runs or is starting. */
export function consoleMayAttach(run: ConsoleRun): boolean {
  return run === "running" || run === "starting";
}

/**
 * Why a session ended or could not open. "exited": the process exited (a
 * restart, a deploy, a crash). "idle": the panel closed it after 30 minutes
 * without input or output. "refused": the ticket op said no for a reason
 * that will not change by itself, or the socket refused the ticket.
 * "dropped": anything else (the network, the panel or the agent went away,
 * no container to attach to yet), which may pass.
 */
export type ConsoleClose = "exited" | "dropped" | "idle" | "refused";

/** "connect": try again (after the retry wait); "wait": until the app runs or the tab is shown; "stop": show Reconnect. */
export type ConsoleStep = "connect" | "wait" | "stop";

/**
 * Tries in a row that came to nothing (see afterAttempt) after which a
 * running app's console stops at Reconnect: about 25 s of waits. A console
 * that never attaches while the status says running (its node offline, the
 * node the panel picks has no container) would otherwise ask every 8 s
 * forever, an audited terminals.console each time. A nudge tries again.
 */
export const retryLimit = 6;

export interface StepContext {
  /**
   * Something may have changed since: the page or tab was entered, the
   * service's status or generation changed, the browser tab is visible
   * again, the network or the panel's live socket came back.
   */
  nudged?: boolean;
  /** Tries in a row that came to nothing (afterAttempt). */
  tries?: number;
  /** The browser tab is hidden: nothing connects by itself until it is shown (a visibilitychange nudge). */
  hidden?: boolean;
}

/**
 * What a console does after its session ended (`nudged` false), or when
 * something may have changed since (`nudged` true). An idle session is not
 * opened again by itself, which would defeat the idle timeout, and neither
 * is a running app's console after retryLimit tries that came to nothing
 * (a starting app's waits for the status to move on instead); a nudge
 * opens either. In a hidden browser tab it waits to be shown.
 */
export function consoleStep(run: ConsoleRun, close: ConsoleClose, context: StepContext = {}): ConsoleStep {
  const { nudged = false, tries = 0, hidden = false } = context;
  if (close === "refused") return "stop";
  if (!consoleMayAttach(run)) return "wait";
  if (!nudged) {
    if (close === "idle") return "stop";
    if (tries >= retryLimit) return run === "starting" ? "wait" : "stop";
  }
  return hidden ? "wait" : "connect";
}

/** The ticket op's codes that may pass by themselves: try again. Every other refusal stops. */
const passingCodes: ReadonlySet<string> = new Set(["UNAVAILABLE", "INTERNAL", "RATE_LIMITED"]);

/** A ticket op that failed: refused (a 4xx, an agent too old) or dropped (the panel or the node did not answer). */
export function ticketFailure(error: unknown): ConsoleClose {
  return error instanceof OpError && passingCodes.has(error.code) ? "dropped" : "refused";
}

/**
 * A ticket (or the probe before one, see TicketSource.probe) whose target
 * names no container (TerminalTicket.target.containerId null: none of the
 * service runs on the node the panel picked, as far as it knows): the
 * socket would only end with the agent's "no container" after a Connected
 * line, so it is not opened and the console tries again after the wait.
 * That holds for a starting app, whose container may not be there yet, and
 * for every attempt nobody asked for (`automatic`). A click while the
 * status says running opens the socket anyway, as the agent looks for the
 * container itself and the panel's view may lag.
 */
export function nothingToAttach(run: ConsoleRun | undefined, containerId: string | null | undefined, automatic = false): boolean {
  if (run === undefined || containerId !== null) return false;
  return run === "starting" || automatic;
}

/** The panel's close code for a ticket it did not take (apps/panel/src/modules/logs/follow.ts badTicketCloseCode). */
export const badTicketCloseCode = 4401;

/** A socket that closed: after an exit message, else by its close code and reason (apps/panel/src/modules/terminals). */
export function socketClose(event: { code: number; reason: string }, exited: boolean): ConsoleClose {
  if (exited) return "exited";
  if (event.code === badTicketCloseCode) return "refused";
  if (event.reason === "idle") return "idle";
  return "dropped";
}

export const retryFirstMs = 1000;
export const retryMaxMs = 8000;
/** A session that stayed up this long starts the waits and the tries over when it ends. */
export const stableMs = 10_000;
/**
 * How long a session waits after ready for its first output before it
 * shows in the terminal (a clicked one too): one the panel ends at once
 * (ready, then "no running container", then the close) leaves no
 * Connected line and no error line behind, and is no session that opened.
 */
export const confirmMs = 1000;

/** The next try: how long to wait now, and the wait after it (doubling to retryMaxMs). */
export function retryStep(delay: number): { wait: number; nextDelay: number } {
  const wait = Math.min(retryMaxMs, Math.max(retryFirstMs, delay));
  return { wait, nextDelay: Math.min(retryMaxMs, wait * 2) };
}

/** The next retry's wait, and the tries in a row that came to nothing. */
export interface RetryState {
  delay: number;
  tries: number;
}

export const freshRetry: RetryState = { delay: retryFirstMs, tries: 0 };

/**
 * How an attempt ended. "lasted": a session stayed up stableMs. "failed":
 * the ticket op failed, or the session ended sooner (an attach the panel
 * refused at once, a crash loop's short runs). "nothing": no container to
 * attach to, so no socket was opened (nothingToAttach).
 */
export type AttemptEnd = "lasted" | "failed" | "nothing";

/**
 * The retry state after an attempt: a session that lasted starts over, any
 * other end is one more try. Waiting for a starting app's container is not
 * a try: it is expected and asks only the non-audited probe.
 */
export function afterAttempt(state: RetryState, end: AttemptEnd, run: ConsoleRun): RetryState {
  if (end === "lasted") return freshRetry;
  if (end === "nothing" && run === "starting") return state;
  return { ...state, tries: state.tries + 1 };
}

/**
 * The retry state after a nudge. A fresh one (the browser tab shown again,
 * the network or the panel's live socket back) starts over. A change of the
 * service's status or generation does not: it connects at once, but a crash
 * loop that flips the status every cycle keeps backing off and counting.
 */
export function afterNudge(state: RetryState, fresh: boolean): RetryState {
  return fresh ? freshRetry : state;
}

/** The line a waiting console shows instead of Disconnected. */
export function waitNote(run: ConsoleRun, close: ConsoleClose): MessageKey {
  if (run === "stopped") return "serviceTerminal.waitNotRunning";
  if (run === "unknown") return "serviceTerminal.waitUnknown";
  if (run === "starting") return "serviceTerminal.waitStarting";
  return close === "exited" ? "serviceTerminal.reconnecting" : "serviceTerminal.retrying";
}
