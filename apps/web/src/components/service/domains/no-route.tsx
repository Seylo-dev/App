// A domain with no route on its service's node (Domain.noRoute): the row's
// chip and the note below it say why, instead of "Certificate waits for
// DNS" or for Cloudflare, which read as a record to fix while the record
// was right all along. A service that has not deployed yet (with a link to
// its Deployments tab, and "deploying for the first time" while its first
// deployment is on its way), a compose stack or a cron service, which take
// no domains, and a node that could not write the service's routes, with
// its own error.

import type { domains, OpOutput } from "@seylo/ops";
import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { IconLoader2 } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { t } from "../../../i18n/t";

type Domain = OpOutput<typeof domains.list>["domains"][number];
export type NoRoute = NonNullable<Domain["noRoute"]>;

/**
 * The panel knows the service's node cannot route the domain (not deployed
 * yet, a compose stack, a cron service): the row checks nothing again on
 * its own, since no check could pass before that changes.
 */
export function routeless(d: Pick<Domain, "noRoute">): boolean {
  return !!d.noRoute && d.noRoute.reason !== "routeWriteFailed";
}

type Shown = NoRoute["reason"] | "deploying";

/** notDeployed with a deployment on its way reads "deploying". */
function shownAs(noRoute: NoRoute): Shown {
  return noRoute.reason === "notDeployed" && noRoute.deploymentId ? "deploying" : noRoute.reason;
}

/** "Not deployed yet" (amber), "Waiting for the first deploy" (a spinner), or a red "No route". */
export function NoRouteChip({ noRoute }: { noRoute: NoRoute }) {
  const shown = shownAs(noRoute);
  const waiting = noRoute.reason === "notDeployed";
  return (
    <Chip tone={waiting ? "amber" : "red"} data-testid="no-route" data-reason={noRoute.reason}>
      {shown === "deploying" ? (
        <IconLoader2 size={12} stroke={2.4} className="animate-spin" aria-hidden="true" />
      ) : (
        <StatusDot status={waiting ? "busy" : "error"} />
      )}
      {t(`serviceDomains.noRoute.chip.${shown}`, { node: noRoute.nodeName ?? t("serviceDomains.theNode") })}
    </Chip>
  );
}

/** Why, below the row; for a service that has not deployed yet, with its Deployments tab. */
export function NoRouteNote({
  projectId,
  serviceId,
  serviceName,
  noRoute,
}: {
  projectId: string;
  serviceId: string;
  serviceName: string;
  noRoute: NoRoute;
}) {
  const shown = shownAs(noRoute);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="no-route-note" data-reason={noRoute.reason}>
      {shown === "routeWriteFailed" ? (
        <p className="m-0 min-w-0 flex-1 basis-64 text-xs text-muted-foreground">
          <span className="break-words text-chip-red-fg">
            {t("serviceDomains.noRoute.routeWriteFailed", {
              node: noRoute.nodeName ?? t("serviceDomains.theNode"),
              error: noRoute.error ?? "",
            })}
          </span>{" "}
          {t("serviceDomains.noRoute.routeWriteFailedHint")}
        </p>
      ) : (
        <p className="m-0 min-w-0 flex-1 basis-64 text-xs text-muted-foreground">
          {t(`serviceDomains.noRoute.${shown}`, { name: serviceName })}
        </p>
      )}
      {noRoute.reason === "notDeployed" && (
        <Button asChild size="sm" className="bg-muted shadow-none">
          <Link to="/p/$projectId/s/$serviceId/deployments" params={{ projectId, serviceId }}>
            {t("serviceDomains.noRoute.openDeployments")}
          </Link>
        </Button>
      )}
    </div>
  );
}
