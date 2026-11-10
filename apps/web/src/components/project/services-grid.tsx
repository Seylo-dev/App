// The project's services as cards (Project.dc.html, service-card.tsx),
// plus the dashed "Add a service" card that opens the New service menu.
// Cards drag into the person's own order, the same as the sidebar's and the
// dashboard's (lib/use-project-prefs.ts).

import { services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { LoadingRegion } from "@seylo/ui/components/skeleton";
import { IconPlus } from "@tabler/icons-react";
import { t } from "../../i18n/t";
import { useProjectPrefs } from "../../lib/use-project-prefs";
import { NewServiceMenu } from "../new-service/new-service-menu";
import { QueryError } from "../query-error";
import { SortableCard, SortableGroup } from "../sortable";
import { ServiceCard, ServiceCardSkeleton, useMemoryTotals } from "./service-card";

export function ServicesGrid({ projectId, canCreate }: { projectId: string; canCreate: boolean }) {
  const list = useOp(services.list, { projectId });
  const memoryTotals = useMemoryTotals();
  const prefs = useProjectPrefs();

  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} />;
  const rows = list.data?.services.filter((service) => service.parentId === null) ?? [];

  return (
    <div aria-busy={list.isPending} className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {list.isPending && [0, 1, 2].map((key) => <ServiceCardSkeleton key={key} />)}
      <SortableGroup ids={rows.map((service) => service.id)} onMove={(ids) => prefs.setServiceOrder(projectId, ids)} layout="grid">
        {rows.map((service) => (
          <SortableCard key={service.id} id={service.id} name={service.name}>
            <ServiceCard service={service} memoryTotal={memoryTotals.get(service.placements[0]?.nodeId ?? "") ?? 0} />
          </SortableCard>
        ))}
      </SortableGroup>
      {canCreate && !list.isPending && (
        <NewServiceMenu
          projectId={projectId}
          trigger={
            <button
              type="button"
              className="flex min-h-[190px] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-card border-[1.5px] border-dashed border-input bg-card/55 text-[13.5px] font-medium text-ink-strong hover:bg-card"
            >
              <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <IconPlus size={16} stroke={2.2} />
              </span>
              {t("project.addService")}
            </button>
          }
        />
      )}
    </div>
  );
}

/** The project's services before they load (also while the project itself loads). */
export function ServicesGridSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((key) => (
        <ServiceCardSkeleton key={key} />
      ))}
    </LoadingRegion>
  );
}
