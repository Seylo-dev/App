// What the Move dialog says happens when a service moves to another node,
// from services.moveImpact and the node picked: the downtime (and a
// database's size at its last backup), its internal address (the same,
// but only services on the new node reach it), what moves to the new
// node's address (a database's exposed port, timed exposes, the first-run
// IP:port) and who reads it (they need a deploy), its backups, and what
// happens to the old copy. Pure, so the wording is tested without a DOM.

import type { OpOutput, services } from "@seylo/ops";
import { t } from "../../../i18n/t";
import { formatBytes, formatRelative } from "../format";
import { isDatabaseKind } from "../status";

/** A backup younger than this is fresh enough: the dialog does not ask for another. */
export const freshBackupMs = 60 * 60_000;

export type MoveImpact = OpOutput<typeof services.moveImpact>;
export type MoveTarget = MoveImpact["targets"][number];

export interface MoveNote {
  id:
    | "downtime"
    | "size"
    | "internal"
    | "leftBehind"
    | "exposed"
    | "tlsHostname"
    | "timed"
    | "firstRun"
    | "exposedReferrers"
    | "hidden"
    | "schedules"
    | "backup"
    | "oldCopy";
  tone: "info" | "warning";
  text: string;
  /** Services the note names, one line each. */
  items?: string[];
}

export interface MoveSubject {
  name: string;
  kind: string;
  /** Its internal name:port (services.get address). */
  address: string | null;
  placements: readonly { nodeId: string; nodeName: string }[];
}

export function moveNotes(service: MoveSubject, impact: MoveImpact, target: MoveTarget, now = Date.now()): MoveNote[] {
  const notes: MoveNote[] = [];
  const add = (id: MoveNote["id"], text: string, tone: MoveNote["tone"] = "info", items?: string[]) =>
    notes.push(items ? { id, tone, text, items } : { id, tone, text });
  const database = isDatabaseKind(service.kind);
  const node = target.name;
  const from = service.placements[0]?.nodeName ?? "";
  const host = target.address ?? target.name;
  const nodeNames = new Map<string, string>([
    ...impact.targets.map((n) => [n.id, n.name] as const),
    ...service.placements.map((p) => [p.nodeId, p.nodeName] as const),
  ]);
  const line = (r: MoveImpact["internalReferrers"][number]) => {
    const nodes = r.nodeIds.map((id) => nodeNames.get(id) ?? id).join(", ");
    return r.keys.length > 0
      ? t("serviceAdvanced.move.notes.keys", { name: r.name, nodes, keys: r.keys.join(", ") })
      : t("serviceAdvanced.move.notes.referrer", { name: r.name, nodes });
  };

  // Downtime: volumes are copied while it is stopped; without, both nodes run it for a while.
  const copies = impact.volumes.length;
  if (copies > 0) {
    add(
      "downtime",
      database
        ? t("serviceAdvanced.move.notes.downtimeDatabase", { name: service.name, node })
        : t("serviceAdvanced.move.notes.downtime", { name: service.name, node, count: copies }),
      "warning",
    );
    if (impact.dataSize)
      add(
        "size",
        t("serviceAdvanced.move.notes.size", {
          size: formatBytes(impact.dataSize.bytes),
          when: formatRelative(impact.dataSize.measuredAt, now),
        }),
      );
    else if (database) add("size", t("serviceAdvanced.move.notes.sizeUnknown"));
  } else {
    add("downtime", t("serviceAdvanced.move.notes.noDowntime", { node }));
  }

  // Its internal address stays, but there is no private network between nodes.
  const leftBehind = impact.internalReferrers.filter((r) => r.nodeIds.some((id) => id !== target.id));
  if (database || impact.internalReferrers.length > 0) {
    add("internal", t("serviceAdvanced.move.notes.internal", { address: service.address ?? service.name, node }));
  }
  if (leftBehind.length > 0) add("leftBehind", t("serviceAdvanced.move.notes.leftBehind", { node }), "warning", leftBehind.map(line));

  // What listens on the node's own address moves to the new node's.
  const exposure = impact.exposure.database;
  if (exposure) {
    const address = exposure.port ? `${host}:${exposure.port}` : host;
    const moved = exposure.allowPlain
      ? t("serviceAdvanced.move.notes.exposedPlain", { address })
      : t("serviceAdvanced.move.notes.exposed", { address });
    add("exposed", `${moved} ${t("serviceAdvanced.move.notes.portTaken", { node })}`);
    if (exposure.tlsHostname)
      add("tlsHostname", t("serviceAdvanced.move.notes.tlsHostname", { host: exposure.tlsHostname, address: host }), "warning");
  }
  if (impact.exposure.timed > 0) add("timed", t("serviceAdvanced.move.notes.timed", { count: impact.exposure.timed, address: host }));
  if (impact.exposure.firstRun) add("firstRun", t("serviceAdvanced.move.notes.firstRun", { address: host }));
  if (impact.exposedReferrers.length > 0) {
    const hostname = exposure?.tlsHostname;
    add(
      "exposedReferrers",
      hostname
        ? t("serviceAdvanced.move.notes.exposedReferrersHostname", { host: hostname, node })
        : t("serviceAdvanced.move.notes.exposedReferrers"),
      hostname ? "info" : "warning",
      impact.exposedReferrers.map(line),
    );
  }
  if (impact.hiddenReferrers > 0) add("hidden", t("serviceAdvanced.move.notes.hiddenReferrers", { count: impact.hiddenReferrers }));

  // Backups keep their schedules; a fresh one first is the way back.
  if (impact.backupSchedules > 0) add("schedules", t("serviceAdvanced.move.notes.schedules", { count: impact.backupSchedules, node }));
  if (impact.lastBackupAt) {
    const when = formatRelative(impact.lastBackupAt, now);
    const fresh = now - new Date(impact.lastBackupAt).getTime() < freshBackupMs;
    add("backup", fresh ? t("serviceAdvanced.move.notes.lastBackupFresh", { when }) : t("serviceAdvanced.move.notes.lastBackup", { when }));
  } else if (database || copies > 0) add("backup", t("serviceAdvanced.move.notes.noBackup"), "warning");

  add(
    "oldCopy",
    copies > 0 ? t("serviceAdvanced.move.notes.oldCopy", { from, node }) : t("serviceAdvanced.move.notes.staysOnFailure", { from }),
  );
  return notes;
}

/** What the picker says after a node it cannot pick: its refusal, or that it is offline. */
export function targetHint(target: MoveTarget): string | null {
  if (target.refusal) return target.refusal.reason === "offline" ? t("serviceAdvanced.move.offline") : t("serviceAdvanced.move.refused");
  return target.online ? null : t("serviceAdvanced.move.offline");
}

/** A node can be picked when nothing refuses it and it is online. */
export const pickable = (target: MoveTarget): boolean => !target.refusal && target.online;
