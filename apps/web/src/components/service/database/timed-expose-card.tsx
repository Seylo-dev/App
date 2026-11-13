// The Connection tab's timed expose (exposures.openTimed on a database):
// the database's port on node-ip:port for one IP for a while, with the
// address, a connection URL (the password in it only for people who see
// the credentials, from databases.connection), the client command, which
// asks for the password, whether the database's own TLS applies, a live
// countdown, +1 hour and Close now. The node closes it on time by itself.

import { databases, exposures, OpError, type OpOutput } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { LoadingRegion, Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { IconLock } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { type MessageKey, t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { Field } from "../field";
import { formatClock } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, MutationError, OpErrorNote, retryOp } from "../op-state";
import { oneHourMore } from "../timed-extend";
import { useNow } from "../use-now";
import type { ServiceDetail } from "../use-service";
import { maskUrlPassword } from "./mask-url";

type Db = OpOutput<typeof databases.get>;
type Connection = OpOutput<typeof databases.connection>;
type Timed = OpOutput<typeof exposures.get>["timed"][number];

const durations = [15, 60, 120, 480, 1440] as const;

const fail = (error: unknown) =>
  toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

const durationLabel = (minutes: number) =>
  minutes < 60 ? t("serviceDomains.dev.minutes", { count: minutes }) : t("serviceDomains.dev.hours", { count: minutes / 60 });

/** "198.51.100.24" for a single address, the CIDR otherwise. */
const cidrList = (cidrs: string[]) => cidrs.map((c) => c.replace(/\/(32|128)$/, "")).join(", ");

const ownTls: Partial<Record<string, MessageKey>> = {
  postgres: "serviceDatabase.timed.tls.postgres",
  mysql: "serviceDatabase.timed.tls.mysql",
  mariadb: "serviceDatabase.timed.tls.mariadb",
};

export function TimedExposeCard({ service, db, conn }: { service: ServiceDetail; db: Db; conn: Connection | null }) {
  const access = useOp(exposures.get, { serviceId: service.id }, { retry: retryOp });
  const [adding, setAdding] = useState(false);
  // People who may not see the service's IP:port access do not get the card.
  if (access.error instanceof OpError && access.error.code === "FORBIDDEN") return null;
  const timed = access.data?.timed ?? [];
  return (
    <section
      aria-label={t("serviceDatabase.timed.title")}
      className="flex flex-col gap-3.5 rounded-card bg-card px-5 pt-[18px] pb-5 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("serviceDatabase.timed.title")}</h2>
        {timed.length > 0 ? (
          <Chip tone="green">
            <StatusDot status="ok" pulse />
            {t("serviceDatabase.timed.open")}
          </Chip>
        ) : (
          access.data && <Chip tone="gray">{t("serviceDatabase.timed.closed")}</Chip>
        )}
      </div>
      {access.isPending ? (
        <LoadingRegion label={t("common.loading")} className="flex flex-col gap-2.5">
          <Skeleton className="h-[38px]" />
          <Skeleton className="h-[38px] w-2/3" />
        </LoadingRegion>
      ) : access.isError ? (
        <OpErrorNote error={access.error} compact />
      ) : (
        <>
          {timed.map((x) => (
            <TimedRow key={x.id} service={service} db={db} conn={conn} x={x} />
          ))}
          {timed.length === 0 || adding ? (
            <OpenForm service={service} db={db} onDone={() => setAdding(false)} canCancel={timed.length > 0} />
          ) : (
            <Button size="sm" className="self-start bg-muted shadow-none" onClick={() => setAdding(true)}>
              {t("serviceDatabase.timed.openAnother")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function OpenForm({ service, db, onDone, canCancel }: { service: ServiceDetail; db: Db; onDone: () => void; canCancel: boolean }) {
  const [minutes, setMinutes] = useState(60);
  const [cidrs, setCidrs] = useState("");
  const [port, setPort] = useState(db.internal.port);
  const invalidate = useInvalidate();
  const open = useOpMutation(exposures.openTimed, {
    onSuccess: () => {
      invalidate(exposures.get, databases.connection);
      onDone();
    },
  });
  const list = cidrs
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const http = db.internal.httpPort ?? null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        open.mutate({ serviceId: service.id, targetPort: port, durationMinutes: minutes, ...(list.length ? { allowedCidrs: list } : {}) });
      }}
    >
      <p className="m-0 text-[13px] leading-normal text-ink-strong">
        {t("serviceDatabase.timed.body", { name: service.name, node: db.nodeName })}
      </p>
      <div className="flex flex-wrap items-end gap-2.5">
        <Field label={t("serviceDatabase.timed.duration")} className="w-[140px]">
          <Select value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}>
            <SelectTrigger aria-label={t("serviceDatabase.timed.duration")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {durations.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {durationLabel(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {/* ClickHouse also answers HTTP (JDBC drivers such as DBeaver's use it). */}
        {http !== null && (
          <Field label={t("serviceDatabase.timed.port")} className="w-[220px]">
            <Select value={String(port)} onValueChange={(v) => setPort(Number(v))}>
              <SelectTrigger aria-label={t("serviceDatabase.timed.port")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={String(db.internal.port)}>
                  {t("serviceDatabase.timed.portNative", { port: db.internal.port })}
                </SelectItem>
                <SelectItem value={String(http)}>{t("serviceDatabase.timed.portHttp", { port: http })}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field label={t("serviceDatabase.timed.allowedFrom")} htmlFor="db-timed-cidrs" className="min-w-[180px] flex-1">
          <Input
            id="db-timed-cidrs"
            className="font-mono"
            value={cidrs}
            onChange={(e) => setCidrs(e.target.value)}
            placeholder={t("serviceDatabase.timed.yourIp")}
          />
        </Field>
      </div>
      <span className="-mt-1 text-xs text-muted-foreground">{t("serviceDatabase.timed.allowedHint")}</span>
      <MutationError error={open.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={open.isPending}>
          {list.length
            ? t("serviceDatabase.timed.openFor", { duration: durationLabel(minutes) })
            : t("serviceDatabase.timed.openFromMyIp", { duration: durationLabel(minutes) })}
        </Button>
        {canCancel && (
          <Button size="sm" variant="ghost" onClick={onDone}>
            {t("service.cancel")}
          </Button>
        )}
      </div>
    </form>
  );
}

function TimedRow({ service, db, conn, x }: { service: ServiceDetail; db: Db; conn: Connection | null; x: Timed }) {
  const now = useNow(1000);
  const invalidate = useInvalidate();
  const close = useOpMutation(exposures.close, { onSuccess: () => invalidate(exposures.get, databases.connection), onError: fail });
  const extend = useOpMutation(exposures.extendTimed, { onSuccess: () => invalidate(exposures.get), onError: fail });
  const left = Date.parse(x.expiresAt) - now;
  // The node closed it on time: read the list again, so the row goes (the panel's sweep follows within a minute).
  const ended = useRef(false);
  useEffect(() => {
    if (left > 0 || ended.current) return;
    ended.current = true;
    invalidate(exposures.get, databases.connection);
  }, [left, invalidate]);
  const access = x.database;
  const withPassword = conn?.timed.find((c) => c.exposureId === x.id)?.url ?? null;
  const by = t(`serviceDomains.dev.by.${x.openedBy.kind}`, { name: x.openedBy.name });
  const tlsKey = access?.tls === "database" ? ownTls[access.engine] : undefined;
  return (
    <div className="flex flex-col gap-2.5 rounded-card bg-highlight px-4 py-3.5" data-testid="timed-expose">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="rounded-chip bg-button px-2 py-1 font-mono shadow-button">
          {x.port ? `${x.host}:${x.port}` : t("serviceDatabase.timed.opening")}
        </span>
        <span className="text-ink-strong">{t("serviceDatabase.timed.onlyFrom", { cidrs: cidrList(x.allowedCidrs) })}</span>
      </div>
      {access?.url && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-strong">
            {withPassword ? t("serviceDatabase.timed.url") : t("serviceDatabase.timed.urlNoPassword")}
          </span>
          {withPassword ? (
            <CopyField value={withPassword} secret masked={maskUrlPassword(withPassword)} aria-label={t("serviceDatabase.timed.url")} />
          ) : (
            <CopyField value={access.url} aria-label={t("serviceDatabase.timed.urlNoPassword")} />
          )}
        </div>
      )}
      {access?.command && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-strong">{t("serviceDatabase.timed.command")}</span>
          <CopyField value={access.command} prefix="$" tone="terminal" aria-label={t("serviceDatabase.timed.command")} />
          <span className="text-xs text-muted-foreground">
            {conn ? t("serviceDatabase.timed.asksPassword") : t("serviceDatabase.timed.asksPasswordHidden")}
          </span>
        </div>
      )}
      {access &&
        (tlsKey ? (
          <p role="note" className="m-0 flex items-start gap-1.5 text-[12.5px] leading-normal text-chip-green-fg">
            <IconLock size={13} stroke={2.4} className="mt-0.5 shrink-0" />
            {t(tlsKey)}
          </p>
        ) : (
          <p role="note" className="m-0 rounded-control bg-chip-amber-bg px-3 py-2.5 text-[12.5px] leading-normal text-chip-amber-fg">
            {t("serviceDatabase.timed.plain", { engine: t(`service.kind.${db.engine}`), cidrs: cidrList(x.allowedCidrs) })}
          </p>
        ))}
      {x.firewallHint && (
        <div className="flex flex-col gap-1.5 text-xs text-chip-amber-fg">
          <span>{t("serviceDomains.dev.firewall")}</span>
          <CopyField value={x.firewallHint} tone="terminal" aria-label={t("serviceDomains.dev.firewall")} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-strong">
        {t("serviceDatabase.timed.closesIn")} <b className="font-mono font-semibold text-foreground">{formatClock(Math.max(0, left))}</b> ·{" "}
        {by}
        <span className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            className="h-[30px] bg-card"
            disabled={extend.isPending}
            onClick={() => extend.mutate({ serviceId: service.id, exposureId: x.id, durationMinutes: oneHourMore(left) })}
          >
            {t("serviceDomains.dev.extend")}
          </Button>
          <Button
            size="sm"
            className="h-[30px] bg-chip-red-bg text-chip-red-fg shadow-none"
            disabled={close.isPending}
            onClick={() => close.mutate({ serviceId: service.id, exposureId: x.id })}
          >
            {t("serviceDomains.dev.closeNow")}
          </Button>
        </span>
      </div>
    </div>
  );
}
