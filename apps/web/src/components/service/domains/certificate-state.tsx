// The Let's Encrypt side of a domain: "Generating SSL certificate" with a
// spinner while the certificate is issued, the red chip with the CA's reason
// when it failed, and "Regenerate certificate" (domains.retryCertificate),
// which the row, its menu and the certificate dialog share. After a click
// the domain shows Generating until its node reports a certificate or a new
// failure. While the panel has not seen a custom domain reach the node, its
// certificate waits for DNS instead (the node asks Let's Encrypt nothing),
// and the row's Check again starts it once the record is right.

import { domains, type OpOutput } from "@seylo/ops";
import { opQueryKey, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { toast } from "@seylo/ui/components/toast";
import { IconClock, IconLoader2, IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { useInvalidate } from "../invalidate";
import { isNotBuilt } from "../op-state";

type Domain = OpOutput<typeof domains.list>["domains"][number];

/** The certificate waits until a check sees the domain reach the node (certificate.waitingForDns). */
export function waitsForDns(d: Domain): boolean {
  return d.https === "acme" && d.certificate.waitingForDns === true;
}

/** A Let's Encrypt certificate that is not there yet: issuing or failed. Not while it waits for DNS: nothing would be retried. */
export function canRegenerate(d: Domain): boolean {
  return d.https === "acme" && !waitsForDns(d) && (d.certificate.status === "pending" || d.certificate.status === "failed");
}

/**
 * The CA refused for its rate limits. The node passes the ACME problem's
 * status ("(429)") and detail ("too many failed authorizations ...").
 */
export function isRateLimited(error: string | null): boolean {
  return !!error && /\(429\)|ratelimited|rate limit|too many (failed )?(authorizations|certificates|new orders|requests)/i.test(error);
}

/** domains.retryCertificate; the row switches to Generating as soon as it is clicked. */
export function useRegenerate(serviceId: string) {
  const client = useQueryClient();
  const invalidate = useInvalidate();
  return useOpMutation(domains.retryCertificate, {
    onSuccess: (domain) => {
      client.setQueryData<OpOutput<typeof domains.list>>(opQueryKey(domains.list, { serviceId }), (list) =>
        list ? { ...list, domains: list.domains.map((d) => (d.id === domain.id ? domain : d)) } : list,
      );
      invalidate(domains.list);
      toast.success(t("serviceDomains.regenerateStarted", { host: domain.host }));
    },
    onError: (error) => toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed"))),
  });
}

/** Spinner and "Generating SSL certificate". */
export function GeneratingChip() {
  return (
    <Chip tone="amber" data-testid="certificate-generating">
      <IconLoader2 size={12} stroke={2.4} className="animate-spin" aria-hidden="true" />
      {t("serviceDomains.generating")}
    </Chip>
  );
}

/**
 * A clock and "Certificate waits for DNS", or behind Cloudflare's proxy
 * "Certificate waits for Cloudflare": the record there is set, and what
 * holds the certificate up is the panel's check through the proxy not
 * reaching the node yet (the record there, or Cloudflare's SSL/TLS
 * settings, originReason).
 */
export function WaitingForDnsChip({ cloudflare = false }: { cloudflare?: boolean }) {
  return (
    <Chip tone="amber" data-testid="certificate-waiting">
      <IconClock size={12} stroke={2.2} aria-hidden="true" />
      {t(cloudflare ? "serviceDomains.certWaitingCloudflare" : "serviceDomains.certWaiting")}
    </Chip>
  );
}

/** Runs the row's DNS and origin check now, then refreshes the row; a spinner while it runs. */
export function CheckAgainButton({ check }: { check: { isFetching: boolean; refetch: () => Promise<unknown> } }) {
  const invalidate = useInvalidate();
  return (
    <Button
      size="sm"
      className="bg-muted shadow-none"
      disabled={check.isFetching}
      onClick={() => {
        void check.refetch().then(() => invalidate(domains.list));
      }}
    >
      {check.isFetching ? (
        <IconLoader2 size={13} stroke={2.2} className="animate-spin" aria-hidden="true" />
      ) : (
        <IconRefresh size={13} stroke={2.2} aria-hidden="true" />
      )}
      {t("serviceDomains.checkAgain")}
    </Button>
  );
}

/** The red chip with the CA's reason (shortened; the full text on hover). */
export function FailedChip({ error }: { error: string | null }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <Chip tone="red">
        <StatusDot status="error" />
        {t("serviceDomains.cert.failed")}
      </Chip>
      {error && (
        <span title={error} className="min-w-0 max-w-[60ch] truncate text-xs text-chip-red-fg">
          {error}
        </span>
      )}
    </span>
  );
}

export function RegenerateButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <Button size="sm" className="bg-muted shadow-none" disabled={busy} onClick={onClick}>
      <IconRefresh size={13} stroke={2.2} aria-hidden="true" />
      {t("serviceDomains.regenerate")}
    </Button>
  );
}

/** Why Let's Encrypt refused, for errors that name its rate limit. */
export function RateLimitNote() {
  return <p className="m-0 text-xs text-muted-foreground">{t("serviceDomains.rateLimitNote")}</p>;
}

/** The certificate dialog's Let's Encrypt part: state, reason and the same Regenerate action. */
export function LetsEncryptState({ serviceId, domain }: { serviceId: string; domain: Domain }) {
  const regenerate = useRegenerate(serviceId);
  const generating = domain.certificate.status === "pending" || regenerate.isPending;
  const error = domain.certificate.error;
  return (
    <Callout
      tone={generating ? "neutral" : "danger"}
      icon={generating ? <IconLoader2 size={17} stroke={2} className="animate-spin" /> : undefined}
      title={generating ? t("serviceDomains.generating") : t("serviceDomains.cert.failed")}
      action={<RegenerateButton busy={regenerate.isPending} onClick={() => regenerate.mutate({ serviceId, domainId: domain.id })} />}
    >
      {generating ? (
        t("serviceDomains.generatingHint")
      ) : (
        <span className="flex flex-col gap-1">
          {error && <span className="break-words">{error}</span>}
          {isRateLimited(error) && <span>{t("serviceDomains.rateLimitNote")}</span>}
        </span>
      )}
    </Callout>
  );
}
