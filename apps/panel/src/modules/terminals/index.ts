// Console (attach to the main process) and Shell (a new PTY process) for
// service containers. The ops issue one-minute tickets; the WebSocket at
// terminalSocketPath relays bytes between the browser and the agent's
// Console or Shell stream. Contracts: packages/ops/src/ops/terminals.ts.
//
// Socket protocol: binary frames are raw terminal bytes both ways; text
// frames are JSON control messages (TerminalClientMessage from the browser,
// TerminalServerMessage from the panel).

import { OpError, terminals } from "@seylo/ops";
import { InstanceState } from "@seylo/proto";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Elysia } from "elysia";
import type { AgentHub } from "../../agent-hub/hub";
import { pickServiceNode, ticketsFor } from "../../agent-hub/relay";
import type { Deps } from "../../deps";
import { isSameOrigin } from "../../http/origin";
import { implement, type OpContext } from "../../ops/implement";
import { badTicketCloseCode } from "../logs/follow";
import { defineModule } from "../module";

export const terminalSocketPath = "/api/streams/terminal";
/** A session with no input or output for this long is closed. */
export const idleTimeoutSeconds = 30 * 60;
/** How long "ready" waits for the agent's info message before it goes out without it. */
const readyWaitMs = 1500;

const clientMessage = TypeCompiler.Compile(terminals.TerminalClientMessage);

export interface TerminalTicket {
  /** "host" is a root shell on the node itself (modules/hostShell). */
  mode: "console" | "shell" | "host";
  serviceId: string;
  nodeId: string;
  containerId: string;
  generation: number;
  tail: number;
  command: string[];
  user: string;
  databaseClient: boolean;
  columns: number;
  rows: number;
  /** Host shells: who opened it and the panel's session id, for the agent's own log. */
  openedBy?: string;
  sessionId?: string;
  /** Closes the session after this long without input or output; default idleTimeoutSeconds. */
  idleSeconds?: number;
  /** Console output only (terminals.watchConsole): what the viewer sends is dropped. */
  watch?: boolean;
}

/** The running replica to attach to: the one asked for, else the first running one the node reports. */
function pickContainer(agents: AgentHub, nodeId: string, serviceId: string, containerId?: string) {
  const status = agents.state.get(nodeId)?.services.get(serviceId);
  const running = (status?.instances ?? []).filter((i) => i.state === InstanceState.RUNNING);
  if (containerId) {
    const instance = status?.instances.find((i) => i.containerId === containerId || i.containerId.startsWith(containerId));
    if (status && !instance) throw new OpError("NOT_FOUND", "No container with this id in the service.", { field: "containerId" });
    return { containerId: instance?.containerId ?? containerId, generation: Number(instance?.generation ?? status?.generation ?? 0n) };
  }
  const first = running.sort((a, b) => a.replica - b.replica)[0];
  if (!first) return { containerId: "", generation: Number(status?.generation ?? 0n) };
  return { containerId: first.containerId, generation: Number(first.generation) };
}

function issue(
  ctx: OpContext,
  mode: "console" | "shell",
  input: { serviceId: string; nodeId?: string; containerId?: string },
  extra: Partial<TerminalTicket>,
) {
  const node = pickServiceNode(ctx.db, input.serviceId, input.nodeId);
  const method = mode === "console" ? "console" : "shell";
  if (!ctx.agents.isOnline(node.id))
    throw new OpError("UNAVAILABLE", "The node is offline. Try again when it is back.", { reason: "offline" });
  if (!ctx.agents.supports(node.id, method)) {
    throw new OpError("NOT_IMPLEMENTED", "This node's agent is too old for this action. Update the node and try again.", {
      reason: "capability",
    });
  }
  const target = pickContainer(ctx.agents, node.id, input.serviceId, input.containerId);
  const data: TerminalTicket = {
    mode,
    serviceId: input.serviceId,
    nodeId: node.id,
    containerId: target.containerId,
    generation: target.generation,
    tail: 100,
    command: [],
    user: "",
    databaseClient: false,
    columns: 120,
    rows: 32,
    ...extra,
  };
  const issued = ticketsFor(ctx).issue(
    { principal: ctx.principal, action: mode === "console" ? "terminals.console" : "terminals.shell", serviceId: input.serviceId },
    data,
  );
  return {
    url: `${terminalSocketPath}?t=${encodeURIComponent(issued.ticket)}`,
    ticket: issued.ticket,
    expiresAt: issued.expiresAt.toISOString(),
    target: {
      nodeId: node.id,
      nodeName: node.name,
      containerId: target.containerId || null,
      generation: target.containerId ? target.generation : null,
    },
    idleTimeoutSeconds,
  };
}

const openConsole = implement(terminals.openConsole, (input, ctx) => issue(ctx, "console", input, { tail: input.tail ?? 100 }));

// Output only, so nothing reaches the process: not audited, like reading its logs.
const watchConsole = implement(terminals.watchConsole, (input, ctx) =>
  issue(ctx, "console", input, { tail: input.tail ?? 100, watch: true }),
);

const openShell = implement(terminals.openShell, (input, ctx) =>
  issue(ctx, "shell", input, {
    command: input.command ?? [],
    user: input.user ?? "",
    databaseClient: input.databaseClient ?? false,
    columns: input.columns ?? 120,
    rows: input.rows ?? 32,
  }),
);

interface TerminalSocket {
  sendBytes(bytes: Uint8Array): void;
  sendControl(message: terminals.TerminalServerMessage): void;
  close(code: number, reason: string): void;
}

interface Session {
  input(bytes: Uint8Array): void;
  control(text: string): void;
  stop(): void;
}

export interface TerminalHooks {
  /**
   * Called once when the agent's stream first answers: with its info message
   * (host shells and current agents send it first), or null when older
   * agents start with output. Never for a stream the agent refused; "ready"
   * on the socket may go out before this (see readyWaitMs).
   */
  onReady?(info: { user: string; workingDir: string } | null): void;
  /**
   * Called once when the session ends, with why ("exited", "idle", "ended",
   * "closed", "left") and the note the viewer got, if any (for "closed"
   * after a stream error: the agent's message).
   */
  onEnd?(reason: string, note?: string): void;
}

/** Starts the agent stream for a redeemed ticket and pumps it to the socket. */
export function startTerminal(
  deps: Pick<Deps, "agents">,
  ticket: TerminalTicket,
  socket: TerminalSocket,
  hooks: TerminalHooks = {},
): Session {
  let idle: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  let answered = false;
  const finish = (reason: string, note?: string) => {
    ended = true;
    clearTimeout(idle);
    hooks.onEnd?.(reason, note);
  };
  const end = (code: number, reason: string, message?: terminals.TerminalServerMessage) => {
    if (ended) return;
    ready();
    finish(reason, message?.type === "closed" ? message.reason : undefined);
    if (message) socket.sendControl(message);
    socket.close(code, reason);
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => {
        stream.cancel("idle");
        end(1000, "idle", { type: "closed", reason: "The session was idle for too long." });
      },
      (ticket.idleSeconds ?? idleTimeoutSeconds) * 1000,
    );
  };

  const stream =
    ticket.mode === "console"
      ? deps.agents.open(ticket.nodeId, "console", {
          message: { case: "open", value: { serviceId: ticket.serviceId, containerId: ticket.containerId, tail: ticket.tail } },
        })
      : ticket.mode === "host"
        ? deps.agents.open(ticket.nodeId, "hostShell", {
            message: {
              case: "open",
              value: {
                size: { columns: ticket.columns, rows: ticket.rows },
                openedBy: ticket.openedBy ?? "",
                sessionId: ticket.sessionId ?? "",
              },
            },
          })
        : deps.agents.open(ticket.nodeId, "shell", {
            message: {
              case: "open",
              value: {
                serviceId: ticket.serviceId,
                containerId: ticket.containerId,
                command: ticket.command,
                size: { columns: ticket.columns, rows: ticket.rows },
                databaseClient: ticket.databaseClient,
                user: ticket.user,
              },
            },
          });

  // "ready" waits for the agent's info message (container, user, working
  // directory). Older agents start with output, and a quiet console may say
  // nothing for a while, so it goes out with the ticket's values then.
  let readySent = false;
  const ready = (info?: { containerId: string; generation: bigint; user: string; workingDir: string }) => {
    if (readySent || ended) return;
    readySent = true;
    clearTimeout(readyTimer);
    socket.sendControl({
      type: "ready",
      containerId: info?.containerId || ticket.containerId,
      generation: info && info.generation > 0n ? Number(info.generation) : ticket.generation,
      user: info?.user || ticket.user,
      workdir: info?.workingDir ?? "",
    });
  };
  const readyTimer = setTimeout(() => ready(), readyWaitMs);
  (readyTimer as { unref?: () => void }).unref?.();
  touch();

  void (async () => {
    try {
      for await (const res of stream) {
        touch();
        if (!answered && !ended) {
          answered = true;
          const info = res.message.case === "info" ? res.message.value : null;
          hooks.onReady?.(info ? { user: info.user, workingDir: info.workingDir } : null);
        }
        if (res.message.case === "info") {
          const info = res.message.value;
          ready({
            containerId: "containerId" in info ? info.containerId : "",
            generation: "generation" in info ? info.generation : 0n,
            user: info.user,
            workingDir: info.workingDir,
          });
          continue;
        }
        ready();
        if (res.message.case === "output") socket.sendBytes(res.message.value);
        else if (res.message.case === "exitCode") {
          end(1000, "exited", { type: "exit", exitCode: res.message.value });
          return;
        }
      }
      await stream.done;
      end(1000, "ended", { type: "closed", reason: "The session ended." });
    } catch (error) {
      const reason = error instanceof OpError ? error.message : "The session ended.";
      end(1011, "closed", { type: "closed", reason });
    }
  })();

  return {
    input(bytes) {
      if (ended || ticket.watch) return;
      touch();
      const message =
        ticket.mode === "console"
          ? { message: { case: "stdin" as const, value: bytes } }
          : { message: { case: "input" as const, value: bytes } };
      void (stream.send as (m: unknown) => Promise<void>)(message).catch(() => {});
    },
    control(text) {
      if (ended) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (!clientMessage.Check(parsed)) return;
      if (parsed.type === "resize" && ticket.mode !== "console") {
        void (stream.send as (m: unknown) => Promise<void>)({
          message: { case: "resize", value: { columns: parsed.columns, rows: parsed.rows } },
        }).catch(() => {});
      }
    },
    stop() {
      if (ended) return;
      stream.cancel("the viewer left");
      finish("left");
    },
  };
}

function terminalHttp(deps: Deps) {
  const sessions = new Map<string, Session>();
  return new Elysia({ name: "terminal-socket" }).ws(terminalSocketPath, {
    beforeHandle({ request, set }) {
      if (!isSameOrigin(request)) {
        set.status = 403;
        return "cross-origin terminals are not allowed";
      }
    },
    open(ws) {
      const redeemed = ticketsFor(deps).take<TerminalTicket>(deps.db, new URL(ws.data.request.url).searchParams.get("t"));
      if (!redeemed) {
        ws.close(badTicketCloseCode, "ticket not valid");
        return;
      }
      try {
        const session = startTerminal(deps, redeemed.data, {
          sendBytes: (bytes) => ws.raw.sendBinary(bytes),
          sendControl: (message) => ws.send(JSON.stringify(message)),
          close: (code, reason) => ws.close(code, reason),
        });
        sessions.set(ws.id, session);
      } catch (error) {
        const reason = error instanceof OpError ? error.message : "The terminal could not start.";
        ws.send(JSON.stringify({ type: "closed", reason }));
        ws.close(1011, "closed");
      }
    },
    message(ws, message) {
      const session = sessions.get(ws.id);
      if (!session) return;
      if (message instanceof Uint8Array) session.input(message);
      else if (message instanceof ArrayBuffer) session.input(new Uint8Array(message));
      else if (typeof message === "string") session.control(message);
      else session.control(JSON.stringify(message));
    },
    close(ws) {
      sessions.get(ws.id)?.stop();
      sessions.delete(ws.id);
    },
  });
}

export default defineModule({ name: "terminals", ops: [openConsole, watchConsole, openShell], http: terminalHttp });
