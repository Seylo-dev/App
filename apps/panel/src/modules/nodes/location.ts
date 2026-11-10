// A node's location, filled in from its public address. When a node with an
// empty location connects (it joined, or it joined before the panel did
// this), the panel asks the site API's geolocation lookup (config.geoUrl,
// DB-IP City Lite) once, in the background, and stores "City, Country" (or
// the country) with location_source "detected": a suggestion the node's
// settings mark as such until someone saves the field. Saving it, cleared or
// not, makes it "manual" (ops.ts updateSettings), and a manual location is
// never filled in again.
//
// Nothing is asked while telemetry is locked off on the container
// (SEYLO_TELEMETRY=off or DO_NOT_TRACK=1, config.telemetryOffBy), for a node
// without a public IP address (private, reserved and host names are never
// sent), or for a node the lookup answered for before. A lookup that gets
// no answer (no network, a timeout, the API down or rate limited) is not
// recorded and is not tried again until the panel restarts. The join never
// waits for it, and nothing it does can fail the join.

import { isIP } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { blockedReason } from "../uptime/targets";
import { nodeLive } from "./live";

type LocationDeps = Pick<Deps, "db" | "config" | "logger" | "live">;
type NodeRow = typeof nodes.$inferSelect;
export type GeoFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The lookup waits this long for the site API; the node's location just stays empty after. */
export const geoTimeoutMs = 5000;
/** The answer is a few short strings; anything bigger is not one. */
const maxAnswerBytes = 4096;
/** Node locations are at most 80 characters (packages/ops nodes.Node). */
const maxLocationLength = 80;

let geoFetch: GeoFetch = (url, init) => fetch(url, init);

/** Tests answer the lookups themselves; null goes back to the network. */
export function setGeoFetch(fn: GeoFetch | null): void {
  geoFetch = fn ?? ((url, init) => fetch(url, init));
}

/** Nodes this panel process already asked about (by its database), answered or not. */
const asked = new WeakMap<object, Set<string>>();

/** The node's public IP address to look up: its IPv4, its IPv6, else the owner's address when that is an IP; never a private one. */
export function lookupAddress(row: Pick<NodeRow, "publicIpv4" | "publicIpv6" | "publicAddress">): string | null {
  for (const candidate of [row.publicIpv4, row.publicIpv6, row.publicAddress]) {
    const address = candidate?.trim().replace(/^\[(.*)\]$/, "$1") ?? "";
    if (isIP(address) && blockedReason(address) === null) return address;
  }
  return null;
}

/** One printable name from the answer, or null. */
function part(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text.length > 0 && text.length <= 60 ? text : null;
}

/** "Falkenstein, Germany", "Germany" without a city, or null without a country. */
export function locationLabel(answer: unknown): string | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { city, country } = answer as Record<string, unknown>;
  const countryName = part(country);
  if (!countryName) return null;
  const cityName = part(city);
  const label = cityName && cityName !== countryName ? `${cityName}, ${countryName}` : countryName;
  return label.length <= maxLocationLength ? label : countryName;
}

/** Whether the node may still get a detected location: empty, never saved, never answered for. */
function wantsLocation(row: NodeRow): boolean {
  return row.location === null && row.locationSource === null && row.locationLookedUpAt === null;
}

/**
 * Asks for the node's location when it may get one (see the top of the
 * file). Returns the lookup, for tests to wait on; null when nothing is
 * asked. Never throws, and the promise never rejects.
 */
export function detectNodeLocation(deps: LocationDeps, nodeId: string): Promise<void> | null {
  try {
    if (deps.config.telemetryOffBy) return null;
    const row = deps.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
    if (!row || !wantsLocation(row)) return null;
    const address = lookupAddress(row);
    if (!address) return null;
    let seen = asked.get(deps.db);
    if (!seen) {
      seen = new Set();
      asked.set(deps.db, seen);
    }
    if (seen.has(nodeId)) return null;
    seen.add(nodeId);
    return lookUp(deps, nodeId, address);
  } catch (error) {
    deps.logger.warn({ err: error, nodeId }, "detecting the node's location failed");
    return null;
  }
}

/**
 * detectNodeLocation for every node that may get a location: at start (also nodes that joined
 * before the panel did this, online or not), and when the setup gives the panel node its address.
 */
export function detectNodeLocations(deps: LocationDeps): Promise<void>[] {
  if (deps.config.telemetryOffBy) return [];
  try {
    const rows = deps.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(isNull(nodes.location), isNull(nodes.locationSource), isNull(nodes.locationLookedUpAt)))
      .all();
    return rows.map((row) => detectNodeLocation(deps, row.id)).filter((lookup) => lookup !== null);
  } catch (error) {
    deps.logger.warn({ err: error }, "detecting the nodes' locations failed");
    return [];
  }
}

async function lookUp(deps: LocationDeps, nodeId: string, address: string): Promise<void> {
  try {
    const url = `${deps.config.geoUrl}?ip=${encodeURIComponent(address)}`;
    const response = await geoFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(geoTimeoutMs) });
    // 400: the API will never know this address (it calls it private or invalid); asking again changes nothing.
    if (response.status === 400) {
      await response.body?.cancel();
      record(deps, nodeId, null);
      return;
    }
    if (!response.ok) {
      await response.body?.cancel();
      deps.logger.info(
        { nodeId, status: response.status },
        "the geolocation lookup did not answer; the node's location stays empty until the panel restarts",
      );
      return;
    }
    // Only a JSON object is the API's answer: anything else (a proxy's page, a wrong SEYLO_GEO_URL) is no answer.
    const answer = await answerOf(response);
    if (!answer) {
      deps.logger.info(
        { nodeId },
        "the geolocation lookup answered something else; the node's location stays empty until the panel restarts",
      );
      return;
    }
    record(deps, nodeId, locationLabel(answer));
  } catch (error) {
    deps.logger.info({ nodeId, err: error }, "the geolocation lookup failed; the node's location stays empty until the panel restarts");
  }
}

/** The response's JSON object, or null for anything else or more than maxAnswerBytes. */
async function answerOf(response: Response): Promise<Record<string, unknown> | null> {
  if (Number(response.headers.get("content-length") ?? 0) > maxAnswerBytes) {
    await response.body?.cancel();
    return null;
  }
  const text = await response.text();
  if (text.length > maxAnswerBytes) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Stores the answer, unless someone set the location in the meantime: theirs always wins. */
function record(deps: LocationDeps, nodeId: string, label: string | null): void {
  const changed = deps.db
    .update(nodes)
    .set({ locationLookedUpAt: new Date(), ...(label ? { location: label, locationSource: "detected" as const } : {}) })
    .where(and(eq(nodes.id, nodeId), isNull(nodes.location), isNull(nodes.locationSource)))
    .returning({ id: nodes.id })
    .get();
  if (changed && label) {
    for (const [topic, ops] of nodeLive.nodeChanged(nodeId)) deps.live.publish(topic, { type: "invalidate", ops });
  }
}
