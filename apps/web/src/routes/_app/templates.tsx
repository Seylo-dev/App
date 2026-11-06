// Templates (Templates.dc.html): the catalog with search and category
// chips; a card opens the install dialog. ?project=<id> preselects the
// project (from a project's New service menu), ?q= and ?category= keep the
// filter in the URL.

import { templates } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { SegmentPill } from "@seylo/ui/components/segmented";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconLayoutGrid, IconSearch } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useDeferredValue, useState } from "react";
import { PageHeader } from "../../components/page-header";
import { QueryError } from "../../components/query-error";
import { InstallDialog } from "../../components/templates/install-dialog";
import { TemplateLogo } from "../../components/templates/template-logo";
import { t } from "../../i18n/t";
import type { TemplateSummary } from "../../lib/types";

interface TemplatesSearch {
  project?: string;
  category?: string;
  q?: string;
}

export const Route = createFileRoute("/_app/templates")({
  validateSearch: (search: Record<string, unknown>): TemplatesSearch => ({
    project: typeof search.project === "string" && /^[a-z0-9]{16}$/.test(search.project) ? search.project : undefined,
    category: typeof search.category === "string" && search.category !== "" ? search.category.slice(0, 60) : undefined,
    q: typeof search.q === "string" && search.q !== "" ? search.q.slice(0, 100) : undefined,
  }),
  component: TemplatesPage,
});

function TemplatesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [text, setText] = useState(search.q ?? "");
  const query = useDeferredValue(text.trim());
  const [installing, setInstalling] = useState<TemplateSummary | null>(null);
  const list = useOp(templates.list, { category: search.category, query: query || undefined }, { placeholderData: (previous) => previous });
  // Categories and the count come from the unfiltered catalog, so the chips do not jump while typing.
  const all = useOp(templates.list, {});
  const categories = all.data?.categories ?? [];

  const pickCategory = (category: string | undefined) => void navigate({ search: (prev) => ({ ...prev, category }), replace: true });

  return (
    <>
      <PageHeader
        title={t("nav.templates")}
        subtitle={t("templates.subtitle")}
        actions={
          <label className="flex h-[38px] w-full items-center gap-2 rounded-control bg-card px-3 shadow-control sm:w-[300px]">
            <IconSearch size={15} stroke={1.8} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                void navigate({ search: (prev) => ({ ...prev, q: e.target.value || undefined }), replace: true });
              }}
              placeholder={all.data ? t("templates.searchCount", { count: all.data.templates.length }) : t("templates.search")}
              aria-label={t("templates.search")}
              className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        }
      />

      {categories.length > 0 && (
        <fieldset
          aria-label={t("templates.categories")}
          className="m-0 flex max-w-full min-w-0 border-0 flex-wrap gap-0.5 self-start rounded-control bg-track p-[3px]"
        >
          <CategoryButton pressed={!search.category} onClick={() => pickCategory(undefined)}>
            {t("templates.all")}
          </CategoryButton>
          {categories.map((category) => (
            <CategoryButton key={category} pressed={search.category === category} onClick={() => pickCategory(category)}>
              {category}
            </CategoryButton>
          ))}
        </fieldset>
      )}

      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))] gap-4">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <Skeleton key={key} className="h-[140px] rounded-card" />
          ))}
        </div>
      ) : list.data.templates.length === 0 ? (
        <div className="rounded-card bg-card shadow-card">
          <EmptyState icon={<IconLayoutGrid />} title={t("templates.empty")} description={t("templates.emptyHint")} />
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))] gap-4">
          {list.data.templates.map((template) => (
            <button
              key={template.slug}
              type="button"
              onClick={() => setInstalling(template)}
              className="flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-card border-0 bg-card p-4 text-left text-foreground shadow-card transition-shadow hover:shadow-popover"
            >
              <span className="flex items-center gap-[11px]">
                <TemplateLogo slug={template.slug} name={template.name} logoUrl={template.logoUrl} />
                <span className="flex min-w-0 flex-col gap-px">
                  <b className="truncate text-sm font-semibold">{template.name}</b>
                  <span className="text-xs text-muted-foreground">{template.category}</span>
                </span>
              </span>
              <span className="text-[12.5px] leading-[1.45] text-ink-strong">{template.description}</span>
              <span className="mt-auto border-t border-divider pt-2.5 text-[11.5px] text-muted-foreground">{template.creates}</span>
            </button>
          ))}
        </div>
      )}

      <InstallDialog template={installing} projectId={search.project} onClose={() => setInstalling(null)} />
    </>
  );
}

function CategoryButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "relative isolate h-7 cursor-pointer rounded-chip border-0 bg-transparent px-3 text-[12.5px]",
        pressed ? "text-foreground" : "text-ink-strong hover:text-foreground",
      )}
    >
      {pressed && <SegmentPill layoutId="template-categories" />}
      {children}
    </button>
  );
}
