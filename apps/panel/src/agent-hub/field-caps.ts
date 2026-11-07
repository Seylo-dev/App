// Caps on what a node sends the panel, applied to decoded protobuf messages
// before anything stores them or fans them out: durable reports
// (panel-service.ts), node facts (session.ts, hub.ts). The frame limit
// (16 MiB) and the report limit (1 MiB) bound a message; these bound each
// field, so a node cannot make the panel keep, write or show megabytes of
// one host name or alert message.

export interface FieldLimits {
  /** Longest string field (a message, an error, an id). */
  maxString: number;
  /** Most entries of a repeated field; `lastLines` keeps its newest entries, the others their first. */
  maxList: number;
  /** Longest string entry of a repeated field (one output line). */
  maxListItem: number;
}

/** What modules see of a report. Crash reports keep 100 lines of 2000 characters (panel-service.ts). */
export const reportFieldLimits: FieldLimits = { maxString: 4096, maxList: 200, maxListItem: 2000 };

/** What agent_reports stores of an event. */
export const storedReportLimits: FieldLimits = { maxString: 1024, maxList: 20, maxListItem: 1024 };

/** NodeFacts (hello and nodeFacts events): host names, versions, addresses and capability names are short. */
export const factsLimits: FieldLimits = { maxString: 256, maxList: 256, maxListItem: 128 };

/** Lists whose newest entries matter (output tails). */
const tailLists = new Set(["lastLines"]);

/**
 * Cuts every string and list of a decoded protobuf message in place, nested
 * messages and oneofs included, and drops unknown fields (a newer agent's
 * fields this panel cannot read, which nothing here uses).
 */
export function capFields<T extends object>(message: T, limits: FieldLimits = reportFieldLimits): T {
  capObject(message as Record<string, unknown>, limits, 0);
  return message;
}

function capObject(value: Record<string, unknown>, limits: FieldLimits, depth: number): void {
  if (depth > 8) return;
  if ("$unknown" in value) value.$unknown = undefined;
  for (const key of Object.keys(value)) {
    if (key === "$typeName") continue;
    const field = value[key];
    if (typeof field === "string") {
      if (field.length > limits.maxString) value[key] = field.slice(0, limits.maxString);
    } else if (Array.isArray(field)) {
      const kept =
        field.length <= limits.maxList ? field : tailLists.has(key) ? field.slice(-limits.maxList) : field.slice(0, limits.maxList);
      value[key] = kept.map((item) => {
        if (typeof item === "string") return item.length > limits.maxListItem ? item.slice(0, limits.maxListItem) : item;
        if (item && typeof item === "object" && !(item instanceof Uint8Array))
          capObject(item as Record<string, unknown>, limits, depth + 1);
        return item;
      });
    } else if (field && typeof field === "object" && !(field instanceof Uint8Array)) {
      capObject(field as Record<string, unknown>, limits, depth + 1);
    }
  }
}
