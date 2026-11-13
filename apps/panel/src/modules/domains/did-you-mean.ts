// "Did you mean": for a host whose registrable domain does not exist
// (zone.ts), the closest registrable domain the caller can already see in
// the panel. Candidates are the domains of services the caller may view
// (domains.view on the service) and the panel's own domain (settings.view);
// nothing the caller cannot see is ever named, since a suggestion would
// tell them another service's domain. Only the same public suffix counts
// (example.co.il is no typo of example.com), within 2 edits, 1 for names
// of 4 characters or fewer (where 2 edits leave half the name changed).

import type { Access } from "../../auth/access";
import type { PanelDb } from "../../db/client";
import { domains } from "../../db/schema";
import { getSetting } from "../../settings";
import { registrableDomain } from "./zone";

export interface SuggestionCaller {
  db: PanelDb;
  access: Pick<Access, "can">;
}

/** Edits allowed between two names of this length. */
export function maxEdits(name: string): number {
  return name.length <= 4 ? 1 : 2;
}

/**
 * Edit distance with adjacent transpositions as one edit (optimal string
 * alignment), so "exmaple" is 1 from "example". Stops early: anything over
 * `max` comes back as max + 1.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, (before[j - 2] as number) + 1);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    before = previous;
    previous = current;
  }
  return Math.min(previous[b.length] as number, max + 1);
}

/** Host names the caller may view: their services' domains and, with settings.view, the panel's own domain. */
function visibleHosts(caller: SuggestionCaller): string[] {
  const rows = caller.db.select({ serviceId: domains.serviceId, host: domains.host }).from(domains).all();
  const viewable = new Map<string, boolean>();
  const hosts: string[] = [];
  for (const row of rows) {
    let may = viewable.get(row.serviceId);
    if (may === undefined) {
      may = caller.access.can("domains.view", { type: "service", id: row.serviceId });
      viewable.set(row.serviceId, may);
    }
    if (may) hosts.push(row.host);
  }
  const panel = getSetting(caller.db, "panelDomain")?.trim().toLowerCase();
  if (panel && caller.access.can("settings.view")) hosts.push(panel);
  return hosts;
}

/** The registrable domain the caller can see that `registrable` most likely misspells; null when none is close. */
export function suggestRegistrable(caller: SuggestionCaller, registrable: string): string | null {
  const target = registrableDomain(registrable);
  if (!target) return null;
  const label = target.domain.slice(0, -(target.suffix.length + 1));
  const max = maxEdits(label);
  let best: { domain: string; distance: number } | null = null;
  for (const host of visibleHosts(caller)) {
    const candidate = registrableDomain(host);
    if (!candidate || candidate.suffix !== target.suffix || candidate.domain === target.domain) continue;
    const distance = editDistance(label, candidate.domain.slice(0, -(candidate.suffix.length + 1)), max);
    if (distance > max) continue;
    if (!best || distance < best.distance || (distance === best.distance && candidate.domain < best.domain)) {
      best = { domain: candidate.domain, distance };
    }
  }
  return best?.domain ?? null;
}
