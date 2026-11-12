// Add or change a backup schedule: what (the database, or a volume), where
// (a destination), when (a preset or a cron expression in UTC), how many to
// keep, and for volumes whether to stop the service while copying. For
// PostgreSQL, MySQL, MariaDB and MongoDB, what of the database: everything
// on the server, or chosen databases (listed live through the node) and,
// with one database, only some of its tables or collections.

import { backups, type OpOutput } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { MultiSelect } from "@seylo/ui/components/multi-select";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { type ReactNode, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { describeCron, schedulePresets } from "../cron-text";
import { Field, parseIntOrNull, ToggleRow } from "../field";
import { volumesOf } from "../files/volumes";
import { formatBytes } from "../format";
import { useInvalidate } from "../invalidate";
import { MutationError } from "../op-state";
import { isDatabaseKind } from "../status";
import type { ServiceDetail } from "../use-service";
import { fromTableKey, type SelectEngine, selectEngine, selectionOf, sizeAndRows, tableKey, tableLabel } from "./selection";

type Policy = OpOutput<typeof backups.listPolicies>["policies"][number];
type Choice = OpOutput<typeof backups.listDestinations>["choices"][number];
type Listing = OpOutput<typeof backups.listDatabases>;
const custom = "__custom__";
const cronPattern = /^\S+( \S+){4}$/;

export function PolicyDialog(props: { service: ServiceDetail; policy: Policy | null; choices: Choice[]; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="top-[10%]">
        <PolicyForm
          {...props}
          header={
            <div className="flex flex-col gap-1">
              <DialogTitle>{props.policy ? t("serviceBackups.editSchedule") : t("serviceBackups.addSchedule")}</DialogTitle>
              <DialogDescription>{t("serviceBackups.scheduleBody")}</DialogDescription>
            </div>
          }
        />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's form, on its own for tests (the dialog passes its title as header). */
export function PolicyForm({
  service,
  policy,
  choices,
  onClose,
  header,
}: {
  service: ServiceDetail;
  policy: Policy | null;
  choices: Choice[];
  onClose: () => void;
  header?: ReactNode;
}) {
  const isDb = isDatabaseKind(service.kind);
  const engine = isDb ? selectEngine(service.kind) : null;
  const volumes = volumesOf(service);
  const [target, setTarget] = useState<string>(
    policy ? (policy.target === "database" ? "database" : (policy.volumeId ?? "")) : isDb ? "database" : (volumes[0]?.id ?? ""),
  );
  const [destinationId, setDestination] = useState(policy?.destinationId ?? choices[0]?.id ?? "");
  const [schedule, setSchedule] = useState(policy?.schedule ?? "0 3 * * *");
  const [preset, setPreset] = useState<string>(
    (schedulePresets as readonly string[]).includes(policy?.schedule ?? "0 3 * * *") ? (policy?.schedule ?? "0 3 * * *") : custom,
  );
  const [keepLast, setKeepLast] = useState(String(policy?.keepLast ?? 14));
  const [stopService, setStopService] = useState(policy?.stopService ?? false);
  const saved = policy?.selection?.databases ?? [];
  const [chosen, setChosen] = useState(saved.length > 0);
  const [databases, setDatabases] = useState<string[]>(saved.map((d) => d.name));
  const [tables, setTables] = useState<string[]>(saved.length === 1 ? (saved[0]?.tables ?? []).map(tableKey) : []);
  const invalidate = useInvalidate();
  const done = () => {
    invalidate(backups.listPolicies);
    toast.success(t("service.saved"));
    onClose();
  };
  const create = useOpMutation(backups.createPolicy, { onSuccess: done });
  const update = useOpMutation(backups.updatePolicy, { onSuccess: done });
  const keep = parseIntOrNull(keepLast);
  const isVolume = target !== "database";
  const selecting = !isVolume && engine !== null;
  const needsDatabase = selecting && chosen && databases.length === 0;
  const valid = destinationId && cronPattern.test(schedule.trim()) && keep !== null && keep >= 1 && target && !needsDatabase;
  const selection = selecting ? selectionOf(chosen, databases, tables) : null;

  const submit = () => {
    if (!valid || keep === null) return;
    if (policy)
      update.mutate({
        serviceId: service.id,
        policyId: policy.id,
        destinationId,
        schedule: schedule.trim(),
        keepLast: keep,
        stopService,
        ...(selecting ? { selection } : {}),
      });
    else
      create.mutate({
        serviceId: service.id,
        target: isVolume ? "volume" : "database",
        ...(isVolume ? { volumeId: target } : {}),
        destinationId,
        schedule: schedule.trim(),
        keepLast: keep,
        stopService: isVolume && stopService,
        ...(selection ? { selection } : {}),
      });
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {header}
      <Field label={t("serviceBackups.what")}>
        <Select value={target} onValueChange={setTarget} disabled={policy !== null}>
          <SelectTrigger aria-label={t("serviceBackups.what")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {isDb && <SelectItem value="database">{t("serviceBackups.database")}</SelectItem>}
            {volumes.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {t("serviceBackups.volume", { name: v.name })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {!isVolume && engine && (
        <DatabaseScope
          serviceId={service.id}
          engine={engine}
          chosen={chosen}
          onChosenChange={setChosen}
          databases={databases}
          onDatabasesChange={(next) => {
            setDatabases(next);
            if (next.length !== 1) setTables([]);
          }}
          tables={tables}
          onTablesChange={setTables}
        />
      )}
      {!isVolume && !engine && isDb && <p className="m-0 -mt-2 text-[12.5px] text-muted-foreground">{staticLine(service.kind)}</p>}
      <Field label={t("serviceBackups.where")}>
        <Select value={destinationId} onValueChange={setDestination}>
          <SelectTrigger aria-label={t("serviceBackups.where")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name} · {c.bucket}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("serviceBackups.when")} hint={preset === custom ? describeCron(schedule) : t("serviceBackups.utc")}>
          <Select
            value={preset}
            onValueChange={(v) => {
              setPreset(v);
              if (v !== custom) setSchedule(v);
            }}
          >
            <SelectTrigger aria-label={t("serviceBackups.when")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {schedulePresets.map((p) => (
                <SelectItem key={p} value={p}>
                  {describeCron(p)}
                </SelectItem>
              ))}
              <SelectItem value={custom}>{t("serviceBackups.custom")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("serviceBackups.keep")} htmlFor="b-keep">
          <Input id="b-keep" inputMode="numeric" value={keepLast} onChange={(e) => setKeepLast(e.target.value)} />
        </Field>
      </div>
      {preset === custom && (
        <Field label={t("serviceBackups.cron")} htmlFor="b-cron">
          <Input
            id="b-cron"
            className="font-mono"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            aria-invalid={!cronPattern.test(schedule.trim())}
          />
        </Field>
      )}
      {isVolume && (
        <ToggleRow
          title={t("serviceBackups.stopService")}
          description={t("serviceBackups.stopServiceHint")}
          control={<Switch checked={stopService} onCheckedChange={setStopService} aria-label={t("serviceBackups.stopService")} />}
        />
      )}
      <MutationError error={create.error ?? update.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t("service.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!valid || create.isPending || update.isPending}>
          {t("service.save")}
        </Button>
      </div>
    </form>
  );
}

/** What a backup of a database without choices holds (Redis-likes, ClickHouse). */
function staticLine(kind: string): string {
  return kind === "clickhouse" ? t("serviceBackups.everythingClickhouse") : t("serviceBackups.everythingRedis");
}

/** The listing as the dialog shows it: a state, its message, and the names. */
function listingState(query: { data?: Listing; error: unknown; isError: boolean; isPending: boolean }) {
  if (query.isError) return { state: "failed" as const, message: errorMessage(query.error, t("service.actionFailed")) };
  if (query.isPending || !query.data) return { state: "loading" as const, message: null };
  return { state: query.data.state, message: query.data.message };
}

/**
 * Everything on this server (the default) or chosen databases, listed
 * live; with exactly one database, only some of its tables. While the
 * listing cannot answer (stopped, node away, old agent, a refused sign-in)
 * Everything stays usable and saved names stay as removable chips.
 */
export function DatabaseScope({
  serviceId,
  engine,
  chosen,
  onChosenChange,
  databases,
  onDatabasesChange,
  tables,
  onTablesChange,
}: {
  serviceId: string;
  engine: SelectEngine;
  chosen: boolean;
  onChosenChange: (chosen: boolean) => void;
  databases: string[];
  onDatabasesChange: (databases: string[]) => void;
  tables: string[];
  onTablesChange: (tables: string[]) => void;
}) {
  const listing = useOp(backups.listDatabases, { serviceId }, { retry: false, staleTime: 30_000 });
  const one = chosen && databases.length === 1 ? (databases[0] as string) : null;
  const tableListing = useOp(
    backups.listDatabases,
    { serviceId, database: one ?? "" },
    { enabled: one !== null, retry: false, staleTime: 30_000 },
  );
  const live = listingState(listing);
  const ok = live.state === "ok" ? listing.data : undefined;
  const liveNames = new Set(ok?.databases.map((d) => d.name) ?? []);
  const total = ok?.databases.reduce((sum, d) => sum + d.sizeBytes, 0) ?? 0;
  const mongo = engine === "mongo";
  const tablesLive = listingState(tableListing);
  const tablesOk = tablesLive.state === "ok" ? tableListing.data : undefined;
  const liveTables = new Set((tablesOk?.tables ?? []).map(tableKey));

  return (
    <div className="-mt-1 flex flex-col gap-3">
      <Segmented
        value={chosen ? "chosen" : "everything"}
        onValueChange={(v) => onChosenChange(v === "chosen")}
        aria-label={t("serviceBackups.scope")}
        className="self-start"
      >
        <SegmentedItem value="everything">{t("serviceBackups.scopeEverything")}</SegmentedItem>
        <SegmentedItem value="chosen">{t("serviceBackups.scopeChosen")}</SegmentedItem>
      </Segmented>
      {!chosen ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t(`serviceBackups.everythingLine.${engine}`)}
          {ok && ok.databases.length > 0 && (
            <> {t("serviceBackups.nowOnServer", { count: ok.databases.length, size: formatBytes(total) })}</>
          )}
        </p>
      ) : (
        <>
          <Field
            label={t("serviceBackups.databases")}
            htmlFor="b-databases"
            hint={
              live.message ??
              (ok && ok.databases.length === 0
                ? t("serviceBackups.noDatabases")
                : databases.some((d) => ok && !liveNames.has(d))
                  ? t("serviceBackups.missingHint")
                  : t(`serviceBackups.noUsers.${engine}`))
            }
          >
            <MultiSelect
              id="b-databases"
              aria-label={t("serviceBackups.databases")}
              options={(ok?.databases ?? []).map((d) => ({ value: d.name, label: d.name, hint: formatBytes(d.sizeBytes) }))}
              value={databases}
              onValueChange={onDatabasesChange}
              placeholder={t("serviceBackups.chooseDatabases")}
              searchPlaceholder={t("serviceBackups.findDatabase")}
              emptyText={t("serviceBackups.noMatch")}
              removeLabel={(name) => t("serviceBackups.remove", { name })}
              warn={(name) => (ok && !liveNames.has(name) ? t("serviceBackups.missing") : null)}
              loading={live.state === "loading"}
              disabled={live.state !== "ok" && live.state !== "loading"}
            />
          </Field>
          {databases.length > 1 ? (
            <p className="m-0 -mt-1 text-[12.5px] text-muted-foreground">
              {mongo ? t("serviceBackups.oneForCollections") : t("serviceBackups.oneForTables")}
            </p>
          ) : one !== null ? (
            <Field
              label={mongo ? t("serviceBackups.onlyCollections") : t("serviceBackups.onlyTables")}
              htmlFor="b-tables"
              hint={
                tablesLive.message ??
                (tablesOk && (tablesOk.tables ?? []).length === 0
                  ? mongo
                    ? t("serviceBackups.noCollections")
                    : t("serviceBackups.noTables")
                  : tables.some((k) => tablesOk && !liveTables.has(k))
                    ? t("serviceBackups.missingHint")
                    : tablesOk?.truncated
                      ? t("serviceBackups.tablesTruncated", { count: tablesOk.tables?.length ?? 0 })
                      : engine === "postgres" && tables.length > 0
                        ? t("serviceBackups.referencedTables")
                        : undefined)
              }
            >
              <MultiSelect
                id="b-tables"
                aria-label={mongo ? t("serviceBackups.onlyCollections") : t("serviceBackups.onlyTables")}
                options={(tablesOk?.tables ?? []).map((tab) => ({ value: tableKey(tab), label: tableLabel(tab), hint: sizeAndRows(tab) }))}
                value={tables}
                onValueChange={onTablesChange}
                labelOf={(key) => tableLabel(fromTableKey(key))}
                placeholder={t("serviceBackups.wholeDatabase")}
                searchPlaceholder={mongo ? t("serviceBackups.findCollection") : t("serviceBackups.findTable")}
                emptyText={t("serviceBackups.noMatch")}
                removeLabel={(name) => t("serviceBackups.remove", { name })}
                warn={(key) => (tablesOk && !liveTables.has(key) ? t("serviceBackups.missing") : null)}
                loading={tablesLive.state === "loading"}
                disabled={tablesLive.state !== "ok"}
              />
            </Field>
          ) : null}
          {databases.length === 0 && live.state === "ok" && ok && ok.databases.length > 0 && (
            <p className="m-0 -mt-1 text-[12.5px] text-muted-foreground">{t("serviceBackups.pickDatabase")}</p>
          )}
        </>
      )}
    </div>
  );
}
