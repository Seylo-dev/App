// When a console connects by itself (the Console tab in console mode and
// the Overview's console card; never a shell, where every session is a new
// audited process and an exit is someone typing exit). The console follows
// the service's live status from the service query: while something runs,
// a closed session opens again after a wait (1 s doubling to 8 s, for as
// long as it keeps running); while nothing runs it says so and connects
// once the app starts; a refusal that will not change by itself (no
// permission, the service gone, an agent too old) stops at Reconnect.
// useTerminalSession applies these; they are pure so they can be tested.

import { OpError } from "@seylo/ops";
import type { MessageKey } from "../../../i18n/t";
import { hasRunningInstance, type ServiceStatus } from "../status";

/**
 * What the console can attach to now. "running": a container runs (see
 * hasRunningInstance). "starting": one may be on its way, so it tries and
 * waits. "unknown": the panel cannot tell (the node does not answer).
 * "stopped": nothing runs: stopped, crashed and left by the crash policy,
 * never deployed, a first deploy with no live container yet.
 */
export type ConsoleRun = "running" | "starting" | "unknown" | "stopped";

export function consoleRun(service: { status: ServiceStatus; stopped: boolean; liveDeployment: unknown }): ConsoleRun {
  if (hasRunningInstance(service)) return "running";
  if (service.status === "starting" && !service.stopped) return "starting";
  if (service.status === "unknown" && !service.stopped) return "unknown";
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

/** "connect": try again (after the retry wait); "wait": until the app runs; "stop": show Reconnect. */
export type ConsoleStep = "connect" | "wait" | "stop";

/**
 * What a console does after its session ended (`nudged` false), or when
 * something may have changed since (`nudged` true): the page or tab was
 * entered, the service's status or generation changed, the browser tab is
 * visible again, the network came back. An idle session is not opened again
 * by itself, which would defeat the idle timeout, but a nudge opens it.
 */
export function consoleStep(run: ConsoleRun, close: ConsoleClose, nudged = false): ConsoleStep {
  if (close === "refused") return "stop";
  if (!consoleMayAttach(run)) return "wait";
  if (close === "idle" && !nudged) return "stop";
  return "connect";
}

/** The ticket op's codes that may pass by themselves: try again. Every other refusal stops. */
const passingCodes: ReadonlySet<string> = new Set(["UNAVAILABLE", "INTERNAL", "RATE_LIMITED"]);

/** A ticket op that failed: refused (a 4xx, an agent too old) or dropped (the panel or the node did not answer). */
export function ticketFailure(error: unknown): ConsoleClose {
  return error instanceof OpError && passingCodes.has(error.code) ? "dropped" : "refused";
}

/**
 * A ticket for a starting app whose container the panel does not see yet
 * (TerminalTicket.target.containerId null): the socket would only end with
 * the agent's "no container" after a Connected line, so it is not opened
 * and the console tries again after the wait. While the status says running
 * the socket always opens, as the agent finds the container itself.
 */
export function nothingToAttach(run: ConsoleRun | undefined, containerId: string | null | undefined): boolean {
  return run === "starting" && containerId === null;
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
/** A session that stayed up this long starts the waits over at retryFirstMs when it ends. */
export const stableMs = 10_000;

/** The next try: how long to wait now, and the wait after it (doubling to retryMaxMs). */
export function retryStep(delay: number): { wait: number; nextDelay: number } {
  const wait = Math.min(retryMaxMs, Math.max(retryFirstMs, delay));
  return { wait, nextDelay: Math.min(retryMaxMs, wait * 2) };
}

/** The line a waiting console shows instead of Disconnected. */
export function waitNote(run: ConsoleRun, close: ConsoleClose): MessageKey {
  if (run === "stopped") return "serviceTerminal.waitNotRunning";
  if (run === "unknown") return "serviceTerminal.waitUnknown";
  if (run === "starting") return "serviceTerminal.waitStarting";
  return close === "exited" ? "serviceTerminal.reconnecting" : "serviceTerminal.retrying";
}
