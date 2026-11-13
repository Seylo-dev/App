import { expect, test } from "bun:test";
import { t } from "../../../i18n/t";
import { formatRelative } from "../format";
import { type MoveImpact, type MoveSubject, moveNotes, pickable, targetHint } from "./move-notes";

const now = Date.parse("2026-11-13T12:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const hour = 3_600_000;

const db: MoveSubject = {
  name: "db",
  kind: "postgres",
  address: "db:5432",
  placements: [{ nodeId: "nodea00000000001", nodeName: "de-fsn-1" }],
};
const target = { id: "nodeb00000000002", name: "us-ash-1", online: true, address: "203.0.113.20", refusal: null };
const impact = (change: Partial<MoveImpact> = {}): MoveImpact => ({
  blocker: null,
  targets: [target],
  volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
  dataSize: { bytes: 1_500_000_000, measuredAt: ago(2 * hour) },
  lastBackupAt: ago(2 * hour),
  backupSchedules: 1,
  exposure: { database: { port: 41000, tlsHostname: null, allowPlain: true }, timed: 2, firstRun: false },
  exposedReferrers: [{ serviceId: "svcreports000001", name: "reports", keys: ["PG_URL", "PG_HOST"], nodeIds: [target.id] }],
  internalReferrers: [
    { serviceId: "svcapi0000000001", name: "api", keys: ["DATABASE_URL"], nodeIds: ["nodea00000000001"] },
    { serviceId: "svcjobs000000001", name: "jobs", keys: [], nodeIds: [target.id] },
  ],
  hiddenReferrers: 1,
  ...change,
});

test("a database: downtime with its size, the same internal address, what moves to the new address, who needs a deploy, backups, the old copy", () => {
  const notes = moveNotes(db, impact(), target, now);
  expect(notes.map((n) => n.id)).toEqual([
    "downtime",
    "size",
    "internal",
    "leftBehind",
    "exposed",
    "timed",
    "exposedReferrers",
    "hidden",
    "schedules",
    "backup",
    "oldCopy",
  ]);
  const text = (id: string) => notes.find((n) => n.id === id);
  expect(text("downtime")).toMatchObject({
    tone: "warning",
    text: t("serviceAdvanced.move.notes.downtimeDatabase", { name: "db", node: "us-ash-1" }),
  });
  expect(text("size")?.text).toBe(t("serviceAdvanced.move.notes.size", { size: "1.5 GB", when: formatRelative(ago(2 * hour), now) }));
  expect(text("internal")?.text).toBe(t("serviceAdvanced.move.notes.internal", { address: "db:5432", node: "us-ash-1" }));
  // Only services that run elsewhere lose it; jobs already runs on the new node.
  expect(text("leftBehind")).toMatchObject({ tone: "warning", items: ["api on de-fsn-1: DATABASE_URL"] });
  expect(text("exposed")?.text).toBe(
    `${t("serviceAdvanced.move.notes.exposedPlain", { address: "203.0.113.20:41000" })} ${t("serviceAdvanced.move.notes.portTaken", { node: "us-ash-1" })}`,
  );
  expect(text("timed")?.text).toBe(t("serviceAdvanced.move.notes.timed", { count: 2, address: "203.0.113.20" }));
  expect(text("exposedReferrers")).toMatchObject({
    tone: "warning",
    text: t("serviceAdvanced.move.notes.exposedReferrers"),
    items: ["reports on us-ash-1: PG_URL, PG_HOST"],
  });
  expect(text("hidden")?.text).toBe("1 service you cannot see uses its address too.");
  expect(text("schedules")?.text).toBe(t("serviceAdvanced.move.notes.schedules", { count: 1, node: "us-ash-1" }));
  // Two hours old: back it up first.
  expect(text("backup")?.text).toBe(t("serviceAdvanced.move.notes.lastBackup", { when: formatRelative(ago(2 * hour), now) }));
  expect(text("oldCopy")?.text).toBe(t("serviceAdvanced.move.notes.oldCopy", { from: "de-fsn-1", node: "us-ash-1" }));
});

test("a database the panel has not measured, never backed up, exposed with a TLS host name and without plain clients", () => {
  const notes = moveNotes(
    db,
    impact({
      dataSize: null,
      lastBackupAt: null,
      backupSchedules: 0,
      exposure: { database: { port: null, tlsHostname: "db.example.com", allowPlain: false }, timed: 0, firstRun: false },
      internalReferrers: [],
      hiddenReferrers: 0,
    }),
    target,
    now,
  );
  const find = (id: string) => notes.find((n) => n.id === id);
  expect(find("size")?.text).toBe(t("serviceAdvanced.move.notes.sizeUnknown"));
  expect(find("leftBehind")).toBeUndefined();
  // No port reported yet: the node's address alone.
  expect(find("exposed")?.text).toStartWith(t("serviceAdvanced.move.notes.exposed", { address: "203.0.113.20" }));
  expect(find("tlsHostname")).toMatchObject({
    tone: "warning",
    text: t("serviceAdvanced.move.notes.tlsHostname", { host: "db.example.com", address: "203.0.113.20" }),
  });
  // Its exposed host stays the TLS host name: no deploy asked for.
  expect(find("exposedReferrers")).toMatchObject({
    tone: "info",
    text: t("serviceAdvanced.move.notes.exposedReferrersHostname", { host: "db.example.com", node: "us-ash-1" }),
  });
  expect(find("schedules")).toBeUndefined();
  expect(find("backup")).toMatchObject({ tone: "warning", text: t("serviceAdvanced.move.notes.noBackup") });
});

test("a fresh backup is not asked for again", () => {
  const notes = moveNotes(db, impact({ lastBackupAt: ago(10 * 60_000) }), target, now);
  expect(notes.find((n) => n.id === "backup")?.text).toBe(
    t("serviceAdvanced.move.notes.lastBackupFresh", { when: formatRelative(ago(10 * 60_000), now) }),
  );
});

test("an app without volumes moves without downtime and stays put on failure; its first-run port moves", () => {
  const app: MoveSubject = { name: "web", kind: "app", address: "web:3000", placements: db.placements };
  const notes = moveNotes(
    app,
    impact({
      volumes: [],
      dataSize: null,
      lastBackupAt: null,
      backupSchedules: 0,
      exposure: { database: null, timed: 0, firstRun: true },
      exposedReferrers: [],
      internalReferrers: [],
      hiddenReferrers: 0,
    }),
    { ...target, address: null },
    now,
  );
  expect(notes.map((n) => [n.id, n.text])).toEqual([
    ["downtime", t("serviceAdvanced.move.notes.noDowntime", { node: "us-ash-1" })],
    // No address known: the node's name.
    ["firstRun", t("serviceAdvanced.move.notes.firstRun", { address: "us-ash-1" })],
    ["oldCopy", t("serviceAdvanced.move.notes.staysOnFailure", { from: "de-fsn-1" })],
  ]);
});

test("the picker: a refused or offline node cannot be picked and says why in short", () => {
  const refusal = { reason: "agentTooOld", message: "The agent on old cannot keep PostgreSQL's exposed port TLS only yet." };
  expect(pickable(target)).toBe(true);
  expect(targetHint(target)).toBeNull();
  expect(pickable({ ...target, refusal })).toBe(false);
  expect(targetHint({ ...target, refusal })).toBe(t("serviceAdvanced.move.refused"));
  expect(targetHint({ ...target, online: false, refusal: { reason: "offline", message: "x" } })).toBe(t("serviceAdvanced.move.offline"));
  // Without volumes the panel does not refuse an offline node, but it cannot run there now.
  expect(pickable({ ...target, online: false })).toBe(false);
  expect(targetHint({ ...target, online: false })).toBe(t("serviceAdvanced.move.offline"));
});
