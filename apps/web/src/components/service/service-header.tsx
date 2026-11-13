// The title row of every service screen (Service.dc.html): kind tile, name,
// live status, nodes, main address, and the run actions for the kind. The
// buttons run through the same actions as the service's menus
// (menus/service-actions.ts, menus/object-actions.tsx), and its "..." is
// the service's whole menu, the one its rows show on right-click.

import { databases } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { IconArrowUpRight, IconPlayerPlay, IconPlayerStop, IconRefresh, IconServer2 } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { t } from "../../i18n/t";
import { isPanelService } from "../../lib/service-display";
import { useObjectActions } from "../menus/object-actions";
import { useServiceActions } from "../menus/service-actions";
import { ServiceActionsMenu } from "../menus/service-menu";
import { useActiveDeploy } from "./active-deploy";
import { customVersion, versionCardId } from "./database/version-card";
import { KindBadge } from "./kind-badge";
import { retryOp } from "./op-state";
import { isDatabaseKind } from "./status";
import { ServiceStatusChip } from "./status-chip";
import type { ServiceDetail } from "./use-service";

export function ServiceHeader({ service }: { service: ServiceDetail }) {
  const address = service.address;
  const href = address && !address.includes(":") ? `https://${address}` : null;
  return (
    <header className="flex flex-wrap items-center gap-3">
      <KindBadge kind={service.kind} />
      <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">{service.name}</h1>
      <ServiceStatusChip status={service.status} buildWaiting={service.buildWaiting} />
      {service.placements.map((p) => (
        <Chip key={p.nodeId} tone="track">
          <IconServer2 size={13} stroke={1.8} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          {p.nodeName}
          {p.replicas > 1 && <span className="font-mono text-muted-foreground">×{p.replicas}</span>}
        </Chip>
      ))}
      <HeaderAddress service={service} href={href} />
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <HeaderActions service={service} />
        <ServiceActionsMenu service={service} />
      </div>
    </header>
  );
}

function HeaderAddress({ service, href }: { service: ServiceDetail; href: string | null }) {
  if (isDatabaseKind(service.kind)) return <DatabaseSubtitle service={service} />;
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono text-[12.5px]">
        {service.address}
        <IconArrowUpRight size={13} stroke={1.8} aria-hidden="true" className="shrink-0" />
      </a>
    );
  if (service.address) return <span className="font-mono text-[12.5px] text-muted-foreground">{service.address}</span>;
  if (service.kind === "app" || service.kind === "cron")
    return (
      <span className="text-[12.5px] text-muted-foreground">
        {t(service.ports.length ? "service.header.noDomain" : "service.header.noPorts")}
      </span>
    );
  return null;
}

/** "MongoDB 8.0", or "MongoDB (mongo:latest)" for a tag that names no release: links to the Version card on Settings. */
function DatabaseSubtitle({ service }: { service: ServiceDetail }) {
  const db = useOp(databases.get, { serviceId: service.id }, { retry: retryOp });
  if (!db.data) return null;
  const engine = t(`service.kind.${db.data.engine}`);
  const image = service.sourceConfig.type === "image" ? service.sourceConfig.image : "";
  return (
    <Link
      to="/p/$projectId/s/$serviceId/settings"
      params={{ projectId: service.projectId, serviceId: service.id }}
      hash={versionCardId}
      className="text-[12.5px] text-muted-foreground no-underline hover:text-foreground"
    >
      {db.data.version === customVersion && image
        ? t("service.header.databaseImage", { engine, image })
        : t("service.header.databaseVersion", { engine, version: db.data.version })}
      {db.data.variant && t("service.header.databaseVariant", { variant: db.data.variant })}
    </Link>
  );
}

function HeaderActions({ service }: { service: ServiceDetail }) {
  const actions = useServiceActions();
  const objects = useObjectActions();
  // The panel's own service updates through Settings > Updates, never by a deploy or a stop.
  const panel = isPanelService(service);
  const deploys = (service.kind === "app" || service.kind === "cron") && !panel;
  // The deploy in progress (the oldest queued or running one): Cancel deploy stops it, and Deploy waits for it.
  const active = useActiveDeploy(service.id, deploys);
  const { restart, start, deploy, cancel, openBox, stopBox } = actions;

  if (service.kind === "box") {
    return (
      <>
        <Button onClick={() => stopBox.mutate({ serviceId: service.id })} disabled={stopBox.isPending}>
          <IconPlayerStop size={15} stroke={1.9} aria-hidden="true" />
          {t("service.header.stop")}
        </Button>
        <Button variant="primary" onClick={() => openBox.mutate({ serviceId: service.id })} disabled={openBox.isPending}>
          {t("service.header.openBox")}
        </Button>
      </>
    );
  }

  return (
    <>
      {active ? (
        <Button onClick={() => void actions.cancelDeploy(service.id, active.id)} disabled={cancel.isPending}>
          {t("service.header.cancelDeploy")}
        </Button>
      ) : (
        <>
          {!service.stopped && service.status !== "idle" && (
            <Button onClick={() => restart.mutate({ serviceId: service.id })} disabled={restart.isPending}>
              <IconRefresh size={15} stroke={1.9} aria-hidden="true" className={restart.isPending ? "animate-spin" : undefined} />
              {t("service.header.restart")}
            </Button>
          )}
          {service.stopped ? (
            <Button onClick={() => start.mutate({ serviceId: service.id })} disabled={start.isPending}>
              <IconPlayerPlay size={15} stroke={1.9} aria-hidden="true" />
              {t("service.header.start")}
            </Button>
          ) : (
            service.status !== "idle" &&
            !panel && (
              <Button onClick={() => objects.openDialog({ kind: "service-stop", service })}>
                <IconPlayerStop size={15} stroke={1.9} aria-hidden="true" />
                {t("service.header.stop")}
              </Button>
            )
          )}
        </>
      )}
      {deploys && (
        <Button
          variant="primary"
          onClick={() => actions.startDeploy(service)}
          disabled={deploy.isPending || active !== null}
          title={active ? t("service.header.deployBusyHint") : undefined}
        >
          {t(active ? "service.header.deployBusy" : "service.header.deploy")}
        </Button>
      )}
    </>
  );
}
