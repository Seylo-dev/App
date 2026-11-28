// The toast after adding a domain: live, waiting for DNS, waiting for the
// first deploy, or a warning when the panel kept it although its
// registrable domain does not exist (Domain.warning registrableMissing:
// not registered, no name servers yet, or a typo), with "Did you mean"
// when the panel named a likely spelling. An automatic domain gets the
// same warning when the node's wildcard domain does not exist. A wildcard
// domain that works (its * record ok, or behind Cloudflare's proxy) says
// what it now routes; one on a node to update says so.

import type { domains, OpOutput } from "@seylo/ops";
import { toast } from "@seylo/ui/components/toast";
import { t } from "../../../i18n/t";

type Added = OpOutput<typeof domains.add>;
type Warning = NonNullable<Added["domain"]["warning"]>;

/** Long enough to read the domain twice over. */
const warningMs = 12_000;

function warnMissing(warning: Warning): string {
  const hint = t("serviceDomains.zoneMissingHint");
  return toast.warning(t("serviceDomains.addedZoneMissing", { domain: warning.registrable }), {
    description: warning.didYouMean ? `${hint} ${t("serviceDomains.didYouMean", { domain: warning.didYouMean })}` : hint,
    duration: warningMs,
  });
}

/** After domains.add. */
export function toastAdded(res: Added, serviceName: string): string {
  if (res.domain.warning) return warnMissing(res.domain.warning);
  const reason = res.domain.noRoute?.reason;
  const working = res.dns.status === "ok" || (res.domain.wildcard === true && res.dns.status === "proxied");
  return toast.success(
    reason === "notDeployed"
      ? t("serviceDomains.addedNotDeployed", { name: serviceName })
      : reason === "agentTooOld"
        ? t("serviceDomains.addedAgentTooOld", { node: res.domain.noRoute?.nodeName ?? t("serviceDomains.theNode") })
        : working && res.domain.wildcard
          ? t("serviceDomains.addedWildcard", { base: res.domain.host.replace(/^\*\./, ""), name: serviceName })
          : working
            ? t("serviceDomains.addedLive")
            : t("serviceDomains.addedWaiting"),
  );
}

/** After domains.addAuto. */
export function toastAutoAdded(domain: OpOutput<typeof domains.addAuto>): string {
  if (domain.warning) return warnMissing(domain.warning);
  return toast.success(t("serviceDomains.autoAdded"));
}
