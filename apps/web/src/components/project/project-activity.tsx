// The project's audit trail: who changed the project, newest first, in the
// same table as the Activity page (components/activity/activity-log.tsx).
// The full log with filters is the Activity page.

import { audit } from "@seylo/ops";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { SectionCard } from "@seylo/ui/components/section-card";
import { IconActivity } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../i18n/t";
import { type ActivityEntry, ActivityTable, EntrySheet, LoadMore } from "../activity/activity-log";
import { QueryError } from "../query-error";
import { useOpPages } from "../settings/paging";

export function ProjectActivity({ projectId }: { projectId: string }) {
  const pages = useOpPages(audit.list, { targetType: "project", targetId: projectId, limit: 50 }, (page) => page.nextCursor);
  const [open, setOpen] = useState<ActivityEntry | null>(null);
  if (pages.isError) return <QueryError error={pages.error} onRetry={() => void pages.refetch()} />;
  const entries = pages.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <SectionCard flush contentClassName="gap-0">
        <ActivityTable
          aria-label={t("project.tabs.activity")}
          loading={pages.isPending}
          entries={entries}
          target={false}
          onOpen={setOpen}
          empty={<EmptyState compact icon={<IconActivity />} title={t("project.activity.empty")} />}
        />
        {pages.hasNextPage && <LoadMore fetching={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />}
      </SectionCard>
      <Link to="/activity" className="self-end text-[13px] font-medium">
        {t("project.activity.all")}
      </Link>
      <EntrySheet entry={open} onClose={() => setOpen(null)} />
    </div>
  );
}
