// The logs WebSocket (logs.follow hands out its ticket). For every node of
// the service (or the one asked for, or the node that ran a build) it opens
// LogsFollow and forwards batches as LogsSocketMessage JSON. When a node
// drops, the socket says so; when it comes back the stream reopens from the
// last line seen. A slow browser stops the reading, and flow control then
// slows the agent.

import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { logs } from "@seylo/ops";
import { Elysia } from "elysia";
import type { AgentStream } from "../../agent-hub/calls";
import { ticketsFor } from "../../agent-hub/relay";
import type { Deps } from "../../deps";
import { isSameOrigin } from "../../http/origin";
import { toEntry } from "./entries";

export const logsSocketPath = "/api/streams/logs";

export interface FollowTicket {
  serviceId: string;
  buildId: string | null;
  nodeIds: string[];
  tail: number;
  since: string | null;
}

type Message = logs.LogsSocketMessage;

/** Pause reading while this much is queued for the browser. */
const browserHighWater = 1 << 20;
/** WebSocket close code for a missing, used or expired ticket. */
export const badTicketCloseCode = 4401;

interface Follow {
  send(message: Message): void;
  buffered(): number;
  close(reason: string): void;
}

/** One live follow: per-node streams that reopen after reconnects. */
export function startFollow(deps: Pick<Deps, "agents">, ticket: FollowTicket, out: Follow): () => void {
  const streams = new Map<string, AgentStream<"logsFollow">>();
  const lastSeen = new Map<string, Date>();
  const finished = new Set<string>();
  let stopped = false;

  const target = ticket.buildId
    ? ({ case: "buildId", value: ticket.buildId } as const)
    : ({ case: "serviceId", value: ticket.serviceId } as const);

  const maybeEnd = () => {
    if (!stopped && finished.size === ticket.nodeIds.length) {
      out.send({ type: "end", reason: "The log stream ended." });
      stop();
      out.close("ended");
    }
  };

  const open = (nodeId: string, resume: boolean) => {
    if (stopped || streams.has(nodeId) || !deps.agents.supports(nodeId, "logsFollow")) return;
    const since = resume ? lastSeen.get(nodeId) : ticket.since ? new Date(ticket.since) : undefined;
    let stream: AgentStream<"logsFollow">;
    try {
      stream = deps.agents.open(nodeId, "logsFollow", {
        target,
        tail: resume ? 0 : ticket.tail,
        since: since ? timestampFromDate(new Date(since.getTime() + (resume ? 1 : 0))) : undefined,
      });
    } catch {
      return;
    }
    streams.set(nodeId, stream);
    void (async () => {
      try {
        for await (const batch of stream) {
          if (stopped) return;
          const entries = batch.entries.map((e) => toEntry(nodeId, e));
          const last = entries.at(-1);
          if (last) lastSeen.set(nodeId, new Date(last.time));
          if (entries.length > 0) out.send({ type: "entries", entries });
          while (!stopped && out.buffered() > browserHighWater) await Bun.sleep(20);
        }
        await stream.done;
        // The agent ended the stream (a finished build): this node is done.
        finished.add(nodeId);
        maybeEnd();
      } catch {
        // Offline: the connection listener reopens it. Agent errors end this node.
        if (!deps.agents.isOnline(nodeId)) return;
        finished.add(nodeId);
        maybeEnd();
      } finally {
        streams.delete(nodeId);
      }
    })();
  };

  const unsubscribe = deps.agents.onConnection((nodeId, online) => {
    if (stopped || !ticket.nodeIds.includes(nodeId) || finished.has(nodeId)) return;
    out.send({ type: "node", nodeId, online });
    // Give the hub a moment to finish the handshake before reopening.
    if (online) setTimeout(() => open(nodeId, true), 50);
  });

  const stop = () => {
    stopped = true;
    unsubscribe();
    for (const stream of streams.values()) stream.cancel("the viewer left");
    streams.clear();
  };

  for (const nodeId of ticket.nodeIds) {
    if (deps.agents.isOnline(nodeId)) open(nodeId, false);
    else out.send({ type: "node", nodeId, online: false });
  }
  return stop;
}

export function logsHttp(deps: Deps) {
  const stops = new Map<string, () => void>();
  return new Elysia({ name: "logs-socket" }).ws(logsSocketPath, {
    beforeHandle({ request, set }) {
      if (!isSameOrigin(request)) {
        set.status = 403;
        return "cross-origin log streams are not allowed";
      }
    },
    open(ws) {
      const ticketParam = new URL(ws.data.request.url).searchParams.get("t");
      const redeemed = ticketsFor(deps).take<FollowTicket>(deps.db, ticketParam);
      if (!redeemed) {
        ws.close(badTicketCloseCode, "ticket not valid");
        return;
      }
      const raw = ws.raw as unknown as { getBufferedAmount?(): number };
      const stop = startFollow(deps, redeemed.data, {
        send: (message) => ws.send(JSON.stringify(message)),
        buffered: () => raw.getBufferedAmount?.() ?? 0,
        close: (reason) => ws.close(1000, reason),
      });
      stops.set(ws.id, stop);
    },
    close(ws) {
      stops.get(ws.id)?.();
      stops.delete(ws.id);
    },
  });
}
