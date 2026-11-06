// The Docker Hub tab of the Templates page: results for the search box in
// the page header (dockerHub.search), official images and verified
// publishers first, 25 at a time with "Show more". Before anything is
// typed it shows the popular images. Picking a result opens the setup form.

import { dockerHub, OpError } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { IconBrandDocker, IconCircleCheck, IconDownload, IconRosetteDiscountCheck, IconStar } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { QueryError } from "../query-error";
import { retryOp } from "../service/op-state";
import { TemplateLogo } from "../templates/template-logo";
import type { HubTarget } from "./image-dialog";
import { PopularRow } from "./popular-row";
import { formatCount, type SearchResult } from "./prefill";

export function HubResults({ query, onPick }: { query: string; onPick: (target: HubTarget) => void }) {
  const [pages, setPages] = useState({ query, count: 1 });
  // A new query starts again at one page.
  const count = pages.query === query ? pages.count : 1;
  if (query === "") {
    return (
      <>
        <div className="rounded-card bg-card shadow-card">
          <EmptyState icon={<IconBrandDocker />} title={t("dockerHub.startTitle")} description={t("dockerHub.startHint")} />
        </div>
        <PopularRow onPick={onPick} />
      </>
    );
  }
  return (
    <section aria-label={t("dockerHub.results")} className="flex flex-col gap-2.5">
      {Array.from({ length: count }, (_, i) => (
        <ResultsPage
          // biome-ignore lint/suspicious/noArrayIndexKey: pages are positional
          key={i}
          query={query}
          page={i + 1}
          last={i + 1 === count}
          onMore={() => setPages({ query, count: count + 1 })}
          onPick={onPick}
        />
      ))}
    </section>
  );
}

function ResultsPage({
  query,
  page,
  last,
  onMore,
  onPick,
}: {
  query: string;
  page: number;
  last: boolean;
  onMore: () => void;
  onPick: (target: HubTarget) => void;
}) {
  const results = useOp(dockerHub.search, { query, page }, { retry: retryOp, staleTime: 10 * 60_000, placeholderData: (prev) => prev });
  if (results.isError) {
    if (results.error instanceof OpError && results.error.code === "RATE_LIMITED") {
      return (
        <Alert tone="warning" title={t("dockerHub.rateLimited")}>
          {errorMessage(results.error, "")}
        </Alert>
      );
    }
    return <QueryError error={results.error} onRetry={() => void results.refetch()} />;
  }
  if (results.isPending) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2.5">
        {[0, 1, 2, 3, 4].map((key) => (
          <div key={key} className="flex items-center gap-3 rounded-card bg-card px-4 py-3.5 shadow-card">
            <Skeleton className="size-9 rounded-[9px]" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3.5 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (page === 1 && results.data.results.length === 0) {
    return (
      <div className="rounded-card bg-card shadow-card">
        <EmptyState icon={<IconBrandDocker />} title={t("dockerHub.noResults")} description={t("dockerHub.noResultsHint")} />
      </div>
    );
  }
  return (
    <>
      {results.data.results.map((result) => (
        <ResultRow key={result.repository} result={result} onPick={onPick} />
      ))}
      {last && results.data.hasMore && (
        <Button className="cursor-pointer self-center transition-colors duration-200" onClick={onMore}>
          {t("dockerHub.more")}
        </Button>
      )}
    </>
  );
}

function ResultRow({ result, onPick }: { result: SearchResult; onPick: (target: HubTarget) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick({ repository: result.repository, description: result.description })}
      className="flex min-w-0 cursor-pointer items-start gap-3 rounded-card border-0 bg-card px-4 py-3.5 text-left text-foreground shadow-card transition-shadow duration-200 hover:shadow-popover"
    >
      <TemplateLogo slug={result.repository} name={result.repository.split("/").pop() ?? result.repository} logoUrl={null} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <b className="truncate font-mono text-[13.5px] font-semibold">{result.repository}</b>
          <BadgeChip badge={result.badge} />
          <span className="text-xs text-muted-foreground">{result.publisher}</span>
        </span>
        {result.description && <span className="line-clamp-2 text-[12.5px] leading-[1.45] text-ink-strong">{result.description}</span>}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <IconDownload size={13} stroke={1.8} aria-hidden="true" />
            {t("dockerHub.pulls", { count: formatCount(result.pullCount) })}
          </span>
          <span className="flex items-center gap-1">
            <IconStar size={13} stroke={1.8} aria-hidden="true" />
            {t("dockerHub.stars", { count: formatCount(result.stars) })}
          </span>
          {result.architectures.length > 0 && <span className="font-mono">{result.architectures.join(" · ")}</span>}
        </span>
      </span>
    </button>
  );
}

function BadgeChip({ badge }: { badge: SearchResult["badge"] }) {
  if (badge === "none") return null;
  const tone = badge === "official" ? "blue" : badge === "verified" ? "green" : "violet";
  const Icon = badge === "official" ? IconCircleCheck : IconRosetteDiscountCheck;
  return (
    <Chip tone={tone} className="py-px text-[11px]">
      <Icon size={12} stroke={2} aria-hidden="true" />
      {t(`dockerHub.badges.${badge}`)}
    </Chip>
  );
}
