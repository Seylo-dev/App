// The Connection tab of a database (Database.dc.html): the internal URL
// for services on the same node, the exposed URL with TLS for everything
// else (toggle, allowed IPs, certificate; the same user and password as
// inside; connections without TLS as an opt-in that asks first), the
// timed expose for one IP (timed-expose-card.tsx), the
// on-demand web UI, a pre-logged-in shell, the backup
// summary, and Change links next to the user and the password, which open
// the Users tab (users-page.tsx) with the main user's dialog.

import { allowListOpensToEveryone, backups, databases, type OpOutput, widensAllowList } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { CopyCode } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { Textarea } from "@seylo/ui/components/textarea";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconLock, IconLockOpen, IconTable, IconTerminal2 } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { useBackUpNow } from "../backups/back-up-now";
import { describeCron } from "../cron-text";
import { Field } from "../field";
import { formatBytes, formatDateTime, formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, MutationError, OpErrorNote, retryOp } from "../op-state";
import { ConsoleCard, consoleCardHeight } from "../overview/overview-page";
import { DatabaseShell } from "../terminal/console-pages";
import type { ServiceDetail } from "../use-service";
import { maskUrlPassword } from "./mask-url";
import { SelfSignedNote } from "./self-signed-note";
import { TimedExposeCard } from "./timed-expose-card";

type Db = OpOutput<typeof databases.get>;
type Connection = OpOutput<typeof databases.connection>;
const fail = (error: unknown) =>
  toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

function Section({
  label,
  title,
  badge,
  actions,
  children,
}: {
  label: string;
  title: string;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-3.5 rounded-card bg-card px-5 pt-[18px] pb-5 shadow-card">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {badge}
        {actions && <span className="ml-auto flex items-center gap-2">{actions}</span>}
      </div>
      {children}
    </section>
  );
}

export function ConnectionPage({ service }: { service: ServiceDetail }) {
  // The web UI sleeps on its own after idle minutes; re-read now and then while it runs.
  const db = useOp(
    databases.get,
    { serviceId: service.id },
    { retry: retryOp, refetchInterval: (q) => (q.state.data?.webUi.running ? 30_000 : false) },
  );
  const conn = useOp(databases.connection, { serviceId: service.id }, { retry: retryOp });
  if (db.isPending) return <ConnectionSkeleton />;
  if (db.isError) return <OpErrorNote error={db.error} />;
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-4">
        <InternalCard service={service} db={db.data} conn={conn.data ?? null} connError={conn.error} />
        <ExposedCard service={service} db={db.data} conn={conn.data ?? null} />
        {/* The port for one IP for a while, for a client on a laptop: exposures.openTimed. */}
        <TimedExposeCard service={service} db={db.data} conn={conn.data ?? null} />
        {/* The database's own output, watched like an app's Overview console (a shell is under Tools). */}
        <ConsoleCard service={service} height={consoleCardHeight} fullLink={false} />
      </div>
      <div className="flex max-w-[400px] min-w-0 flex-[1_1_320px] flex-col gap-4">
        <ToolsCard service={service} db={db.data} />
        <BackupsSummary service={service} />
      </div>
    </div>
  );
}

/** Both columns while the database loads: the connection cards on the left, tools and backups on the right. */
function ConnectionSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-4">
        <SectionCardSkeleton titleWidth="w-36" description={false}>
          <SkeletonText className="w-24 text-[12.5px]" />
          <Skeleton className="-mt-1.5 h-[38px]" />
          <div className="flex flex-wrap gap-2.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex min-w-[104px] flex-1 flex-col gap-[5px]">
                <SkeletonText className="w-12 text-xs" />
                <Skeleton className="h-[35.5px]" />
              </div>
            ))}
          </div>
        </SectionCardSkeleton>
        <SectionCardSkeleton titleWidth="w-32" description="w-80">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <SkeletonText className="w-40 text-[13.5px]" />
              <SkeletonText className="w-64 text-[12.5px]" />
            </div>
            <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
          </div>
        </SectionCardSkeleton>
      </div>
      <div className="flex max-w-[400px] min-w-0 flex-[1_1_320px] flex-col gap-4">
        <SectionCardSkeleton titleWidth="w-20" description="w-56">
          <ButtonSkeleton size="sm" className="w-28" />
          <ButtonSkeleton size="sm" className="w-24" />
        </SectionCardSkeleton>
        <SectionCardSkeleton titleWidth="w-24" description="w-48">
          <SkeletonText className="w-40 text-[13px]" />
          <SkeletonText className="w-32 text-[13px]" />
        </SectionCardSkeleton>
      </div>
    </LoadingRegion>
  );
}

/**
 * A label over a value. A tile starts as wide as its value and the row's
 * tiles share what is left, so a generated user name stays on one line;
 * a value wider than the card still wraps instead of ending in an ellipsis.
 */
function Tile({ label, value, secret = false, action }: { label: string; value: string; secret?: boolean; action?: ReactNode }) {
  return (
    <div className="flex min-w-[104px] max-w-full flex-[1_1_auto] flex-col gap-[5px]">
      <TileLabel label={label} action={action} />
      <span className="flex-1 rounded-control bg-field px-[11px] py-2 font-mono text-[13px] [overflow-wrap:anywhere]">
        {secret ? "••••••••" : value || "-"}
      </span>
    </div>
  );
}

function TileLabel({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      {action && <span className="ml-auto">{action}</span>}
    </span>
  );
}

/**
 * The tiles' Change link: the Users tab, with the main user's name or
 * password dialog open. Only for people who see the credentials
 * (databases.connection answered), who may change them there too.
 */
function ChangeLink({ service, change }: { service: ServiceDetail; change: "name" | "password" }) {
  return (
    <Link
      to="/p/$projectId/s/$serviceId/users"
      params={{ projectId: service.projectId, serviceId: service.id }}
      search={{ change }}
      aria-label={change === "name" ? t("serviceDatabase.changeUser") : t("serviceDatabase.changePassword")}
      className="cursor-pointer font-medium text-link transition-colors duration-200"
    >
      {t("serviceDatabase.change")}
    </Link>
  );
}

/** The password, hidden until the eye shows it (the Connection URL's field), with copy; dots while it loads. */
function PasswordTile({ password, action }: { password: string | null; action?: ReactNode }) {
  if (password === null) return <Tile label={t("serviceDatabase.password")} value="" secret />;
  return (
    <div className="flex min-w-[180px] max-w-full flex-[1_1_auto] flex-col gap-[5px]">
      <TileLabel label={t("serviceDatabase.password")} action={action} />
      <CopyField value={password} secret aria-label={t("serviceDatabase.password")} />
    </div>
  );
}

/** The Change links of the User and Password tiles; the Redis-like engines' one user has no other name. */
function changeLinks(service: ServiceDetail, db: Db, conn: Connection | null) {
  if (!conn) return { user: undefined, password: undefined };
  const redisLike = db.internal.database === "";
  return {
    user: redisLike ? undefined : <ChangeLink service={service} change="name" />,
    password: <ChangeLink service={service} change="password" />,
  };
}

function InternalCard({ service, db, conn, connError }: { service: ServiceDetail; db: Db; conn: Connection | null; connError: unknown }) {
  const links = changeLinks(service, db, conn);
  return (
    <Section
      label={t("serviceDatabase.internal")}
      title={t("serviceDatabase.internal")}
      badge={<span className="text-[12.5px] text-muted-foreground">{t("serviceDatabase.internalFor", { node: db.nodeName })}</span>}
    >
      <span className="text-[12.5px] font-medium text-ink-strong">{t("serviceDatabase.url")}</span>
      {conn ? (
        <CopyField
          value={conn.internal.url}
          secret
          masked={maskUrlPassword(conn.internal.url)}
          aria-label={t("serviceDatabase.url")}
          className="-mt-1.5"
        />
      ) : connError ? (
        <OpErrorNote error={connError} compact />
      ) : (
        <Skeleton className="h-[38px]" />
      )}
      {db.internal.httpPort != null && (
        <>
          <span className="text-[12.5px] font-medium text-ink-strong">{t("serviceDatabase.httpUrl")}</span>
          {conn ? (
            conn.internal.httpUrl && (
              <CopyField
                value={conn.internal.httpUrl}
                secret
                masked={maskUrlPassword(conn.internal.httpUrl)}
                aria-label={t("serviceDatabase.httpUrl")}
                className="-mt-1.5"
              />
            )
          ) : connError ? null : (
            <Skeleton className="h-[38px]" />
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2.5">
        <Tile label={t("serviceDatabase.host")} value={db.internal.host} />
        <Tile label={t("serviceDatabase.port")} value={String(db.internal.port)} />
        {db.internal.httpPort != null && <Tile label={t("serviceDatabase.httpPort")} value={String(db.internal.httpPort)} />}
        {db.internal.database !== "" && <Tile label={t("serviceDatabase.database")} value={db.internal.database} />}
        <Tile label={t("serviceDatabase.user")} value={db.internal.user} action={links.user} />
        <PasswordTile password={conn?.internal.password ?? null} action={links.password} />
      </div>
      {db.variant === "pgvector" && (
        <p className="m-0 text-[12.5px] leading-normal text-ink-strong">
          {t("serviceDatabase.pgvectorBefore")} <CopyCode code="CREATE EXTENSION vector;" /> {t("serviceDatabase.pgvectorAfter")}
        </p>
      )}
    </Section>
  );
}

function ExposedCard({ service, db, conn }: { service: ServiceDetail; db: Db; conn: Connection | null }) {
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState(false);
  const set = useOpMutation(databases.setExposure, {
    onSuccess: () => invalidate(databases.get, databases.connection),
    onError: fail,
  });
  const e = db.exposure;
  const links = changeLinks(service, db, conn);
  // On, but closed until the node's agent can keep the port TLS only: the setting stays and reopens by itself.
  const waiting = e.state === "waitingForNodeUpdate";
  return (
    <Section
      label={t("serviceDatabase.exposed")}
      title={t("serviceDatabase.exposed")}
      badge={
        e.enabled &&
        !waiting &&
        (plainAccepted(db) ? (
          <Chip tone="amber">
            <IconLockOpen size={11} stroke={2.6} />
            {t("serviceDatabase.plain.chip")}
          </Chip>
        ) : (
          <Chip tone="green">
            <IconLock size={11} stroke={2.6} />
            {t("serviceDatabase.sslRequired")}
          </Chip>
        ))
      }
      actions={
        <span className="flex items-center gap-2.5 text-[13px]">
          <Switch
            id="db-exposed"
            checked={e.enabled}
            disabled={set.isPending}
            onCheckedChange={(on) =>
              // On: the port (and who may connect) first; the switch turns on once the dialog exposes it.
              on ? setEditing(true) : set.mutate({ serviceId: service.id, enabled: false })
            }
          />
          <label htmlFor="db-exposed" className="cursor-pointer">
            {t("serviceDatabase.exposedToggle")}
          </label>
        </span>
      }
    >
      {!e.enabled ? (
        <p className="m-0 text-[13px] leading-normal text-ink-strong">{t("serviceDatabase.notExposed")}</p>
      ) : waiting ? (
        <p role="note" className="m-0 rounded-control bg-chip-amber-bg px-3 py-2.5 text-[12.5px] leading-normal text-chip-amber-fg">
          {t("serviceDatabase.waitingForNode", { node: db.nodeName })}
        </p>
      ) : (
        <>
          {conn?.exposed ? (
            <CopyField
              value={conn.exposed.url}
              secret
              masked={maskUrlPassword(conn.exposed.url)}
              aria-label={t("serviceDatabase.exposedUrl")}
            />
          ) : (
            <span className="rounded-control bg-field px-3 py-2.5 font-mono text-[12.5px]">
              {e.host && e.port ? `${e.host}:${e.port}` : t("serviceDatabase.opening")}
            </span>
          )}
          {/* Exposing only opens the port: the database's own login, the same password as the internal card's. */}
          <div className="flex flex-wrap gap-2.5">
            <Tile label={t("serviceDatabase.host")} value={conn?.exposed?.host ?? e.host ?? ""} />
            <Tile label={t("serviceDatabase.port")} value={String(conn?.exposed?.port ?? e.port ?? "")} />
            {db.internal.database !== "" && <Tile label={t("serviceDatabase.database")} value={db.internal.database} />}
            <Tile label={t("serviceDatabase.user")} value={e.user} action={links.user} />
            <PasswordTile password={conn?.exposed?.password ?? conn?.internal.password ?? null} action={links.password} />
          </div>
          <div className="flex flex-wrap gap-x-[18px] gap-y-2 text-[12.5px] leading-normal text-ink-strong">
            <span>
              {t("serviceDatabase.sameUserBefore")}{" "}
              <b className="rounded-[5px] bg-field px-[5px] py-px font-mono text-xs font-medium text-foreground">{e.user}</b>{" "}
              {t(plainAccepted(db) ? "serviceDatabase.sameUserAfterPlain" : "serviceDatabase.sameUserAfter")}
            </span>
            <span>
              {t("serviceDatabase.allowedFrom")}{" "}
              <b className="font-medium text-foreground">
                {e.allowedCidrs.length ? e.allowedCidrs.join(", ") : t("serviceDatabase.anywhere")}
              </b>{" "}
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 font-medium text-link"
                onClick={() => setEditing(true)}
              >
                {e.allowedCidrs.length ? t("service.edit") : t("serviceDatabase.limit")}
              </button>
            </span>
            <span>
              {t("serviceDatabase.certificate")}: {t(`serviceDatabase.cert.${e.certificate}`)}
              {e.tlsHostname ? ` · ${e.tlsHostname}` : ""}
              {/* A self-signed certificate's issuer is its own name: the note below says what it is instead. */}
              {e.certificateIssuer && !e.selfSignedReason ? ` · ${t("serviceDatabase.certIssuer", { issuer: e.certificateIssuer })}` : ""}
              {e.certificateExpiresAt ? ` · ${t("serviceDatabase.certExpires", { date: formatDateTime(e.certificateExpiresAt) })}` : ""}
            </span>
          </div>
          <SelfSignedNote db={db} serviceName={service.name} />
          <PlainRow service={service} db={db} />
          {/* Muted, as buttons inside a card are; the user and password change on the Users tab. */}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="bg-muted shadow-none" onClick={() => setEditing(true)}>
              {t("serviceDatabase.portAndAccess")}
            </Button>
          </div>
        </>
      )}
      {editing && <ExposureDialog service={service} db={db} onClose={() => setEditing(false)} />}
    </Section>
  );
}

/** Clients without TLS get through the open port: allowed, and the node's agent can (0.2.16). */
function plainAccepted(db: Db): boolean {
  return db.exposure.allowPlain && !db.exposure.plainNeedsNodeUpdate;
}

/** The agent version that takes clients without TLS (the panel's plainExposureVersion). */
const plainAgentVersion = "0.2.16";

/** Engines whose clients send the password as it is: the Redis protocol's AUTH, ClickHouse's native Hello. */
const passwordInClear = new Set(["redis", "valkey", "keydb", "dragonfly", "clickhouse"]);

/**
 * Connections without TLS: a switch with what it means now. Turning it on
 * asks first (PlainWarning); turning it off does not. Disabled while the
 * node's agent is older than 0.2.16 and it is off.
 */
function PlainRow({ service, db }: { service: ServiceDetail; db: Db }) {
  const invalidate = useInvalidate();
  const [asking, setAsking] = useState(false);
  const set = useOpMutation(databases.setExposure, {
    onSuccess: () => invalidate(databases.get, databases.connection),
    onError: fail,
  });
  const e = db.exposure;
  const hint = e.plainNeedsNodeUpdate
    ? t(e.allowPlain ? "serviceDatabase.plain.waitingForAgent" : "serviceDatabase.plain.needsAgent", {
        version: plainAgentVersion,
        node: db.nodeName,
      })
    : e.allowPlain
      ? t("serviceDatabase.plain.on")
      : t("serviceDatabase.plain.off");
  return (
    <div className="flex items-start gap-3 rounded-control bg-field px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor="db-plain" className="cursor-pointer text-[13px] font-medium text-foreground">
          {t("serviceDatabase.plain.label")}
        </label>
        <span id="db-plain-hint" className="text-[12.5px] leading-normal text-ink-strong">
          {hint}
        </span>
        {plainAccepted(db) && db.engine === "mysql" && (
          <span className="text-[12.5px] leading-normal text-ink-strong">{t("serviceDatabase.plain.mysqlKey")}</span>
        )}
      </span>
      <Switch
        id="db-plain"
        aria-describedby="db-plain-hint"
        className="mt-0.5 shrink-0"
        checked={e.allowPlain}
        // Off on an older agent: nothing to turn on yet. On there, it can still be turned off.
        disabled={set.isPending || (e.plainNeedsNodeUpdate && !e.allowPlain)}
        onCheckedChange={(on) => (on ? setAsking(true) : set.mutate({ serviceId: service.id, enabled: true, allowPlain: false }))}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        destructive={allowListOpensToEveryone(e.allowedCidrs)}
        title={t("serviceDatabase.plain.confirm.title")}
        description={t("serviceDatabase.plain.confirm.body", { name: service.name })}
        confirmLabel={t("serviceDatabase.plain.confirm.button")}
        onConfirm={async () => {
          await set.mutateAsync({ serviceId: service.id, enabled: true, allowPlain: true });
        }}
      >
        <PlainWarning db={db} />
      </ConfirmDialog>
    </div>
  );
}

/**
 * What the confirmation adds to its description: the password itself for
 * engines that send it as it is, who can connect (in strong words when the
 * port is open to every IP: no allowed IPs, or ones that cover every
 * address, such as 0.0.0.0/0), and what to prefer. allowedCidrs is the
 * allow list it applies to: the saved one, or the one about to be saved.
 */
export function PlainWarning({ db, allowedCidrs = db.exposure.allowedCidrs }: { db: Db; allowedCidrs?: string[] }) {
  const open = allowListOpensToEveryone(allowedCidrs);
  return (
    <div className="flex flex-col gap-2 text-[12.5px] leading-normal">
      {passwordInClear.has(db.engine) && <p className="m-0 text-ink-strong">{t("serviceDatabase.plain.confirm.passwordInClear")}</p>}
      {open ? (
        <p role="note" className="m-0 rounded-control bg-chip-red-bg px-3 py-2.5 font-medium text-chip-red-fg">
          {t("serviceDatabase.plain.confirm.openToEveryone")}
        </p>
      ) : (
        <p role="note" className="m-0 rounded-control bg-chip-amber-bg px-3 py-2.5 text-chip-amber-fg">
          {t("serviceDatabase.plain.confirm.limited", { cidrs: allowedCidrs.join(", ") })}
        </p>
      )}
      <p className="m-0 text-ink-strong">{t("serviceDatabase.plain.confirm.prefer")}</p>
    </div>
  );
}

/**
 * Saving this allow list opens a port that takes clients without TLS to
 * every IP: while connections without TLS are allowed, the list empties
 * or covers every address (0.0.0.0/0, ::/0, 0.0.0.0/1 with 128.0.0.0/1),
 * and lets in addresses the saved one did not. The panel's audit and a
 * model's approval read lists the same way (@seylo/ops allow-lists.ts).
 * A list as open as the saved one is not new (turning plain on said so).
 */
export function opensPlainToEveryone(db: Db, allowedCidrs: string[]): boolean {
  return db.exposure.allowPlain && allowListOpensToEveryone(allowedCidrs) && widensAllowList(db.exposure.allowedCidrs, allowedCidrs);
}

/**
 * Exposure settings, and the step before exposing: the port the node opens
 * (empty lets it pick a free one), who may connect and the certificate's
 * name. Submitting exposes a database that is not exposed yet. Saving an
 * allow list that lets every IP in (empty, or a catch-all such as
 * 0.0.0.0/0) while connections without TLS are allowed asks first, with
 * the same warning as turning them on there.
 */
function ExposureDialog({ service, db, onClose }: { service: ServiceDetail; db: Db; onClose: () => void }) {
  const exposing = !db.exposure.enabled;
  const node = service.placements[0]?.nodeName ?? "";
  const [cidrs, setCidrs] = useState(db.exposure.allowedCidrs.join("\n"));
  const [tlsHostname, setTls] = useState(db.exposure.tlsHostname ?? "");
  const [port, setPort] = useState(db.exposure.port ? String(db.exposure.port) : "");
  const [asking, setAsking] = useState(false);
  const invalidate = useInvalidate();
  const set = useOpMutation(databases.setExposure, {
    onSuccess: () => {
      invalidate(databases.get, databases.connection);
      onClose();
    },
  });
  const input = () => ({
    serviceId: service.id,
    enabled: true,
    allowedCidrs: cidrs
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    tlsHostname: tlsHostname.trim() || null,
    ...(validPort(port) ? { port: Number(port) } : {}),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[12%]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const next = input();
            if (opensPlainToEveryone(db, next.allowedCidrs)) setAsking(true);
            else set.mutate(next);
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>
              {exposing ? t("serviceDatabase.exposeTitle", { name: service.name }) : t("serviceDatabase.exposureTitle")}
            </DialogTitle>
            <DialogDescription>
              {exposing ? t("serviceDatabase.exposeBody", { node }) : t("serviceDatabase.exposureBody")}
            </DialogDescription>
          </div>
          <Field
            label={t("serviceDatabase.publicPort")}
            htmlFor="x-port"
            hint={t(exposing ? "serviceDatabase.publicPortNewHint" : "serviceDatabase.publicPortHint")}
          >
            <Input
              id="x-port"
              inputMode="numeric"
              className="max-w-[200px] font-mono"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={t("serviceDatabase.publicPortAuto")}
              autoFocus={exposing}
            />
          </Field>
          {db.exposure.needsAllowedCidrs && (
            <p role="note" className="m-0 rounded-control bg-chip-amber-bg px-3 py-2.5 text-[12.5px] leading-normal text-chip-amber-fg">
              {t("serviceDatabase.allowlistRequired")}
            </p>
          )}
          <Field label={t("serviceDatabase.allowedIps")} htmlFor="x-cidrs" hint={t("serviceDomains.access.allowlistHint")}>
            <Textarea id="x-cidrs" mono rows={3} value={cidrs} onChange={(e) => setCidrs(e.target.value)} />
          </Field>
          <Field label={t("serviceDatabase.tlsHostname")} htmlFor="x-tls" hint={t("serviceDatabase.tlsHostnameHint")}>
            <Input
              id="x-tls"
              className="font-mono"
              value={tlsHostname}
              onChange={(e) => setTls(e.target.value)}
              placeholder="db.example.com"
            />
          </Field>
          <MutationError error={set.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={set.isPending || (port.trim() !== "" && !validPort(port))}>
              {exposing ? t("serviceDatabase.exposeButton") : t("service.save")}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          destructive
          title={t("serviceDatabase.plain.openConfirm.title")}
          description={t("serviceDatabase.plain.openConfirm.body", { name: service.name })}
          confirmLabel={t("serviceDatabase.plain.openConfirm.button")}
          onConfirm={async () => {
            await set.mutateAsync(input());
          }}
        >
          <PlainWarning db={db} allowedCidrs={input().allowedCidrs} />
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}

/** A port the node may open for it: a whole number from 1024 to 65535. */
function validPort(text: string): boolean {
  const p = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(p) && p >= 1024 && p <= 65535;
}

function ToolsCard({ service, db }: { service: ServiceDetail; db: Db }) {
  const [shell, setShell] = useState(false);
  const invalidate = useInvalidate();
  const web = useOpMutation(databases.openWebUi, {
    onSuccess: (res) => {
      window.open(res.url, "_blank", "noopener");
      // The tool starts on that first visit; the node reports it running a few seconds later.
      setTimeout(() => invalidate(databases.get), 8000);
    },
    onError: fail,
  });
  const shellName = db.shellClient;
  return (
    <section aria-label={t("serviceDatabase.tools")} className="flex flex-col rounded-card bg-card px-5 pt-[18px] pb-2 shadow-card">
      <h2 className="m-0 mb-2 text-[15px] font-semibold">{t("serviceDatabase.tools")}</h2>
      <ToolRow
        icon={<IconTable size={15} stroke={2} />}
        tone="blue"
        name={db.webUi.tool}
        status={
          db.webUi.running ? (
            <Chip tone="green">
              <StatusDot status="ok" pulse />
              {t("serviceDatabase.webUiRunning")}
            </Chip>
          ) : (
            <Chip tone="gray">
              <StatusDot status="off" />
              {t("serviceDatabase.webUiSleeping")}
            </Chip>
          )
        }
        hint={
          db.webUi.running && db.webUi.lastActiveAt
            ? t("serviceDatabase.webUiActive", { when: formatRelative(db.webUi.lastActiveAt), minutes: db.webUi.idleMinutes })
            : t("serviceDatabase.webUiHint", { minutes: db.webUi.idleMinutes })
        }
        action={
          <Button size="sm" variant="primary" onClick={() => web.mutate({ serviceId: service.id })} disabled={web.isPending}>
            {t("serviceDatabase.open")}
          </Button>
        }
      />
      <ToolRow
        icon={<IconTerminal2 size={15} stroke={2} />}
        tone="gray"
        name={shellName}
        hint={
          db.internal.database === ""
            ? t("serviceDatabase.shellHintRedis")
            : t("serviceDatabase.shellHint", { database: db.internal.database })
        }
        action={
          <Button size="sm" className="bg-muted shadow-none" onClick={() => setShell(true)}>
            {t("serviceDatabase.open")}
          </Button>
        }
      />
      <Sheet open={shell} onOpenChange={setShell}>
        <SheetContent side="bottom" className="h-[70dvh] gap-3 p-4">
          <SheetHeader className="px-1 pt-1">
            <SheetTitle>{t("serviceDatabase.shellTitle", { client: shellName, name: service.name })}</SheetTitle>
            <SheetDescription>{t("serviceDatabase.shellSubtitle")}</SheetDescription>
          </SheetHeader>
          {shell && <DatabaseShell service={service} minHeight={0} />}
        </SheetContent>
      </Sheet>
    </section>
  );
}

function ToolRow({
  icon,
  tone,
  name,
  status,
  hint,
  action,
}: {
  icon: ReactNode;
  tone: "blue" | "gray";
  name: string;
  status?: ReactNode;
  hint: string;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-divider py-3">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-control",
          tone === "blue" ? "bg-chip-blue-bg text-chip-blue-fg" : "bg-muted text-ink-strong",
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <b className="text-[13.5px] font-semibold">{name}</b>
          {status}
        </span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      <span className="ml-auto shrink-0">{action}</span>
    </div>
  );
}

/** The Backups card: its Back up now is the Backups tab's (every enabled schedule, or a one-off dump without one). */
function BackupsSummary({ service }: { service: ServiceDetail }) {
  const policies = useOp(backups.listPolicies, { serviceId: service.id }, { retry: retryOp });
  const destinations = useOp(backups.listDestinations, {}, { retry: retryOp });
  const runs = useOp(backups.listRuns, { serviceId: service.id, limit: 3 }, { retry: retryOp });
  const policy = policies.data?.policies[0];
  const backUpNow = useBackUpNow(service, policies.data?.policies, destinations.data?.choices ?? []);
  return (
    <section aria-label={t("service.tabs.backups")} className="flex flex-col gap-1 rounded-card bg-card px-5 pt-[18px] pb-2 shadow-card">
      <div className="flex items-center">
        <h2 className="m-0 text-[15px] font-semibold">{t("service.tabs.backups")}</h2>
        <Button size="sm" className="ml-auto bg-muted shadow-none" disabled={backUpNow.disabled} onClick={backUpNow.run}>
          {t("serviceBackups.backUpNow")}
        </Button>
      </div>
      {policies.isError ? (
        <OpErrorNote error={policies.error} compact />
      ) : (
        <span className="pb-2 text-[12.5px] text-ink-strong">
          {policy ? (
            t("serviceBackups.policyLine", {
              schedule: describeCron(policy.schedule),
              destination: policy.destinationName,
              keep: policy.keepLast,
            })
          ) : (
            <Link to="/p/$projectId/s/$serviceId/backups" params={{ projectId: service.projectId, serviceId: service.id }}>
              {t("serviceDatabase.scheduleBackups")}
            </Link>
          )}
        </span>
      )}
      {runs.data?.runs.map((r) => (
        <div key={r.id} className="flex items-center gap-3 border-t border-divider py-2.5 text-[13px]">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              r.status === "failed" ? "bg-chip-red-bg" : "bg-chip-green-bg",
            )}
          >
            <span className={cn("size-2 rounded-full", r.status === "failed" ? "bg-status-error" : "bg-status-ok")} />
          </span>
          <b className="font-medium">{formatDateTime(r.startedAt)}</b>
          <span className="ml-auto text-[12.5px] text-muted-foreground">{r.sizeBytes != null ? formatBytes(r.sizeBytes) : ""}</span>
        </div>
      ))}
    </section>
  );
}
