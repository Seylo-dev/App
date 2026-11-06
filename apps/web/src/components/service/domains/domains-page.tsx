// The Domains tab (Domains.dc.html): the domain list with DNS help, then
// IP:port access, maintenance pages and dev access.

import { domains } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { IconPlus, IconWorld } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";
import { DevAccessCard, FirstRunCard, MaintenanceCard } from "./access-cards";
import { AccessRulesSheet, AddDomainDialog, CertificateDialog, RoutingDialog } from "./domain-dialogs";
import { type DomainDialog, DomainRow } from "./domain-row";

export function DomainsPage({ service }: { service: ServiceDetail }) {
  const list = useOp(domains.list, { serviceId: service.id }, { retry: retryOp });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id: string; dialog: DomainDialog } | null>(null);
  const invalidate = useInvalidate();
  const addAuto = useOpMutation(domains.addAuto, {
    onSuccess: () => {
      invalidate(domains.list);
      toast.success(t("serviceDomains.autoAdded"));
    },
  });
  const rows = list.data?.domains ?? [];
  const current = editing ? rows.find((d) => d.id === editing.id) : undefined;
  const suggestion = list.data?.autoDomainSuggestion;
  const hasAuto = rows.some((d) => d.auto);

  return (
    <>
      <Card aria-label={t("serviceDomains.title")} className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2.5 px-5 pt-4 pb-3.5">
          <h2 className="m-0 text-[15px] font-semibold">{t("serviceDomains.title")}</h2>
          <span className="text-[12.5px] text-muted-foreground">{t("serviceDomains.subtitle")}</span>
          <Button variant="primary" className="ml-auto h-9 text-[13px]" onClick={() => setAdding(true)}>
            <IconPlus size={14} stroke={2.2} />
            {t("serviceDomains.add")}
          </Button>
        </div>
        {list.isPending ? (
          <div className="border-t border-divider px-5 py-4">
            <Skeleton className="h-10" />
          </div>
        ) : list.isError ? (
          <div className="border-t border-divider px-5 py-4">
            <OpErrorNote error={list.error} />
          </div>
        ) : (
          <>
            {rows.map((d) => (
              <DomainRow
                key={d.id}
                serviceId={service.id}
                serviceName={service.name}
                domain={d}
                onEdit={(dialog) => setEditing({ id: d.id, dialog })}
              />
            ))}
            {suggestion && !hasAuto && (
              <div className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-3">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                >
                  <IconWorld size={14} stroke={2} />
                </span>
                <span className="font-mono text-[13px] text-muted-foreground">https://{suggestion}</span>
                <span className="text-xs text-muted-foreground">{t("serviceDomains.autoHint")}</span>
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={addAuto.isPending}
                  onClick={() => addAuto.mutate({ serviceId: service.id })}
                >
                  {t("serviceDomains.addAuto")}
                </Button>
                <MutationError error={addAuto.error} />
              </div>
            )}
            {rows.length === 0 && !suggestion && (
              <div className="border-t border-divider">
                <EmptyState compact title={t("serviceDomains.empty")} description={t("serviceDomains.emptyHint")} />
              </div>
            )}
          </>
        )}
      </Card>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        <FirstRunCard service={service} />
        <MaintenanceCard service={service} />
      </div>
      <DevAccessCard service={service} />
      <AddDomainDialog service={service} open={adding} onOpenChange={setAdding} />
      {current && editing?.dialog === "routing" && (
        <RoutingDialog service={service} domain={current} onOpenChange={() => setEditing(null)} />
      )}
      {current && editing?.dialog === "access" && (
        <AccessRulesSheet serviceId={service.id} domain={current} onOpenChange={() => setEditing(null)} />
      )}
      {current && editing?.dialog === "certificate" && (
        <CertificateDialog serviceId={service.id} domain={current} onOpenChange={() => setEditing(null)} />
      )}
    </>
  );
}
