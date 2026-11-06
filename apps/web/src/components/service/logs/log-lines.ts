// How a stored log entry becomes a LogViewer line, and the marker line
// shown where the generation (deploy) changes, so logs kept across deploys
// read as one stream with visible boundaries.

import type { LogLineInput } from "@seylo/ui/components/log-viewer";
import { t } from "../../../i18n/t";

export interface LogEntryLike {
  time: string;
  stream: "stdout" | "stderr" | "system";
  generation: number;
  line: string;
}

export function entryToLine(e: LogEntryLike): LogLineInput {
  return {
    text: e.line,
    ts: Date.parse(e.time),
    source: e.stream === "system" ? "panel" : e.stream,
    level: e.stream === "stderr" ? "warn" : e.stream === "system" ? "system" : "info",
  };
}

/** Emits a "Generation N" line before the first entry of each new generation. */
export class GenerationTracker {
  private last: number | null = null;

  lines<E extends LogEntryLike>(entry: E, map: (e: E) => LogLineInput): LogLineInput[] {
    const out: LogLineInput[] = [];
    if (this.last !== null && entry.generation !== this.last) {
      out.push({
        text: t("serviceLogs.generation", { generation: entry.generation }),
        ts: Date.parse(entry.time),
        source: "panel",
        level: "system",
      });
    }
    this.last = entry.generation;
    out.push(map(entry));
    return out;
  }
}
