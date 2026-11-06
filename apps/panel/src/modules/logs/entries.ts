// LogEntry (logs.proto) -> the LogEntry op shape, and the merge of several
// nodes' results.

import { timestampDate } from "@bufbuild/protobuf/wkt";
import { type LogEntry, LogStream } from "@seylo/proto";

export interface LogEntryOut {
  time: string;
  stream: "stdout" | "stderr" | "system";
  nodeId: string;
  containerId: string;
  generation: number;
  line: string;
}

const streams: Record<LogStream, LogEntryOut["stream"]> = {
  [LogStream.UNSPECIFIED]: "stdout",
  [LogStream.STDOUT]: "stdout",
  [LogStream.STDERR]: "stderr",
  [LogStream.SYSTEM]: "system",
};

export function toEntry(nodeId: string, entry: LogEntry): LogEntryOut {
  return {
    time: (entry.time ? timestampDate(entry.time) : new Date()).toISOString(),
    stream: streams[entry.stream] ?? "stdout",
    nodeId,
    containerId: entry.containerId,
    generation: Number(entry.generation),
    line: entry.line,
  };
}

/** Newest first; ties keep node order so pages are stable. */
export function mergeNewestFirst(lists: LogEntryOut[][]): LogEntryOut[] {
  return lists.flat().sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}
