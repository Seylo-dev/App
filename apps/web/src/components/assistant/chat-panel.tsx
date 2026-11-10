// The bubble's chat: a compact panel with the chat's title and the chats
// menu, the auto mode switch, a way to the Assistant page (when it is on)
// and close; the conversation below. Loaded on first open, so pages that
// never open it do not download Markdown and the chat code.

import { Tip } from "@seylo/ui/components/tooltip";
import { IconArrowsDiagonal, IconX } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../i18n/t";
import { useAssistant, useAssistantAccess } from "./assistant-context";
import { ChatBody } from "./chat-body";
import { AutoSwitch, ChatBadges, ChatsMenu, ChatTitle, DeleteChatDialog } from "./chat-controls";
import { useConversation } from "./use-chat";

const iconButton =
  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-ink-faint transition-interactive hover:bg-muted hover:text-foreground";

export default function ChatPanel({ titleId }: { titleId: string }) {
  const assistant = useAssistant();
  const access = useAssistantAccess();
  const current = assistant.current;
  // The same cache entry the conversation below reads, so it is fetched once.
  const conversation = useConversation(current).data?.conversation;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);

  return (
    <>
      <header className="flex items-center gap-1 border-b border-divider py-2 pr-2 pl-2.5">
        <h2 id={titleId} className="m-0 flex min-w-0 flex-1 items-center text-[13.5px] font-semibold">
          {editing && conversation ? (
            <ChatTitle conversation={conversation} editing onEditingChange={setEditing} />
          ) : (
            <ChatsMenu
              current={conversation}
              title={<ChatTitle conversation={conversation} editing={false} onEditingChange={setEditing} />}
              onSelect={(id) => assistant.select(id)}
              onRename={() => setEditing(true)}
              onDelete={() => conversation && setDeleting({ id: conversation.id, title: conversation.title })}
            />
          )}
          {conversation && <ChatBadges item={conversation} />}
        </h2>
        <AutoSwitch className="mr-1" />
        {access.page && (
          <Tip content={t("assistant.expand")}>
            <Link
              to="/assistant"
              search={{ c: current ?? undefined }}
              aria-label={t("assistant.expand")}
              onClick={() => assistant.setOpen(false)}
              className={iconButton}
            >
              <IconArrowsDiagonal size={16} stroke={1.8} aria-hidden="true" />
            </Link>
          </Tip>
        )}
        <button type="button" aria-label={t("assistant.close")} onClick={() => assistant.setOpen(false)} className={iconButton}>
          <IconX size={16} stroke={1.9} aria-hidden="true" />
        </button>
      </header>
      <ChatBody conversationId={current} onStarted={(id) => assistant.select(id)} onGone={() => assistant.select(null)} variant="bubble" />
      <DeleteChatDialog
        conversation={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={(id) => {
          if (assistant.current === id) assistant.select(null);
        }}
      />
    </>
  );
}
