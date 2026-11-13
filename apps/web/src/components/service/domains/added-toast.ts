// The toast after adding a domain: live, waiting for DNS, waiting for the
// first deploy, or a warning when the panel kept it although its
// registrable domain does not exist (Domain.warning registrableMissing:
// not registered, no name servers yet, or a typo), with "Did you mean"
// when the panel named a likely spelling. An automatic domain gets the
// same warning when the node's wildcard domain does not exist.

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
  return toast.success(
    res.domain.noRoute?.reason === "notDeployed"
      ? t("serviceDomains.addedNotDeployed", { name: serviceName })
      : res.dns.status === "ok"
        ? t("serviceDomains.addedLive")
        : t("serviceDomains.addedWaiting"),
  );
}

/** After domains.addAuto. */
export function toastAutoAdded(domain: OpOutput<typeof domains.addAuto>): string {
  if (domain.warning) return warnMissing(domain.warning);
  return toast.success(t("serviceDomains.autoAdded"));
}
