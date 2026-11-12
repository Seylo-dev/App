// What a database backup holds, in words: the engines that can hold chosen
// databases and tables, the selection a schedule stores, schedule titles,
// run chips and the restore text per scope. Pure, so tests need no DOM.

import type { backups, OpOutput } from "@seylo/ops";
import { t } from "../../../i18n/t";
import { formatBytes, formatCount } from "../format";

type Policy = OpOutput<typeof backups.listPolicies>["policies"][number];
type Run = OpOutput<typeof backups.listRuns>["runs"][number];
export type Selection = NonNullable<Policy["selection"]>;

/** The engines whose backups can hold chosen databases and tables. */
export type SelectEngine = "postgres" | "mysql" | "mariadb" | "mongo";

export function selectEngine(kind: string): SelectEngine | null {
  return kind === "postgres" || kind === "mysql" || kind === "mariadb" || kind === "mongo" ? kind : null;
}

/** A table as one string for the multi-select: schema and name kept apart (either may hold a dot). */
export function tableKey(table: { schema?: string; name: string }): string {
  return JSON.stringify([table.schema ?? "", table.name]);
}

export function fromTableKey(key: string): { schema: string; name: string } {
  const [schema, name] = JSON.parse(key) as [string, string];
  return { schema, name };
}

/** public.orders (Postgres), orders elsewhere. */
export function tableLabel(table: { schema?: string; name: string }): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

/** What the dialog saves: null backs up everything; tables only with one database. */
export function selectionOf(chosen: boolean, databases: string[], tables: string[]): Selection | null {
  if (!chosen || databases.length === 0) return null;
  if (databases.length === 1 && tables.length > 0) {
    return {
      databases: [
        {
          name: databases[0] as string,
          tables: tables.map(fromTableKey).map((tab) => (tab.schema ? tab : { name: tab.name })),
        },
      ],
    };
  }
  return { databases: databases.map((name) => ({ name })) };
}

const list = (names: string[]) =>
  typeof Intl !== "undefined" && "ListFormat" in Intl
    ? new Intl.ListFormat(undefined, { type: "conjunction" }).format(names)
    : names.join(", ");

const countOf = (engine: string | null, count: number) =>
  engine === "mongo" ? t("serviceBackups.collectionCount", { count }) : t("serviceBackups.tableCount", { count });

/** "Database · Everything on this server", "Database · shop, analytics", "Database · shop · 2 tables". */
export function policyTitle(policy: Pick<Policy, "target" | "volumeName" | "selection">, kind: string): string {
  if (policy.target !== "database") return t("serviceBackups.volume", { name: policy.volumeName ?? "" });
  const engine = selectEngine(kind);
  if (!engine) return t("serviceBackups.database");
  const databases = policy.selection?.databases ?? [];
  if (databases.length === 0) return t("serviceBackups.policyEverything");
  const only = databases[0];
  if (databases.length === 1 && only?.tables?.length) {
    return t("serviceBackups.policyTables", { database: only.name, tables: countOf(engine, only.tables.length) });
  }
  return t("serviceBackups.policyDatabases", { names: databases.map((d) => d.name).join(", ") });
}

/** "~14k rows", "rows unknown". */
export function rowsText(rows: number): string {
  return rows < 0 ? t("serviceBackups.rowsUnknown") : t("serviceBackups.rows", { count: rows, rows: formatCount(rows) });
}

/** "1.2 MB · ~14k rows". */
export function sizeAndRows(item: { sizeBytes: number; approxRows: number }): string {
  return `${formatBytes(item.sizeBytes)} · ${rowsText(item.approxRows)}`;
}

export interface RunChip {
  key: string;
  label: string;
  tone: "gray" | "track" | "amber";
}

/** How many database chips a run row shows before "+N". */
export const maxRunChips = 6;

/**
 * The chips under a database run: "Everything on this server" for a
 * backup of everything (also every run from before 0.2.15: none recorded
 * what it held), then one per database with its size ("shop 380 MB", for
 * some tables "shop · 2 tables 1.2 MB"), at most six and "+N", and what
 * its warnings are. A backup's warnings depend on its scope: of chosen
 * databases or tables they are the names skipped because they were gone
 * ("2 skipped"); of everything, why what it holds could not be measured
 * (the backup itself is complete). A restore's are notes about it and
 * get no chip. A run still going shows what it was asked for.
 */
export function runChips(run: Pick<Run, "kind" | "target" | "scope" | "selection" | "contents" | "warnings">, kind: string): RunChip[] {
  if (run.target !== "database") return [];
  const engine = selectEngine(kind);
  const chips: RunChip[] = [];
  if (run.scope === "everything" || run.scope === null) {
    chips.push({ key: "scope", label: t("serviceBackups.scopeEverything"), tone: "gray" });
  }
  const held = run.contents?.databases;
  const databases: { name: string; label: string }[] = held
    ? held.map((d) => ({
        name: d.name,
        label:
          run.scope === "tables"
            ? `${d.name} · ${countOf(engine, d.tableCount)} ${formatBytes(d.sizeBytes)}`
            : `${d.name} ${formatBytes(d.sizeBytes)}`,
      }))
    : (run.selection?.databases ?? []).map((d) => ({
        name: d.name,
        label: d.tables?.length ? `${d.name} · ${countOf(engine, d.tables.length)}` : d.name,
      }));
  for (const d of databases.slice(0, maxRunChips)) chips.push({ key: `db:${d.name}`, label: d.label, tone: "track" });
  if (databases.length > maxRunChips) {
    chips.push({ key: "more", label: t("serviceBackups.more", { count: databases.length - maxRunChips }), tone: "track" });
  }
  if (run.kind === "backup" && run.warnings.length > 0) {
    chips.push(
      run.scope === "databases" || run.scope === "tables"
        ? { key: "skipped", label: t("serviceBackups.skipped", { count: run.warnings.length }), tone: "amber" }
        : { key: "unmeasured", label: t("serviceBackups.notMeasured"), tone: "gray" },
    );
  }
  return chips;
}

/**
 * The restore dialog's text: everything is replaced for a backup of
 * everything; for chosen databases only those; for some tables only those
 * (named from what the backup holds when it is known).
 */
export function restoreText(
  run: Pick<Run, "scope" | "selection" | "contents" | "startedAt">,
  service: { name: string; kind: string },
  when: string,
  heldTables?: { schema: string; name: string }[] | null,
): string {
  if (run.scope === "databases") {
    const names = run.contents?.databases.map((d) => d.name) ?? run.selection?.databases.map((d) => d.name) ?? [];
    return t("serviceBackups.restoreDatabases", { count: names.length, names: list(names), name: service.name, when });
  }
  if (run.scope === "tables") {
    const database = run.contents?.databases[0]?.name ?? run.selection?.databases[0]?.name ?? "";
    const tables = (heldTables ?? run.selection?.databases[0]?.tables ?? []).map(tableLabel);
    const key = service.kind === "mongo" ? "serviceBackups.restoreCollections" : "serviceBackups.restoreTables";
    return t(key, { count: tables.length, database, tables: tables.join(", ") });
  }
  return t("serviceBackups.restoreBody", { name: service.name });
}
