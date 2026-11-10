// Controls both chat views share: the auto mode switch (one choice per
// person, saved on the panel, so it follows them to every chat and
// device), the editable chat title, the delete confirmation, and the
// bubble's chats menu (New chat, recent chats, rename, delete).

import { ai, type OpOutput } from "@seylo/ops";
import { opQueryKey, useOp, useOpMutation } from "@seylo/ops/react";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@seylo/ui/components/dropdown-menu";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { Tip } from "@seylo/ui/components/tooltip";
import { cn } from "@seylo/ui/lib/utils";
import { IconBolt, IconChevronDown, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { queryClient } from "../../lib/api";
import { formatRelative } from "../settings/format";
import { invalidateOps } from "../settings/mutation";
import { toastError } from "../settings/op-state";
import { useAssistantAccess } from "./assistant-context";
import { conversationKey } from "./use-chat";

export type ConversationItem = OpOutput<typeof ai.conversations>["conversations"][number];

/** The auto mode switch with its label; it shows the new value while that saves. */
export function AutoSwitch({ className }: { className?: string }) {
  const { autoMode } = useAssistantAccess();
  const id = useId();
  const set = useOpMutation(ai.setAutoMode, {
    onSuccess: (out) => {
      queryClient.setQueryData<OpOutput<typeof ai.me>>(opQueryKey(ai.me, {}), (old) => (old ? { ...old, autoMode: out.autoMode } : old));
      void invalidateOps([ai.me]);
    },
    onError: (error) => toastError(error),
  });
  const checked = set.isPending ? (set.variables?.enabled ?? autoMode) : autoMode;
  return (
    <Tip content={t("assistant.autoHint")}>
      <span className={cn("flex shrink-0 items-center gap-1.5", className)}>
        <label
          htmlFor={id}
          className={cn("flex cursor-pointer items-center gap-1 text-[12.5px]", checked ? "text-chip-violet-fg" : "text-muted-foreground")}
        >
          <IconBolt size={13} stroke={2} aria-hidden="true" />
          {t("assistant.auto")}
        </label>
        <Switch
          id={id}
          size="sm"
          checked={checked}
          disabled={set.isPending}
          aria-label={t("assistant.autoLabel")}
          onCheckedChange={(enabled) => set.mutate({ enabled })}
        />
      </span>
    </Tip>
  );
}

/** The chat's title; Rename turns it into a field (Enter saves, Escape cancels). */
export function ChatTitle({
  conversation,
  editing,
  onEditingChange,
  className,
}: {
  conversation: { id: string; title: string } | undefined;
  editing: boolean;
  onEditingChange(editing: boolean): void;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLInputElement>(null);
  // The chat this edit started on; a refetch while typing keeps the draft, and the edit ends once.
  const editingId = useRef<string | null>(null);
  const rename = useOpMutation(ai.renameConversation, {
    onSuccess: () => void invalidateOps([ai.conversations, ai.conversation]),
    onError: (error) => toastError(error),
  });
  useEffect(() => {
    if (!editing || !conversation) {
      editingId.current = null;
      return;
    }
    if (editingId.current === conversation.id) return;
    editingId.current = conversation.id;
    setDraft(conversation.title);
    queueMicrotask(() => field.current?.select());
  }, [editing, conversation]);

  const title = conversation?.title || t("assistant.untitled");
  if (!editing || !conversation) {
    return <span className={cn("min-w-0 truncate", className)}>{rename.isPending ? (rename.variables?.title ?? title) : title}</span>;
  }
  const finish = (keep: boolean) => {
    if (editingId.current !== conversation.id) return;
    editingId.current = null;
    onEditingChange(false);
    const next = draft.replace(/\s+/g, " ").trim();
    if (keep && next && next !== conversation.title) rename.mutate({ conversationId: conversation.id, title: next.slice(0, 120) });
  };
  const save = () => finish(true);
  return (
    <input
      ref={field}
      value={draft}
      maxLength={120}
      aria-label={t("assistant.renameLabel")}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
        if (event.key === "Escape") {
          // Only the edit ends, not the chat around it.
          event.preventDefault();
          finish(false);
        }
      }}
      className={cn(
        "min-w-0 flex-1 rounded-chip border-0 bg-field px-2 py-1 font-[inherit] text-[inherit] text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/15",
        className,
      )}
    />
  );
}

/** Asks before a chat is deleted; `onDeleted` moves the view off it. */
export function DeleteChatDialog({
  conversation,
  onOpenChange,
  onDeleted,
}: {
  conversation: { id: string; title: string } | null;
  onOpenChange(open: boolean): void;
  onDeleted(conversationId: string): void;
}) {
  const remove = useOpMutation(ai.deleteConversation);
  return (
    <ConfirmDialog
      open={conversation !== null}
      onOpenChange={onOpenChange}
      title={t("assistant.deleteTitle", { title: conversation?.title || t("assistant.untitled") })}
      description={t("assistant.deleteDescription")}
      confirmLabel={t("assistant.delete")}
      destructive
      onConfirm={async () => {
        if (!conversation) return;
        await remove.mutateAsync({ conversationId: conversation.id });
        onDeleted(conversation.id);
        queryClient.removeQueries({ queryKey: conversationKey(conversation.id) });
        await invalidateOps([ai.conversations]);
        toast.success(t("assistant.deleted"));
      }}
    />
  );
}

/** A small count of what waits, or a dot while a reply is written. */
export function ChatBadges({ item }: { item: Pick<ConversationItem, "streaming" | "pendingApprovals"> }) {
  return (
    <>
      {item.pendingApprovals > 0 && (
        <span
          title={t("assistant.waiting", { count: item.pendingApprovals })}
          className="shrink-0 rounded-chip bg-chip-amber-bg px-1.5 py-px text-[11px] font-medium text-chip-amber-fg"
        >
          {item.pendingApprovals}
        </span>
      )}
      {item.streaming && (
        <span
          title={t("assistant.answering")}
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
        />
      )}
    </>
  );
}

/**
 * The bubble's header button: the chat's title with a menu of New chat, the
 * person's recent chats (newest first) and Rename and Delete for this one.
 */
export function ChatsMenu({
  current,
  title,
  onSelect,
  onRename,
  onDelete,
}: {
  current: ConversationItem | undefined;
  title: React.ReactNode;
  onSelect(conversationId: string | null): void;
  onRename(): void;
  onDelete(): void;
}) {
  const [open, setOpen] = useState(false);
  const list = useOp(ai.conversations, { limit: 20 }, { enabled: open });
  const chats = list.data?.conversations ?? [];
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={t("assistant.chats")}
        className="flex min-w-0 cursor-pointer items-center gap-1 rounded-control border-0 bg-transparent px-1.5 py-1 text-[13.5px] font-semibold text-foreground transition-interactive hover:bg-muted data-[state=open]:bg-muted"
      >
        {title}
        <IconChevronDown size={14} stroke={2} aria-hidden="true" className="shrink-0 text-ink-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(320px,calc(100vw-32px))]">
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          <IconPlus size={15} stroke={1.9} aria-hidden="true" />
          {t("assistant.newChat")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("assistant.recent")}</DropdownMenuLabel>
        <div className="max-h-[min(320px,50dvh)] overflow-y-auto">
          {list.isPending ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="mx-2.5 my-2 h-4 w-[70%]" />)
          ) : chats.length === 0 ? (
            <p className="m-0 px-2.5 py-2 text-[12.5px] text-muted-foreground">{t("assistant.noChats")}</p>
          ) : (
            chats.map((chat) => (
              <DropdownMenuItem
                key={chat.id}
                onSelect={() => onSelect(chat.id)}
                aria-current={chat.id === current?.id ? "true" : undefined}
                className={cn(chat.id === current?.id && "bg-accent text-accent-foreground")}
              >
                <span className="min-w-0 flex-1 truncate">{chat.title || t("assistant.untitled")}</span>
                <ChatBadges item={chat} />
                <span className="shrink-0 text-[11.5px] text-ink-ghost">{formatRelative(chat.updatedAt)}</span>
              </DropdownMenuItem>
            ))
          )}
        </div>
        {current && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRename}>
              <IconPencil size={15} stroke={1.9} aria-hidden="true" />
              {t("assistant.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={onDelete}>
              <IconTrash size={15} stroke={1.9} aria-hidden="true" />
              {t("assistant.delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
