// Templates (Templates.dc.html): the catalog with search and category
// chips; a card opens the install dialog. ?project=<id> preselects the
// project (from a project's New service menu), ?q= and ?category= keep the
// filter in the URL. ?tab=docker-hub switches to Docker Hub search (the
// same search box, sent to dockerHub.search); the popular images row and
// every Docker Hub result open the prefilled image form.

import { templates } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { EnterOnChange } from "@seylo/ui/components/motion";
import { Segmented, SegmentedItem, SegmentPill } from "@seylo/ui/components/segmented";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { scrollFadeRef } from "@seylo/ui/lib/scroll-fade";
import { cn } from "@seylo/ui/lib/utils";
import { IconLayoutGrid, IconSearch } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useDeferredValue, useState } from "react";
import { HubResults } from "../../components/docker-hub/hub-results";
import { type HubTarget, ImageDialog } from "../../components/docker-hub/image-dialog";
import { PopularRow } from "../../components/docker-hub/popular-row";
import { useDebounced } from "../../components/docker-hub/use-debounced";
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
  tab?: "docker-hub";
}

export const Route = createFileRoute("/_app/templates")({
  validateSearch: (search: Record<string, unknown>): TemplatesSearch => ({
    project: typeof search.project === "string" && /^[a-z0-9]{16}$/.test(search.project) ? search.project : undefined,
    category: typeof search.category === "string" && search.category !== "" ? search.category.slice(0, 60) : undefined,
    q: typeof search.q === "string" && search.q !== "" ? search.q.slice(0, 100) : undefined,
    tab: search.tab === "docker-hub" ? "docker-hub" : undefined,
  }),
  component: TemplatesPage,
});

function TemplatesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [text, setText] = useState(search.q ?? "");
  const query = useDeferredValue(text.trim());
  const [installing, setInstalling] = useState<TemplateSummary | null>(null);
  const [image, setImage] = useState<HubTarget | null>(null);
  const hub = search.tab === "docker-hub";
  // Docker Hub is searched once typing pauses; the catalog filters as you type.
  const hubQuery = useDebounced(text.trim(), 350);
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
          // The kit's Input with a leading icon, like every other search box in the panel.
          <div className="relative w-full sm:w-[300px]">
            <IconSearch
              size={15}
              stroke={1.8}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                void navigate({ search: (prev) => ({ ...prev, q: e.target.value || undefined }), replace: true });
              }}
              placeholder={
                hub
                  ? t("dockerHub.search")
                  : all.data
                    ? t("templates.searchCount", { count: all.data.templates.length })
                    : t("templates.search")
              }
              aria-label={hub ? t("dockerHub.search") : t("templates.search")}
              className="pl-9"
            />
          </div>
        }
      />

      <Segmented
        aria-label={t("dockerHub.tabs")}
        tone="track"
        value={hub ? "docker-hub" : "templates"}
        onValueChange={(value) =>
          void navigate({ search: (prev) => ({ ...prev, tab: value === "docker-hub" ? "docker-hub" : undefined }), replace: true })
        }
        className="self-start"
      >
        <SegmentedItem value="templates">{t("dockerHub.tabTemplates")}</SegmentedItem>
        <SegmentedItem value="docker-hub">{t("dockerHub.tabDockerHub")}</SegmentedItem>
      </Segmented>

      {/* Switching between the catalog and Docker Hub fades the content in, like a tab. */}
      <EnterOnChange motionKey={hub ? "docker-hub" : "templates"} subtle className="flex min-w-0 flex-col gap-5">
        {hub && <HubResults query={hubQuery} onPick={setImage} />}

        {!hub && all.isPending && (
          <div aria-hidden="true" className="scroll-row flex max-w-full gap-0.5 self-start rounded-control bg-track p-[3px]">
            {["w-9", "w-[86px]", "w-[74px]", "w-[82px]", "w-16", "w-12", "w-[104px]"].map((width) => (
              <Skeleton key={width} className={`h-7 rounded-chip bg-card/70 ${width}`} />
            ))}
          </div>
        )}
        {!hub && categories.length > 0 && (
          // One row like the Segmented above it: on a phone it scrolls sideways (the hidden edge fades) instead of wrapping into a box.
          <fieldset
            ref={scrollFadeRef}
            aria-label={t("templates.categories")}
            className="scroll-row m-0 flex max-w-full min-w-0 gap-0.5 self-start rounded-control border-0 bg-track p-[3px]"
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

        {hub ? null : list.isError && !list.data ? (
          <QueryError error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <LoadingRegion label={t("common.loading")} className="grid grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))] gap-4">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((key) => (
              <TemplateCardSkeleton key={key} />
            ))}
          </LoadingRegion>
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

        {!hub && !search.category && !query && <PopularRow onPick={setImage} />}
      </EnterOnChange>

      <InstallDialog template={installing} projectId={search.project} onClose={() => setInstalling(null)} />
      <ImageDialog target={image} projectId={search.project} onClose={() => setImage(null)} />
    </>
  );
}

/** A template card while the catalog loads: logo, name and category, two lines of description, what it creates. */
function TemplateCardSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-card bg-card p-4 shadow-card">
      <span className="flex items-center gap-[11px]">
        <Skeleton className="size-9 shrink-0 rounded-[9px]" />
        <span className="flex min-w-0 flex-col gap-px">
          <SkeletonText className="w-20 text-sm" />
          <SkeletonText className="w-16 text-xs" />
        </span>
      </span>
      <span className="flex flex-col">
        <SkeletonText className="w-full text-[12.5px] leading-[1.45]" />
        <SkeletonText className="w-2/3 text-[12.5px] leading-[1.45]" />
      </span>
      <span className="mt-auto border-t border-divider pt-2.5">
        <SkeletonText className="w-20 text-[11.5px]" />
      </span>
    </div>
  );
}

function CategoryButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "relative isolate h-7 shrink-0 cursor-pointer rounded-chip border-0 bg-transparent px-3 text-[12.5px] whitespace-nowrap transition-colors duration-200",
        pressed ? "text-foreground" : "text-ink-strong hover:text-foreground",
      )}
    >
      {pressed && <SegmentPill layoutId="template-categories" />}
      {children}
    </button>
  );
}
