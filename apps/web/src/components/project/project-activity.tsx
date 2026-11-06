// The project's audit trail: who changed the project, newest first. The
// full log with filters is the Activity page.

import { audit } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { DataTable } from "@seylo/ui/components/data-table";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { IconActivity } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../i18n/t";
import { formatAgo } from "../../lib/format";
import { QueryError } from "../query-error";

const pageSize = 50;

export function ProjectActivity({ projectId }: { projectId: string }) {
  const [limit, setLimit] = useState(pageSize);
  const list = useOp(audit.list, { targetType: "project", targetId: projectId, limit });
  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        aria-label={t("project.tabs.activity")}
        loading={list.isPending}
        skeletonRows={5}
        rows={list.data?.entries ?? []}
        getRowId={(entry) => entry.id}
        empty={<EmptyState compact icon={<IconActivity />} title={t("project.activity.empty")} />}
        columns={[
          { id: "when", header: t("project.activity.when"), cell: (entry) => formatAgo(entry.at), width: "120px" },
          { id: "who", header: t("project.activity.who"), cell: (entry) => <span className="truncate">{entry.actor.label}</span> },
          {
            id: "what",
            header: t("project.activity.what"),
            cell: (entry) => <span className="font-mono text-[12.5px]">{entry.opId}</span>,
          },
          {
            id: "outcome",
            header: t("project.activity.outcome"),
            cell: (entry) =>
              entry.outcome === "ok" ? (
                <Chip tone="green">{t("project.activity.ok")}</Chip>
              ) : (
                <Chip tone="red">{entry.errorCode ?? t("project.activity.failed")}</Chip>
              ),
            hideOnMobile: true,
          },
        ]}
      />
      <div className="flex items-center gap-2">
        {list.data?.nextCursor && (
          <Button size="sm" onClick={() => setLimit((value) => Math.min(200, value + pageSize))} disabled={limit >= 200}>
            {t("project.activity.more")}
          </Button>
        )}
        <Link to="/activity" className="ml-auto text-[13px] font-medium">
          {t("project.activity.all")}
        </Link>
      </div>
    </div>
  );
}
