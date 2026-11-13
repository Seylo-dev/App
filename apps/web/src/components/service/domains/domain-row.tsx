// One domain in the Domains card (Domains.dc.html): state tile, URL, chips,
// where it routes, certificate or DNS state (Generating SSL certificate, or
// the CA's reason and Regenerate certificate), a menu of actions, and for a
// domain still waiting on DNS, the record to create with a Cloudflare link,
// or that its registrable domain does not exist (no name servers), with
// "Did you mean" when the panel knows a likely spelling.
// A domain whose DNS works names the address it points at (DNS -> IP, or
// the origin behind Cloudflare's proxy), like the panel domain card, and
// what the panel's origin check found: that requests reach this node, or
// that something else answers (a red chip and the record to fix, below).
// Until the panel has seen a custom domain reach the node its certificate
// waits for DNS (Certificate waits for DNS, no certificate meanwhile), or
// behind Cloudflare's proxy for the check through it (Certificate waits
// for Cloudflare, with what Cloudflare answered when it said: SSL/TLS Full
// (strict) refusing the node's temporary certificate, the node out of its
// reach, or a 404); every note about a pending certificate has Check
// again, which runs the DNS and origin check at once, and a waiting domain
// is checked once a minute while the tab is open, so a fixed record starts
// the certificate. A domain with no route on the service's node says why
// instead (no-route.tsx: not deployed yet, a compose stack or cron service,
// or the node's error writing the routes), and while the panel knows no
// check could pass (routeless) nothing is checked again on its own. The
// row's "..." and its right-click menu are one list (menus/row-items.tsx);
// the notes under the row keep the browser's menu, for their records and links.

import { domains, type OpOutput } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { useCopy } from "@seylo/ui/components/copy-field";
import { ActionsMenu } from "@seylo/ui/components/menu-items";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconArrowUpRight,
  IconCheck,
  IconClock,
  IconCloud,
  IconCopy,
  IconCornerDownRight,
  IconDots,
  IconLock,
  IconLockOpen,
} from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { type DomainAction, domainMenuEntries } from "../../menus/row-items";
import { copyWithToast, RowMenu } from "../../menus/row-menu";
import { formatDate, formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, OpErrorNote, retryOp } from "../op-state";
import {
  CheckAgainButton,
  canRegenerate,
  FailedChip,
  GeneratingChip,
  isRateLimited,
  RateLimitNote,
  RegenerateButton,
  useRegenerate,
  WaitingForDnsChip,
  waitsForDns,
} from "./certificate-state";
import { NoRouteChip, NoRouteNote, routeless } from "./no-route";

export type Domain = OpOutput<typeof domains.list>["domains"][number];
export type DomainDialog = "routing" | "access" | "certificate";

type Tone = "ok" | "busy" | "error" | "off";

/** How often a domain whose certificate waits for DNS is checked again while its row shows. */
export const waitingRecheckMs = 60_000;

function domainTone(d: Domain): Tone {
  // No route on the node: waiting for a deployment, or nowhere to go.
  if (d.noRoute) return d.noRoute.reason === "notDeployed" ? "busy" : "error";
  if (d.forward) return "ok";
  // A failure from before the certificate waited for DNS is not what holds it up now.
  if (d.dnsStatus === "wrongTarget" || (d.certificate.status === "failed" && !waitsForDns(d)) || elsewhere(d)) return "error";
  if (!d.auto && d.dnsStatus !== "ok" && d.dnsStatus !== "proxied") return "busy";
  if (d.https !== "off" && d.certificate.status !== "valid") return "busy";
  return "ok";
}

/** The origin check found that requests to the domain reach another server, not this service's node. */
function elsewhere(d: Domain): boolean {
  // Without a route on the node an answer from elsewhere is no news about the record.
  return !d.noRoute && !d.auto && !d.forward && d.origin === "elsewhere" && (d.dnsStatus === "ok" || d.dnsStatus === "proxied");
}

const tileTone: Record<Tone, string> = {
  ok: "bg-chip-green-bg text-status-ok",
  busy: "bg-chip-amber-bg text-status-busy",
  error: "bg-chip-red-bg text-status-error",
  off: "bg-muted text-muted-foreground",
};

export function DomainRow({
  projectId,
  serviceId,
  serviceName,
  domain: d,
  onEdit,
}: {
  projectId: string;
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
  const regenerate = useRegenerate(serviceId);
  const held = waitsForDns(d);
  const generating = d.https === "acme" && !held && (d.certificate.status === "pending" || regenerate.isPending);
  const runRegenerate = () => regenerate.mutate({ serviceId, domainId: d.id });
  const rateLimited =
    !d.noRoute && !waiting && !generating && !held && d.certificate.status === "failed" && isRateLimited(d.certificate.error);
  const mw = d.middlewares;
  const act = (action: DomainAction) => {
    switch (action) {
      case "openNewTab":
        return void window.open(d.url, "_blank", "noopener,noreferrer");
      case "routing":
      case "access":
      case "certificate":
        return onEdit(action);
      case "regenerate":
        return runRegenerate();
      case "primary":
        return primary.mutate({ serviceId, domainId: d.id });
      case "copyDomain":
        return void copyWithToast(d.host);
      case "remove":
        return setConfirm(true);
    }
  };
  const menu = domainMenuEntries(d, {
    linkable: !(d.forward || waiting || d.noRoute),
    canRegenerate: canRegenerate(d),
    regenerating: regenerate.isPending,
    act,
  });
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
    <>
      <RowMenu entries={menu} aria-label={t("serviceDomains.actions", { host: d.host })}>
        <div
          data-domain={d.host}
          className={cn(
            "flex flex-col gap-3 border-t border-divider px-5 py-3 transition-colors duration-200 data-[state=open]:bg-raised",
            waiting && "bg-chip-amber-bg/40 pb-4",
          )}
        >
          {/* The icon stands apart, so every wrapped line starts at the address's left edge. */}
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", tileTone[tone])}>
              <Icon size={14} stroke={2.2} />
            </span>
            <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
              {d.forward || waiting || d.noRoute ? (
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
                    {t("serviceDomains.forwardTo", {
                      code: d.forward.permanent ? "308" : "307",
                      url: d.forward.url.replace(/^https?:\/\//, ""),
                    })}
                  </span>
                ) : (
                  <span className="font-mono text-[12.5px] text-ink-strong">
                    {serviceName}:{d.targetPort}
                    {d.pathPrefix !== "/" ? d.pathPrefix : ""}
                  </span>
                )}
              </span>
              {!d.auto && <DnsChip d={d} />}
              {mw.basicAuth && <Chip tone="gray">{t("serviceDomains.chips.basicAuth")}</Chip>}
              {mw.ipAllowList.length > 0 && (
                <Chip tone="gray">{t("serviceDomains.chips.allowlist", { count: mw.ipAllowList.length })}</Chip>
              )}
              {mw.rateLimit && <Chip tone="gray">{t("serviceDomains.chips.rateLimit", { average: mw.rateLimit.average })}</Chip>}
              {mw.redirects.length > 0 && <Chip tone="gray">{t("serviceDomains.chips.redirects", { count: mw.redirects.length })}</Chip>}
              {/* On a phone the status takes its own line from the left edge, with the menu at the right. */}
              <span className="ml-auto flex items-center gap-2 max-sm:ml-0 max-sm:w-full">
                <RowStatus
                  d={d}
                  waiting={waiting}
                  held={held}
                  generating={generating}
                  onRegenerate={runRegenerate}
                  busy={regenerate.isPending}
                />
                <ActionsMenu
                  entries={menu}
                  trigger={
                    <Button size="icon" variant="ghost" className="ml-auto" aria-label={t("serviceDomains.actions", { host: d.host })}>
                      <IconDots size={15} />
                    </Button>
                  }
                />
              </span>
            </div>
          </div>
          {/* The notes keep the browser's menu: their records, addresses and links are what one copies there. */}
          <div data-native-context-menu="" className="contents">
            {d.noRoute && <NoRouteNote projectId={projectId} serviceId={serviceId} serviceName={serviceName} noRoute={d.noRoute} />}
            {waiting && <DnsHelp serviceId={serviceId} domainId={d.id} held={held} poll={!routeless(d)} />}
            {!waiting && elsewhere(d) && <OriginHelp serviceId={serviceId} d={d} held={held} />}
            {rateLimited && <RateLimitNote />}
            {(generating || held) && !d.noRoute && !waiting && !elsewhere(d) && <PendingCertNote serviceId={serviceId} d={d} held={held} />}
          </div>
        </div>
      </RowMenu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("serviceDomains.removeTitle", { host: d.host })}
        description={d.primary ? t("serviceDomains.removePrimaryBody") : t("serviceDomains.removeBody")}
        confirmLabel={t("service.remove")}
        destructive
        onConfirm={() => remove.mutateAsync({ serviceId, domainId: d.id }).then(() => undefined)}
      />
    </>
  );
}

/**
 * Where a working domain's DNS goes: "DNS -> <node IP>" when its record
 * points at the node, "Cloudflare proxy -> <node IP>" behind the proxy (the
 * origin to set there). The full sentence, every address and when it was
 * checked are the chip's title. Once the panel's origin check reached the
 * node the chip is green with a check and says so; when something else
 * answered it turns red ("..., not this node") and OriginHelp below the row
 * says what to fix. Nothing while DNS is not working yet: the waiting state
 * below the row names the record to create.
 */
function DnsChip({ d }: { d: Domain }) {
  const ips = d.pointsTo ?? [];
  const first = ips[0];
  if (!first || (d.dnsStatus !== "ok" && d.dnsStatus !== "proxied")) return null;
  const proxied = d.dnsStatus === "proxied";
  const shown = ips.length > 1 ? `${first} +${ips.length - 1}` : first;
  // The later of the two checks (ISO times compare as text).
  const when = d.originCheckedAt && (!d.dnsCheckedAt || d.originCheckedAt > d.dnsCheckedAt) ? d.originCheckedAt : d.dnsCheckedAt;
  const checked = when ? ` ${t("serviceDomains.dnsChecked", { when: formatRelative(when) })}` : "";
  if (elsewhere(d)) {
    const title =
      t(proxied ? "serviceDomains.originElsewhereProxiedHint" : "serviceDomains.originElsewhereHint", { host: d.host, ip: first }) +
      checked;
    return (
      <Chip tone="red" title={title} data-testid="dns-chip">
        <IconAlertTriangle size={12} stroke={2.2} aria-hidden="true" />
        <span>{t(proxied ? "serviceDomains.originElsewhereProxied" : "serviceDomains.originElsewhere", { ip: shown })}</span>
      </Chip>
    );
  }
  const reaches = d.origin === "node";
  const hint = t(proxied ? "serviceDomains.dnsProxiedHint" : "serviceDomains.dnsOkHint", { host: d.host, ips: ips.join(", ") });
  const title = hint + (reaches ? ` ${t("serviceDomains.originNodeHint")}` : "") + checked;
  return (
    <Chip tone={proxied && !reaches ? "gray" : "green"} title={title} data-testid="dns-chip" data-origin={reaches ? "node" : undefined}>
      {proxied && !reaches ? (
        <IconCloud size={12} stroke={2} aria-hidden="true" />
      ) : (
        <IconCheck size={12} stroke={2.2} aria-hidden="true" />
      )}
      <span>{t(proxied ? "serviceDomains.dnsProxiedTo" : "serviceDomains.dnsOkTo", { ip: shown })}</span>
    </Chip>
  );
}

/** A certificate is usually there within a minute or two of the record pointing at the node. */
const slowCertMs = 10 * 60_000;

/**
 * Why the latest origin check through Cloudflare did not reach the node,
 * when Cloudflare's answer said (525/526, 521/522, 404): from the row's own
 * domains.checkDns once it has run, else from domains.list.
 */
function originReason(d: Domain, check: OpOutput<typeof domains.checkDns> | undefined): Domain["originReason"] {
  return check ? check.originReason : d.originReason;
}

/**
 * Why a certificate can stay on "Generating" or wait for DNS: Let's Encrypt
 * reaches the host over its DNS. While the certificate waits for DNS (the
 * panel has not seen the domain reach the node), it says so and what to
 * point where. Behind Cloudflare's proxy, until the panel's origin check
 * reached the node, it says the record there must point at the node (at
 * once, with the node's address), or, when Cloudflare's answer to the last
 * check said why (originReason), that instead; once it has, and with the record on the
 * node, what else can stop it (once it takes longer than usual):
 * Cloudflare's settings, or something in front of port 80. The node
 * reports a failure it sees in Traefik's log on its own; this covers the
 * checks that never arrive. While it shows, the DNS and origin checks run
 * again (at most once a minute, every minute while the certificate waits),
 * and Check again runs them at once, so a record fixed in Cloudflare shows
 * up here and starts the certificate.
 */
function PendingCertNote({ serviceId, d, held }: { serviceId: string; d: Domain; held: boolean }) {
  const reaches = d.origin === "node";
  const check = useOp(
    domains.checkDns,
    { serviceId, domainId: d.id },
    {
      retry: retryOp,
      staleTime: 60_000,
      enabled: !d.auto && (held || (!d.forward && !reaches)),
      refetchInterval: held ? waitingRecheckMs : false,
    },
  );
  const ip = d.pointsTo?.[0];
  if (!ip) return null;
  const proxied = d.dnsStatus === "proxied";
  const note = (text: string, reason?: string) => (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="pending-cert-note" data-reason={reason}>
      <p className="m-0 min-w-0 flex-1 basis-64 text-xs text-muted-foreground">{text}</p>
      <CheckAgainButton check={check} />
    </div>
  );
  // What Cloudflare answered the last check says more than the general note.
  const reason = proxied && !reaches ? originReason(d, check.data) : undefined;
  if (reason) return note(t(`serviceDomains.originReason.${reason}`, { host: d.host, ip }), reason);
  if (held) return note(t(proxied ? "serviceDomains.certWaitsProxiedHint" : "serviceDomains.certWaitsHint", { host: d.host, ip }));
  if (proxied && !reaches) return note(t("serviceDomains.certProxiedHint", { host: d.host, ip }));
  if (Date.now() - Date.parse(d.createdAt) < slowCertMs) return null;
  return note(t(proxied ? "serviceDomains.certProxiedSlowHint" : "serviceDomains.certSlowHint", { host: d.host, ip }));
}

/**
 * Below a domain whose origin check reached another server: behind
 * Cloudflare's proxy, the record to set there (with the zone's Cloudflare
 * DNS link, like DnsHelp); with the record on the node's address, that
 * something in front of the node answers instead. Opening it runs the
 * check again (at most once a minute, every minute while the certificate
 * waits for DNS), and Check now runs it at once.
 */
function OriginHelp({ serviceId, d, held }: { serviceId: string; d: Domain; held: boolean }) {
  const check = useOp(
    domains.checkDns,
    { serviceId, domainId: d.id },
    { retry: retryOp, staleTime: 60_000, refetchInterval: held ? waitingRecheckMs : false },
  );
  const invalidate = useInvalidate();
  const [copied, copy] = useCopy();
  const ip = d.pointsTo?.[0];
  if (!ip) return null;
  const proxied = d.dnsStatus === "proxied";
  const data = check.data;
  const record = data?.expected.find((r) => r.value === ip) ?? data?.expected[0];
  const reason = proxied ? originReason(d, data) : undefined;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[10px] bg-card px-3.5 py-3 shadow-control" data-testid="origin-help">
      <span className="text-[12.5px] text-ink-strong">
        {t(proxied ? "serviceDomains.originFixProxied" : "serviceDomains.originFixDirect", { host: d.host, ip })}
      </span>
      {reason && (
        <span className="w-full text-xs text-muted-foreground" data-testid="origin-reason" data-reason={reason}>
          {t(`serviceDomains.originReason.${reason}`, { host: d.host, ip })}
        </span>
      )}
      {proxied && record && (
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
      <span className="ml-auto flex flex-wrap gap-2">
        {proxied && data?.cloudflareDnsUrl && (
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
            void check.refetch().then(() => invalidate(domains.list));
          }}
        >
          {t("serviceDomains.checkNow")}
        </Button>
      </span>
    </div>
  );
}

/** Let's Encrypt renews 30 days before expiry; under two weeks left means renewals are failing. */
const expiringSoonMs = 14 * 86_400_000;

function RowStatus({
  d,
  waiting,
  held,
  generating,
  onRegenerate,
  busy,
}: {
  d: Domain;
  waiting: boolean;
  held: boolean;
  generating: boolean;
  onRegenerate: () => void;
  busy: boolean;
}) {
  if (d.noRoute) return <NoRouteChip noRoute={d.noRoute} />;
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
  if (held) return <WaitingForDnsChip cloudflare={d.dnsStatus === "proxied"} />;
  if (generating) return <GeneratingChip />;
  if (d.https === "acme" && d.certificate.status === "failed")
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <FailedChip error={d.certificate.error} />
        <RegenerateButton busy={busy} onClick={onRegenerate} />
      </span>
    );
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
  // Let's Encrypt's pending and failed states are above; what is left is a
  // certificate without an expiry date yet.
  return (
    <Chip tone="amber">
      <StatusDot status="busy" />
      {t(`serviceDomains.cert.${cert.status}`)}
    </Chip>
  );
}

/**
 * The record to create, Open Cloudflare DNS, and Check now. While the
 * certificate waits for DNS it says so, and the check runs every minute
 * (poll), unless the domain has no route that could pass it. When the
 * host's registrable domain has no name servers (zoneMissing), it says
 * that domain does not exist instead of where to add the record, with
 * "Did you mean" when the panel knows a likely spelling the viewer can
 * see; the record, relative to the registrable domain, stays for once it
 * exists.
 */
function DnsHelp({ serviceId, domainId, held, poll }: { serviceId: string; domainId: string; held: boolean; poll: boolean }) {
  const check = useOp(
    domains.checkDns,
    { serviceId, domainId },
    { retry: retryOp, staleTime: 60_000, refetchInterval: held && poll ? waitingRecheckMs : false },
  );
  const invalidate = useInvalidate();
  const [copied, copy] = useCopy();
  if (check.isError) return <OpErrorNote error={check.error} compact />;
  const data = check.data;
  const record = data?.expected[0];
  const missing = data?.zoneMissing && data.registrable ? data.registrable : null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[10px] bg-card px-3.5 py-3 shadow-control" data-testid="dns-help">
      {missing ? (
        <>
          <p className="m-0 flex w-full items-start gap-2 text-[12.5px] text-ink-strong" data-testid="zone-missing">
            <IconAlertTriangle size={14} stroke={2.2} className="mt-px shrink-0 text-status-busy" aria-hidden="true" />
            <span>
              {t("serviceDomains.zoneMissing", { domain: missing })}
              {data?.didYouMean && (
                <>
                  {" "}
                  <span className="font-medium" data-testid="did-you-mean">
                    {t("serviceDomains.didYouMean", { domain: data.didYouMean })}
                  </span>
                </>
              )}
            </span>
          </p>
          {record && <span className="text-xs text-muted-foreground">{t("serviceDomains.zoneMissingRecord")}</span>}
        </>
      ) : (
        <span className="text-[12.5px] text-ink-strong">
          {data?.zone ? t("serviceDomains.addRecordIn", { zone: data.zone }) : t("serviceDomains.addRecord")}
        </span>
      )}
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
      {data && data.status !== "missing" && !missing && <span className="w-full text-xs text-muted-foreground">{data.message}</span>}
      {held && <span className="w-full text-xs text-muted-foreground">{t("serviceDomains.certWaitsDnsHint")}</span>}
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
