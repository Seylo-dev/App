// The tag field of the Docker Hub form: a button showing the chosen tag
// that opens a list of tags, newest first, with their CPU platforms, size
// and age. Typing filters on Docker Hub (dockerHub.tags with a filter), so
// tags past the first page can be found too.

import { dockerHub } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Chip } from "@seylo/ui/components/chip";
import { Popover, PopoverContent, PopoverTrigger } from "@seylo/ui/components/popover";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconCheck, IconChevronDown, IconSearch } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../i18n/t";
import { formatAgo, formatBytes } from "../../lib/format";
import { QueryError } from "../query-error";
import { retryOp } from "../service/op-state";
import { archOf, type TagInfo } from "./prefill";
import { useDebounced } from "./use-debounced";

export function TagPicker({
  id,
  repository,
  value,
  suggested,
  firstPage,
  onChange,
}: {
  id: string;
  repository: string;
  value: string | null;
  suggested: string | null;
  /** The unfiltered first page, already loaded by the form. */
  firstPage: TagInfo[] | undefined;
  onChange: (tag: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const filter = useDebounced(text.trim(), 300);
  const filtered = useOp(dockerHub.tags, { repository, filter }, { enabled: open && filter !== "", retry: retryOp, staleTime: 5 * 60_000 });
  const list = filter === "" ? firstPage : filtered.data?.tags;
  const loading = filter === "" ? firstPage === undefined : filtered.isPending;

  if (firstPage === undefined && value === null) {
    return (
      <LoadingRegion label={t("dockerHub.reading")}>
        <Skeleton className="h-[38px]" />
      </LoadingRegion>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Drawn like the kit's SelectTrigger (the Node and Main port fields next to it), focus ring included. */}
        <button
          id={id}
          type="button"
          className="flex h-[38px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border border-input bg-card px-3 text-left text-[13.5px] text-foreground outline-none transition-interactive focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15"
        >
          <span className="truncate font-mono">{value ?? "-"}</span>
          {value !== null && value === suggested && (
            <Chip tone="green" className="py-px text-[11px]">
              {t("dockerHub.tagSuggested")}
            </Chip>
          )}
          <IconChevronDown size={15} className="ml-auto shrink-0 text-ink-faint" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(420px,calc(100vw-32px))] p-0">
        <label className="flex items-center gap-2 border-b border-divider px-3">
          <IconSearch size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the list opens to be searched
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("dockerHub.tagSearch")}
            aria-label={t("dockerHub.tagSearch")}
            className="h-10 w-full border-0 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div role="listbox" aria-label={t("dockerHub.tag")} aria-busy={loading} className="max-h-72 overflow-y-auto p-1.5">
          {filter !== "" && filtered.isError && <QueryError error={filtered.error} className="m-1" />}
          {loading && !filtered.isError && [0, 1, 2, 3].map((key) => <TagOptionSkeleton key={key} />)}
          {!loading && list?.length === 0 && (
            <p className="m-0 px-3 py-5 text-center text-[13px] text-muted-foreground">{t("dockerHub.tagNone")}</p>
          )}
          {list?.map((tag) => (
            <TagOption
              key={tag.name}
              tag={tag}
              selected={tag.name === value}
              suggested={tag.name === suggested}
              onPick={() => {
                onChange(tag.name);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TagOption({ tag, selected, suggested, onPick }: { tag: TagInfo; selected: boolean; suggested: boolean; onPick: () => void }) {
  const size = tag.platforms.find((p) => p.platform === "linux/amd64")?.sizeBytes ?? tag.platforms[0]?.sizeBytes ?? null;
  const arches = [...new Set(tag.platforms.map((p) => archOf(p.platform)))];
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-2 text-left hover:bg-accent",
        selected && "bg-accent",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[13px] text-foreground">{tag.name}</span>
          {suggested && (
            <Chip tone="green" className="py-px text-[10.5px]">
              {t("dockerHub.tagSuggested")}
            </Chip>
          )}
        </span>
        <span className="truncate text-[11.5px] text-muted-foreground">
          {[arches.join(" · "), size !== null ? formatBytes(size) : null, tag.updatedAt ? formatAgo(tag.updatedAt) : null]
            .filter(Boolean)
            .join(t("format.separator"))}
        </span>
      </span>
      {selected && <IconCheck size={15} stroke={2} className="shrink-0 text-primary" aria-hidden="true" />}
    </button>
  );
}

/** A tag option while the list loads: the tag name over its platforms, size and age. */
function TagOptionSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-0.5 px-2.5 py-2">
      <SkeletonText className="w-24 text-[13px]" />
      <SkeletonText className="w-44 text-[11.5px]" />
    </div>
  );
}
