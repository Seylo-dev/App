// Alert rules: which events notify which channels. Global rows are the
// panel defaults; a service with rows of its own uses those for service
// events instead. Before anyone saves defaults, every problem event
// notifies the default channel (if there is one).

import { alerts as alertOps, OpError } from "@seylo/ops";
import { and, eq, inArray } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { alertRules, notificationChannels } from "../../db/schema";

export interface Rule {
  event: alertOps.AlertRuleEventName;
  enabled: boolean;
  channelIds: string[];
}

/** Off until someone turns them on: good news and things people rarely want pushed. */
const offByDefault = new Set<alertOps.AlertRuleEventName>(["deploy_succeeded", "update_available", "cleanup_ran"]);

const serviceEvents = new Set<string>(alertOps.serviceAlertEvents);

export function isServiceEvent(event: string): boolean {
  return serviceEvents.has(event);
}

function defaultChannelIds(db: PanelDb): string[] {
  const row = db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(and(eq(notificationChannels.isDefault, true), eq(notificationChannels.enabled, true)))
    .get();
  return row ? [row.id] : [];
}

function rowsFor(db: PanelDb, scopeType: "global" | "service", scopeId: string) {
  return db
    .select({ event: alertRules.event, enabled: alertRules.enabled, channelIds: alertRules.channelIds })
    .from(alertRules)
    .where(and(eq(alertRules.scopeType, scopeType), eq(alertRules.scopeId, scopeId)))
    .all();
}

/** Panel defaults for every rule event, in catalog order. */
export function readDefaults(db: PanelDb): Rule[] {
  const rows = rowsFor(db, "global", "");
  if (rows.length === 0) {
    const channels = defaultChannelIds(db);
    return alertOps.alertRuleEvents.map((event) => ({ event, enabled: !offByDefault.has(event), channelIds: channels }));
  }
  const byEvent = new Map(rows.map((row) => [row.event, row]));
  return alertOps.alertRuleEvents.map((event) => {
    const row = byEvent.get(event);
    return { event, enabled: row?.enabled ?? false, channelIds: row?.channelIds ?? [] };
  });
}

/** A service's own rules for service events, or null when it follows the defaults. */
export function readServiceRules(db: PanelDb, serviceId: string): Rule[] | null {
  const rows = rowsFor(db, "service", serviceId);
  if (rows.length === 0) return null;
  const byEvent = new Map(rows.map((row) => [row.event, row]));
  return alertOps.serviceAlertEvents.map((event) => {
    const row = byEvent.get(event);
    return { event, enabled: row?.enabled ?? false, channelIds: row?.channelIds ?? [] };
  });
}

/** Defaults narrowed to the events a service can set itself. */
export function serviceDefaults(db: PanelDb): Rule[] {
  return readDefaults(db).filter((rule) => isServiceEvent(rule.event));
}

/** The rule that decides who hears about an event, for a service or panel-wide. */
export function effectiveRule(db: PanelDb, event: alertOps.AlertRuleEventName, serviceId: string | null): Rule {
  if (serviceId && isServiceEvent(event)) {
    const own = readServiceRules(db, serviceId)?.find((rule) => rule.event === event);
    if (own) return own;
  }
  return readDefaults(db).find((rule) => rule.event === event) ?? { event, enabled: false, channelIds: [] };
}

function checkRules(db: PanelDb, rules: readonly Rule[], allowed: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!allowed.has(rule.event)) {
      throw new OpError("BAD_REQUEST", `${rule.event} is configured in the panel defaults, not per service.`, { event: rule.event });
    }
    if (seen.has(rule.event)) throw new OpError("BAD_REQUEST", `${rule.event} appears twice.`, { event: rule.event });
    seen.add(rule.event);
  }
  const ids = [...new Set(rules.flatMap((rule) => rule.channelIds))];
  if (ids.length === 0) return;
  const found = new Set(
    db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(inArray(notificationChannels.id, ids))
      .all()
      .map((row) => row.id),
  );
  const missing = ids.find((id) => !found.has(id));
  if (missing) throw new OpError("BAD_REQUEST", "One of the channels does not exist.", { channelId: missing });
}

/** Replaces a scope's rules; events left out are stored as off. */
function writeRules(db: PanelDb, scopeType: "global" | "service", scopeId: string, events: readonly string[], rules: readonly Rule[]) {
  const byEvent = new Map(rules.map((rule) => [rule.event, rule]));
  db.transaction((tx) => {
    tx.delete(alertRules)
      .where(and(eq(alertRules.scopeType, scopeType), eq(alertRules.scopeId, scopeId)))
      .run();
    tx.insert(alertRules)
      .values(
        events.map((event) => {
          const rule = byEvent.get(event as alertOps.AlertRuleEventName);
          return {
            scopeType,
            scopeId,
            event: event as alertOps.AlertRuleEventName,
            enabled: rule?.enabled ?? false,
            channelIds: [...new Set(rule?.channelIds ?? [])],
          };
        }),
      )
      .run();
  });
}

export function updateDefaults(db: PanelDb, rules: readonly Rule[]): Rule[] {
  checkRules(db, rules, new Set(alertOps.alertRuleEvents));
  writeRules(db, "global", "", alertOps.alertRuleEvents, rules);
  return readDefaults(db);
}

export function updateServiceRules(db: PanelDb, serviceId: string, useDefaults: boolean, rules: readonly Rule[] | undefined): void {
  if (useDefaults) {
    db.delete(alertRules)
      .where(and(eq(alertRules.scopeType, "service"), eq(alertRules.scopeId, serviceId)))
      .run();
    return;
  }
  if (!rules) throw new OpError("BAD_REQUEST", "Pass the rules, or set useDefaults to true.", { field: "rules" });
  checkRules(db, rules, serviceEvents);
  writeRules(db, "service", serviceId, alertOps.serviceAlertEvents, rules);
}

/** Drops a deleted channel from every rule. */
export function forgetChannel(db: PanelDb, channelId: string): void {
  const rows = db.select({ id: alertRules.id, channelIds: alertRules.channelIds }).from(alertRules).all();
  for (const row of rows) {
    if (!row.channelIds.includes(channelId)) continue;
    db.update(alertRules)
      .set({ channelIds: row.channelIds.filter((id) => id !== channelId) })
      .where(eq(alertRules.id, row.id))
      .run();
  }
}
