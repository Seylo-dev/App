// Caps on what a node sends the panel, applied to decoded protobuf messages
// before anything stores them or fans them out: durable reports
// (panel-service.ts), the hello and node facts (session.ts, hub.ts), and the
// actual state the panel keeps in memory per placed service (hub.ts). The frame limit
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
  /** String fields, by field name at any depth, that may be longer than maxString. */
  longer?: Readonly<Record<string, number>>;
}

/** What modules see of a report. Crash reports keep 100 lines of 2000 characters (panel-service.ts). */
export const reportFieldLimits: FieldLimits = { maxString: 4096, maxList: 200, maxListItem: 2000 };

/** What agent_reports stores of an event. */
export const storedReportLimits: FieldLimits = { maxString: 1024, maxList: 20, maxListItem: 1024 };

/**
 * NodeFacts (hello and nodeFacts events): host names, versions, addresses
 * and capability names are short. TailscaleInfo.serve (added in 0.2.1) holds
 * the two longer ones: `url` is a MagicDNS name of up to 253 characters
 * with its scheme, `message` the agent's words for a Serve conflict or
 * error. No other NodeFacts field has these names.
 */
export const factsLimits: FieldLimits = { maxString: 256, maxList: 256, maxListItem: 128, longer: { url: 512, message: 1024 } };

/** The hello's agent_version (nodes.agent_version, shown on the Nodes and Updates pages). */
export const maxAgentVersionLength = 64;

/**
 * ServiceStatus (state snapshots and deltas) and HealthChanged: the panel
 * keeps the newest status of every placed service for as long as it runs,
 * so a node must not pin megabytes per service. A status message or an
 * ACME error fits 2048 characters; ids, names and digests of instances,
 * ports and routes fit 256; a service has at most 64 instances during a
 * deploy (32 replicas, old and new).
 */
export const statusLimits: FieldLimits = { maxString: 2048, maxList: 128, maxListItem: 256 };
const statusPartLimits: FieldLimits = { maxString: 256, maxList: 16, maxListItem: 256 };

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
      const max = limits.longer?.[key] ?? limits.maxString;
      if (field.length > max) value[key] = field.slice(0, max);
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

const cut = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

interface StatusLike {
  instances: object[];
  openPorts: object[];
  routes: { routeId: string; certificateIssuer: string }[];
}

/** capFields for one ServiceStatus, with the tighter limits of its instances, ports and routes. */
export function capServiceStatus<T extends StatusLike>(status: T): T {
  capFields(status, statusLimits);
  for (const part of [...status.instances, ...status.openPorts]) capFields(part, statusPartLimits);
  for (const route of status.routes) {
    // The message (an ACME error) keeps statusLimits.maxString.
    route.routeId = cut(route.routeId, statusPartLimits.maxString);
    route.certificateIssuer = cut(route.certificateIssuer, statusPartLimits.maxString);
  }
  return status;
}
