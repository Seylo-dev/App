// The title row of every service screen (Service.dc.html): kind tile, name,
// live status, nodes, main address, and the run actions for the kind.

import { boxes, databases, deployments, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { toast } from "@seylo/ui/components/toast";
import { IconArrowUpRight, IconServer2 } from "@tabler/icons-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { isPanelService } from "../../lib/service-display";
import { useActiveDeploy } from "./active-deploy";
import { ServiceMenu } from "./copy/service-menu";
import { versionCardId } from "./database/version-card";
import { useInvalidate } from "./invalidate";
import { KindBadge } from "./kind-badge";
import { isNotBuilt, retryOp } from "./op-state";
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
      <ServiceStatusChip status={service.status} />
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
        <ServiceMenu service={service} />
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

/** "MongoDB 8.0": links to the Version card on Settings, where it changes. */
function DatabaseSubtitle({ service }: { service: ServiceDetail }) {
  const db = useOp(databases.get, { serviceId: service.id }, { retry: retryOp });
  if (!db.data) return null;
  return (
    <Link
      to="/p/$projectId/s/$serviceId/settings"
      params={{ projectId: service.projectId, serviceId: service.id }}
      hash={versionCardId}
      className="text-[12.5px] text-muted-foreground no-underline hover:text-foreground"
    >
      {t("service.header.databaseVersion", { engine: t(`service.kind.${db.data.engine}`), version: db.data.version })}
      {db.data.variant && t("service.header.databaseVariant", { variant: db.data.variant })}
    </Link>
  );
}

function HeaderActions({ service }: { service: ServiceDetail }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [confirmStop, setConfirmStop] = useState(false);
  // The panel's own service updates through Settings > Updates, never by a deploy or a stop.
  const panel = isPanelService(service);
  const deploys = (service.kind === "app" || service.kind === "cron") && !panel;
  // The deploy in progress (the oldest queued or running one): Cancel deploy stops it, and Deploy waits for it.
  const active = useActiveDeploy(service.id, deploys);

  const onDone = (message: string) => () => {
    toast.success(message);
    invalidate(services.get, services.list);
  };
  const onFail = (error: unknown) =>
    toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

  const restart = useOpMutation(services.restart, { onSuccess: onDone(t("service.header.restarted")), onError: onFail });
  const stop = useOpMutation(services.stop, { onSuccess: onDone(t("service.header.stopped")), onError: onFail });
  const start = useOpMutation(services.start, { onSuccess: onDone(t("service.header.started")), onError: onFail });
  const deploy = useOpMutation(deployments.deploy, {
    onSuccess: () => {
      invalidate(deployments.list, services.get);
      toast.success(t("service.header.deployStarted"), {
        action: {
          label: t("service.header.viewDeploy"),
          onClick: () =>
            void navigate({
              to: "/p/$projectId/s/$serviceId/deployments",
              params: { projectId: service.projectId, serviceId: service.id },
            }),
        },
      });
    },
    onError: onFail,
  });
  const cancel = useOpMutation(deployments.cancel, { onSuccess: () => invalidate(deployments.list, services.get), onError: onFail });
  const openBox = useOpMutation(boxes.open, {
    onSuccess: (res) => window.open(res.url, "_blank", "noopener"),
    onError: onFail,
  });
  const stopBox = useOpMutation(boxes.stop, { onSuccess: onDone(t("service.header.stopped")), onError: onFail });

  if (service.kind === "box") {
    return (
      <>
        <Button onClick={() => stopBox.mutate({ serviceId: service.id })} disabled={stopBox.isPending}>
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
        <Button onClick={() => cancel.mutate({ serviceId: service.id, deploymentId: active.id })} disabled={cancel.isPending}>
          {t("service.header.cancelDeploy")}
        </Button>
      ) : (
        <>
          {!service.stopped && service.status !== "idle" && (
            <Button onClick={() => restart.mutate({ serviceId: service.id })} disabled={restart.isPending}>
              {t("service.header.restart")}
            </Button>
          )}
          {service.stopped ? (
            <Button onClick={() => start.mutate({ serviceId: service.id })} disabled={start.isPending}>
              {t("service.header.start")}
            </Button>
          ) : (
            service.status !== "idle" &&
            !panel && (
              <Button onClick={() => setConfirmStop(true)} disabled={stop.isPending}>
                {t("service.header.stop")}
              </Button>
            )
          )}
        </>
      )}
      {deploys && (
        <Button
          variant="primary"
          onClick={() => deploy.mutate({ serviceId: service.id })}
          disabled={deploy.isPending || active !== null}
          title={active ? t("service.header.deployBusyHint") : undefined}
        >
          {t(active ? "service.header.deployBusy" : "service.header.deploy")}
        </Button>
      )}
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={t("service.header.stopTitle", { name: service.name })}
        description={t("service.header.stopBody")}
        confirmLabel={t("service.header.stop")}
        onConfirm={() => stop.mutateAsync({ serviceId: service.id }).then(() => undefined)}
      />
    </>
  );
}
