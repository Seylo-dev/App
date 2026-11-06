// One domain in the Domains card (Domains.dc.html): state tile, URL, chips,
// where it routes, certificate or DNS state, a menu of actions, and for a
// domain still waiting on DNS, the record to create with a Cloudflare link.

import { domains, type OpOutput } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { useCopy } from "@seylo/ui/components/copy-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@seylo/ui/components/dropdown-menu";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconArrowUpRight,
  IconCheck,
  IconClock,
  IconCopy,
  IconCornerDownRight,
  IconDots,
  IconLock,
  IconLockOpen,
} from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { formatDate, formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, OpErrorNote, retryOp } from "../op-state";

export type Domain = OpOutput<typeof domains.list>["domains"][number];
export type DomainDialog = "routing" | "access" | "certificate";

type Tone = "ok" | "busy" | "error" | "off";

function domainTone(d: Domain): Tone {
  if (d.forward) return "ok";
  if (d.dnsStatus === "wrongTarget" || d.certificate.status === "failed") return "error";
  if (!d.auto && d.dnsStatus !== "ok" && d.dnsStatus !== "proxied") return "busy";
  if (d.https !== "off" && d.certificate.status !== "valid") return "busy";
  return "ok";
}

const tileTone: Record<Tone, string> = {
  ok: "bg-chip-green-bg text-status-ok",
  busy: "bg-chip-amber-bg text-status-busy",
  error: "bg-chip-red-bg text-status-error",
  off: "bg-muted text-muted-foreground",
};

export function DomainRow({
  serviceId,
  serviceName,
  domain: d,
  onEdit,
}: {
  serviceId: string;
  serviceName: string;
  domain: Domain;
  onEdit: (dialog: DomainDialog) => void;
}) {
  const tone = domainTone(d);
  const waiting = !d.auto && !d.forward && d.dnsStatus !== "ok" && d.dnsStatus !== "proxied";
  const [confirm, setConfirm] = useState(false);
  const invalidate = useInvalidate();
  const fail = (error: unknown) =>
    toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));
  const primary = useOpMutation(domains.setPrimary, { onSuccess: () => invalidate(domains.list), onError: fail });
  const remove = useOpMutation(domains.remove, { onSuccess: () => invalidate(domains.list) });
  const mw = d.middlewares;
  const Icon = d.forward
    ? IconCornerDownRight
    : tone === "error"
      ? IconAlertTriangle
      : tone === "busy"
        ? IconClock
        : d.https === "off"
          ? IconLockOpen
          : IconLock;

  return (
    <div className={cn("flex flex-col gap-3 border-t border-divider px-5 py-3", waiting && "bg-chip-amber-bg/40 pb-4")}>
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", tileTone[tone])}>
          <Icon size={14} stroke={2.2} />
        </span>
        {d.forward || waiting ? (
          <span className="font-mono text-[13px] font-medium">{d.url}</span>
        ) : (
          <a href={d.url} target="_blank" rel="noreferrer" className="font-mono text-[13px] font-medium">
            {d.url}
          </a>
        )}
        {d.primary && <Chip tone="blue">{t("serviceDomains.primary")}</Chip>}
        {d.auto && <Chip tone="gray">{t("serviceDomains.auto")}</Chip>}
        <span className="flex items-center gap-3">
          <IconArrowRight size={14} stroke={2} className="text-ink-ghost" aria-hidden="true" />
          {d.forward ? (
            <span className="text-[12.5px] text-ink-strong">
              {t("serviceDomains.forwardTo", { code: d.forward.permanent ? "308" : "307", url: d.forward.url.replace(/^https?:\/\//, "") })}
            </span>
          ) : (
            <span className="font-mono text-[12.5px] text-ink-strong">
              {serviceName}:{d.targetPort}
              {d.pathPrefix !== "/" ? d.pathPrefix : ""}
            </span>
          )}
        </span>
        {mw.basicAuth && <Chip tone="gray">{t("serviceDomains.chips.basicAuth")}</Chip>}
        {mw.ipAllowList.length > 0 && <Chip tone="gray">{t("serviceDomains.chips.allowlist", { count: mw.ipAllowList.length })}</Chip>}
        {mw.rateLimit && <Chip tone="gray">{t("serviceDomains.chips.rateLimit", { average: mw.rateLimit.average })}</Chip>}
        {mw.redirects.length > 0 && <Chip tone="gray">{t("serviceDomains.chips.redirects", { count: mw.redirects.length })}</Chip>}
        <span className="ml-auto flex items-center gap-2">
          <RowStatus d={d} waiting={waiting} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={t("serviceDomains.actions", { host: d.host })}>
                <IconDots size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onEdit("routing")}>{t("serviceDomains.menu.routing")}</DropdownMenuItem>
              {!d.forward && <DropdownMenuItem onSelect={() => onEdit("access")}>{t("serviceDomains.menu.access")}</DropdownMenuItem>}
              {!d.auto && (
                <DropdownMenuItem onSelect={() => onEdit("certificate")}>{t("serviceDomains.menu.certificate")}</DropdownMenuItem>
              )}
              {!d.primary && !d.forward && (
                <DropdownMenuItem onSelect={() => primary.mutate({ serviceId, domainId: d.id })}>
                  {t("serviceDomains.menu.primary")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setConfirm(true)}>
                {t("service.remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {waiting && <DnsHelp serviceId={serviceId} domainId={d.id} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("serviceDomains.removeTitle", { host: d.host })}
        description={d.primary ? t("serviceDomains.removePrimaryBody") : t("serviceDomains.removeBody")}
        confirmLabel={t("service.remove")}
        destructive
        onConfirm={() => remove.mutateAsync({ serviceId, domainId: d.id }).then(() => undefined)}
      />
    </div>
  );
}

/** Let's Encrypt renews 30 days before expiry; under two weeks left means renewals are failing. */
const expiringSoonMs = 14 * 86_400_000;

function RowStatus({ d, waiting }: { d: Domain; waiting: boolean }) {
  if (waiting) {
    return (
      <span className="flex items-center gap-2">
        <Chip tone={d.dnsStatus === "wrongTarget" ? "red" : "amber"}>
          <StatusDot status={d.dnsStatus === "wrongTarget" ? "error" : "busy"} pulse />
          {t(`serviceDomains.dns.${d.dnsStatus}`)}
        </Chip>
        {d.dnsCheckedAt && (
          <span className="text-xs text-muted-foreground">{t("serviceDomains.checked", { when: formatRelative(d.dnsCheckedAt) })}</span>
        )}
      </span>
    );
  }
  if (d.forward) return null;
  if (d.auto)
    return (
      <span className="text-xs text-muted-foreground">
        {t("serviceDomains.fromWildcard", { host: d.host.split(".").slice(1).join(".") })}
      </span>
    );
  if (d.https === "off") return <span className="text-xs text-muted-foreground">{t("serviceDomains.httpOnly")}</span>;
  const cert = d.certificate;
  if (cert.status === "valid" && cert.expiresAt) {
    const soon = Date.parse(cert.expiresAt) - Date.now() < expiringSoonMs;
    const text = cert.issuer
      ? t("serviceDomains.certValidVia", { date: formatDate(cert.expiresAt), issuer: cert.issuer })
      : t("serviceDomains.certValid", { date: formatDate(cert.expiresAt) });
    return soon ? (
      <Chip tone="amber" title={t("serviceDomains.certSoonHint")}>
        <StatusDot status="busy" />
        {text}
      </Chip>
    ) : (
      <span className="text-xs text-muted-foreground">{text}</span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <Chip tone={cert.status === "failed" ? "red" : "amber"}>
        <StatusDot status={cert.status === "failed" ? "error" : "busy"} pulse={cert.status === "pending"} />
        {t(`serviceDomains.cert.${cert.status}`)}
      </Chip>
      {cert.status === "failed" && cert.error && (
        <span title={cert.error} className="min-w-0 max-w-[60ch] truncate text-xs text-chip-red-fg">
          {cert.error}
        </span>
      )}
    </span>
  );
}

/** The record to create, Open Cloudflare DNS, and Check now. */
function DnsHelp({ serviceId, domainId }: { serviceId: string; domainId: string }) {
  const check = useOp(domains.checkDns, { serviceId, domainId }, { retry: retryOp, staleTime: 60_000 });
  const invalidate = useInvalidate();
  const [copied, copy] = useCopy();
  if (check.isError) return <OpErrorNote error={check.error} compact />;
  const data = check.data;
  const record = data?.expected[0];
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[10px] bg-card px-3.5 py-3 shadow-control">
      <span className="text-[12.5px] text-ink-strong">
        {data?.zone ? t("serviceDomains.addRecordIn", { zone: data.zone }) : t("serviceDomains.addRecord")}
      </span>
      {record && (
        <>
          <span className="flex gap-1.5 font-mono text-[12.5px]">
            <span className="rounded-chip bg-field px-2 py-1 font-medium">{record.type}</span>
            <span className="rounded-chip bg-field px-2 py-1">{record.name}</span>
            <span className="rounded-chip bg-field px-2 py-1">{record.value}</span>
          </span>
          <Button
            size="icon"
            className="size-[30px] rounded-control bg-muted shadow-none"
            aria-label={t("serviceDomains.copyRecord")}
            onClick={() => void copy(record.value)}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} stroke={1.9} />}
          </Button>
        </>
      )}
      {data && data.status !== "missing" && <span className="w-full text-xs text-muted-foreground">{data.message}</span>}
      <span className="ml-auto flex flex-wrap gap-2">
        {data?.cloudflareDnsUrl && (
          <a
            href={data.cloudflareDnsUrl}
            target="_blank"
            rel="noreferrer"
            className="flex h-8 items-center gap-1.5 rounded-control bg-chip-amber-bg px-[11px] text-[12.5px] font-medium text-chip-amber-fg"
          >
            {t("serviceDomains.openCloudflare")}
            <IconArrowUpRight size={12} stroke={2.2} />
          </a>
        )}
        <Button
          size="sm"
          className="bg-muted shadow-none"
          disabled={check.isFetching}
          onClick={() => {
            void check.refetch();
            invalidate(domains.list);
          }}
        >
          {t("serviceDomains.checkNow")}
        </Button>
      </span>
    </div>
  );
}
