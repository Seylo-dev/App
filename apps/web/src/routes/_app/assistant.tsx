// The Assistant page (sidebar, while Settings > AI assistant > Assistant
// page is on): the person's chats on the left with New chat and search,
// the conversation in a calm centered column on the right, the composer at
// the bottom. The same chats as the bubble: the chat is ?c=<id>, and the
// bubble picks it up when the person leaves (assistant-context.tsx). On a
// phone the list opens in a sheet.

import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@seylo/ui/components/dropdown-menu";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Sheet, SheetContent, SheetTitle } from "@seylo/ui/components/sheet";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { IconDots, IconMenu2, IconPencil, IconSparkles, IconTrash } from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAssistant, useAssistantAccess } from "../../components/assistant/assistant-context";
import { ChatBody } from "../../components/assistant/chat-body";
import { AutoSwitch, ChatBadges, ChatTitle, DeleteChatDialog } from "../../components/assistant/chat-controls";
import { SessionsList } from "../../components/assistant/sessions-list";
import { useConversation } from "../../components/assistant/use-chat";
import { t } from "../../i18n/t";

interface AssistantSearch {
  /** The chat shown; none for a new one. */
  c?: string;
}

export const Route = createFileRoute("/_app/assistant")({
  validateSearch: (search: Record<string, unknown>): AssistantSearch => ({
    c: typeof search.c === "string" && /^[a-z0-9]{16}$/.test(search.c) ? search.c : undefined,
  }),
  component: AssistantPage,
});

/** The viewport less the shell's top and bottom padding (a phone also has the sidebar's top bar). */
const fill = "h-[calc(100dvh-136px)] min-h-[460px] md:h-[calc(100dvh-66px)]";

function AssistantPage() {
  const access = useAssistantAccess();
  if (access.query.isPending) {
    return (
      <div aria-hidden="true" className={`flex gap-4 ${fill}`}>
        <Skeleton className="hidden w-[272px] shrink-0 rounded-card md:block" />
        <Skeleton className="flex-1 rounded-card" />
      </div>
    );
  }
  const me = access.query.data;
  if (!me?.available || !me.chatPage) {
    const reason = !me ? "disabled" : !me.available ? (me.reason ?? "disabled") : "pageOff";
    return (
      <Card>
        <EmptyState
          icon={<IconSparkles />}
          title={t("assistant.unavailable.title")}
          description={t(`assistant.unavailable.${reason}`)}
          action={
            <Button asChild>
              <Link to="/settings/ai">{t("assistant.openSettings")}</Link>
            </Button>
          }
        />
      </Card>
    );
  }
  return <AssistantChats />;
}

function AssistantChats() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const assistant = useAssistant();
  const current = search.c ?? null;
  const conversation = useConversation(current).data?.conversation;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const show = (id: string | null, replace = false) => {
    setListOpen(false);
    void navigate({ search: { c: id ?? undefined }, replace });
  };

  // Opened without a chat: the one the bubble had.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on arrival
  useEffect(() => {
    if (!search.c && assistant.current) show(assistant.current, true);
  }, []);
  // The bubble follows this page's chat.
  const select = assistant.select;
  useEffect(() => select(current), [current, select]);

  const list = <SessionsList current={current} onSelect={(id) => show(id)} onDelete={(chat) => setDeleting(chat)} className="h-full" />;

  return (
    <div className={`flex gap-4 ${fill}`}>
      <Card className="hidden w-[272px] shrink-0 gap-0 p-3 md:flex">{list}</Card>
      <Card className="min-w-0 flex-1 gap-0 overflow-hidden p-0">
        <header className="flex items-center gap-2 border-b border-divider px-3 py-2.5 sm:px-4">
          <Button size="icon" variant="ghost" className="md:hidden" aria-label={t("assistant.chats")} onClick={() => setListOpen(true)}>
            <IconMenu2 size={17} stroke={1.8} aria-hidden="true" />
          </Button>
          <h1 className="m-0 flex min-w-0 flex-1 items-center gap-2 text-[15px] font-semibold">
            <ChatTitle conversation={conversation} editing={editing} onEditingChange={setEditing} />
            {conversation && <ChatBadges item={conversation} />}
          </h1>
          <AutoSwitch />
          {conversation && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("assistant.chatActions")}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-ink-faint transition-interactive hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"
              >
                <IconDots size={16} stroke={1.9} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <IconPencil size={15} stroke={1.9} aria-hidden="true" />
                  {t("assistant.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => setDeleting({ id: conversation.id, title: conversation.title })}>
                  <IconTrash size={15} stroke={1.9} aria-hidden="true" />
                  {t("assistant.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </header>
        <ChatBody conversationId={current} onStarted={(id) => show(id, true)} onGone={() => show(null, true)} variant="page" />
      </Card>

      <Sheet open={listOpen} onOpenChange={setListOpen}>
        <SheetContent side="left" className="gap-3 p-4 pt-5">
          <SheetTitle>{t("assistant.chats")}</SheetTitle>
          {list}
        </SheetContent>
      </Sheet>
      <DeleteChatDialog
        conversation={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={(id) => {
          if (id === current) show(null, true);
        }}
      />
    </div>
  );
}
