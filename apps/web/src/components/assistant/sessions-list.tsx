// The Assistant page's list of the person's chats: New chat, a search over
// the titles (the panel searches, so it covers every chat, not just the
// loaded ones), newest first with what waits and what is being answered,
// the current one under a sliding background, and Rename and Delete in
// each row's menu. The same list sits in a sheet on a phone.

import { ai } from "@seylo/ops";
import { Button } from "@seylo/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { ActiveIndicator } from "@seylo/ui/components/motion";
import { LoadingRegion, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconDots, IconMessages, IconPencil, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { useDeferredValue, useState } from "react";
import { t } from "../../i18n/t";
import { formatRelative } from "../settings/format";
import { useOpPages } from "../settings/paging";
import { ChatBadges, ChatTitle, type ConversationItem } from "./chat-controls";

export function SessionsList({
  current,
  onSelect,
  onDelete,
  className,
}: {
  current: string | null;
  onSelect(conversationId: string | null): void;
  onDelete(conversation: { id: string; title: string }): void;
  className?: string;
}) {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const pages = useOpPages(ai.conversations, { limit: 30, ...(query ? { query } : {}) }, (page) => page.nextCursor);
  const chats = pages.data?.pages.flatMap((page) => page.conversations) ?? [];
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <Button variant="primary" className="w-full" onClick={() => onSelect(null)}>
        <IconPlus size={16} stroke={2} aria-hidden="true" />
        {t("assistant.newChat")}
      </Button>
      <div className="relative">
        <IconSearch
          size={15}
          stroke={1.8}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
        />
        <input
          type="search"
          value={search}
          aria-label={t("assistant.search")}
          placeholder={t("assistant.search")}
          onChange={(event) => setSearch(event.target.value)}
          className="h-9 w-full min-w-0 rounded-control border-0 bg-field pr-3 pl-9 text-[13px] text-foreground outline-none transition-interactive placeholder:text-ink-ghost focus-visible:ring-3 focus-visible:ring-ring/15"
        />
      </div>
      <nav aria-label={t("assistant.chats")} className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {pages.isPending ? (
          <LoadingRegion label={t("common.loading")} className="flex flex-col gap-0.5">
            {[64, 80, 52, 72, 60].map((width) => (
              <div key={width} className="flex flex-col gap-1 px-2.5 py-2">
                <SkeletonText className="text-[13px]" style={{ width: `${width}%` }} />
                <SkeletonText className="w-14 text-[11.5px]" />
              </div>
            ))}
          </LoadingRegion>
        ) : chats.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
            <IconMessages size={20} stroke={1.6} aria-hidden="true" className="text-ink-faint" />
            <p className="m-0 text-[13px] font-medium text-foreground">{query ? t("assistant.noMatches") : t("assistant.noChats")}</p>
            {!query && <p className="m-0 text-[12.5px] text-muted-foreground">{t("assistant.noChatsHint")}</p>}
          </div>
        ) : (
          chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              active={chat.id === current}
              renaming={renaming === chat.id}
              onRenamingChange={(on) => setRenaming(on ? chat.id : null)}
              onSelect={() => onSelect(chat.id)}
              onDelete={() => onDelete({ id: chat.id, title: chat.title })}
            />
          ))
        )}
        {pages.hasNextPage && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 self-center"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {t("assistant.loadMore")}
          </Button>
        )}
      </nav>
    </div>
  );
}

function ChatRow({
  chat,
  active,
  renaming,
  onRenamingChange,
  onSelect,
  onDelete,
}: {
  chat: ConversationItem;
  active: boolean;
  renaming: boolean;
  onRenamingChange(renaming: boolean): void;
  onSelect(): void;
  onDelete(): void;
}) {
  return (
    <div className="group relative isolate flex items-center rounded-control transition-interactive hover:bg-muted">
      {active && <ActiveIndicator layoutId="assistant-chats" className="rounded-control bg-accent" />}
      {renaming ? (
        <div className="flex min-w-0 flex-1 px-1.5 py-1.5">
          <ChatTitle conversation={chat} editing onEditingChange={onRenamingChange} className="text-[13px]" />
        </div>
      ) : (
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          onClick={onSelect}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 border-0 bg-transparent py-2 pr-9 pl-2.5 text-left",
            active ? "text-accent-foreground" : "text-ink-strong hover:text-foreground",
          )}
        >
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px]">{chat.title || t("assistant.untitled")}</span>
            <ChatBadges item={chat} />
          </span>
          <span className={cn("text-[11.5px]", active ? "text-accent-foreground/75" : "text-ink-ghost")}>
            {formatRelative(chat.updatedAt)}
          </span>
        </button>
      )}
      {!renaming && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`${t("assistant.chatActions")}: ${chat.title || t("assistant.untitled")}`}
            className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent text-ink-faint opacity-0 transition-interactive group-hover:opacity-100 hover:bg-card hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <IconDots size={15} stroke={1.9} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRenamingChange(true)}>
              <IconPencil size={15} stroke={1.9} aria-hidden="true" />
              {t("assistant.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={onDelete}>
              <IconTrash size={15} stroke={1.9} aria-hidden="true" />
              {t("assistant.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
