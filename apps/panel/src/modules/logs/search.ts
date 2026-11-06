// logs.search: runs LogsSearch on every node the service is placed on (or
// one node), merges by time, newest first.
//
// Paging: with one node the agent's own cursor is passed through. With
// several nodes the cursor is time based: the next page asks every node
// for entries up to the oldest time returned, and skips the boundary
// entries the previous page already showed.

import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { OpError } from "@seylo/ops";
import { pickServiceNode, serviceNodes } from "../../agent-hub/relay";
import type { OpContext } from "../../ops/implement";
import { type LogEntryOut, mergeNewestFirst, toEntry } from "./entries";

type Cursor = { node: string; agent: string } | { until: string; seen: string[] };

const key = (e: LogEntryOut) => `${e.nodeId}\0${e.containerId}\0${e.line}`;

function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decode(text: string | undefined): Cursor | null {
  if (!text) return null;
  try {
    const value = JSON.parse(Buffer.from(text, "base64url").toString()) as Cursor;
    if (("node" in value && typeof value.agent === "string") || ("until" in value && Array.isArray(value.seen))) return value;
  } catch {
    // fall through
  }
  throw new OpError("BAD_REQUEST", "The cursor is not valid. Start the search again.", { field: "cursor" });
}

export interface SearchInput {
  serviceId: string;
  query?: string;
  regex?: boolean;
  since?: string;
  until?: string;
  nodeId?: string;
  limit?: number;
  cursor?: string;
}

export async function searchLogs(ctx: OpContext, input: SearchInput) {
  const limit = input.limit ?? 500;
  const cursor = decode(input.cursor);
  const targets = input.nodeId ? [pickServiceNode(ctx.db, input.serviceId, input.nodeId)] : serviceNodes(ctx.db, input.serviceId);
  const offline: string[] = [];
  const reachable = targets.filter((n) => {
    if (ctx.agents.supports(n.id, "logsSearch")) return true;
    offline.push(n.id);
    return false;
  });

  const until = cursor && "until" in cursor ? cursor.until : input.until;
  const results = await Promise.all(
    reachable.map(async (node) => {
      const agentCursor = cursor && "node" in cursor && cursor.node === node.id ? cursor.agent : "";
      try {
        const res = await ctx.agents.call(node.id, "logsSearch", {
          serviceId: input.serviceId,
          query: input.query ?? "",
          regex: input.regex ?? false,
          since: input.since ? timestampFromDate(new Date(input.since)) : undefined,
          until: until ? timestampFromDate(new Date(until)) : undefined,
          limit,
          cursor: agentCursor,
        });
        return { nodeId: node.id, entries: res.entries.map((e) => toEntry(node.id, e)), next: res.nextCursor };
      } catch (error) {
        if (error instanceof OpError && error.details?.reason === "offline") {
          offline.push(node.id);
          return { nodeId: node.id, entries: [], next: "" };
        }
        throw error;
      }
    }),
  );

  if (results.length === 1 && targets.length === 1) {
    const only = results[0] as (typeof results)[number];
    return {
      entries: only.entries.slice(0, limit),
      nextCursor: only.next ? encode({ node: only.nodeId, agent: only.next }) : null,
      offlineNodeIds: offline,
    };
  }

  const seen = new Set(cursor && "seen" in cursor ? cursor.seen : []);
  const merged = mergeNewestFirst(results.map((r) => r.entries)).filter((e) => !(e.time === until && seen.has(key(e))));
  const page = merged.slice(0, limit);
  const more = merged.length > limit || results.some((r) => r.next);
  const oldest = page.at(-1);
  return {
    entries: page,
    nextCursor: more && oldest ? encode({ until: oldest.time, seen: page.filter((e) => e.time === oldest.time).map(key) }) : null,
    offlineNodeIds: offline,
  };
}
