// The conversation itself, shared by the bubble and the Assistant page: the
// messages (the person's on the right, the assistant's text as Markdown
// with its tool calls as action cards), suggestion chips on an empty chat,
// a failed or stopped reply with Retry, and the composer (Enter sends,
// Shift+Enter breaks the line, Stop while a reply streams). The page is the
// same view, just wider.

import { ai } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconAlertTriangle, IconArrowUp, IconBolt, IconPlayerStopFilled, IconRefresh, IconSparkles } from "@tabler/icons-react";
import { useRouterState } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { Markdown } from "../markdown";
import { invalidateOps } from "../settings/mutation";
import { ToolCallCard } from "./action-card";
import { useAssistantAccess } from "./assistant-context";
import { contextOf, placeOf, suggestionsFor } from "./place";
import { type Chat, useChat } from "./use-chat";

type Message = ai.AiMessage;

export type ChatVariant = "bubble" | "page";

/**
 * Keeps a scroll box at the bottom while new text arrives, unless the
 * person scrolled up to read; jumping to another chat starts at its end.
 */
function useStickToBottom(key: string, content: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    const onScroll = () => {
      pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new chat is the trigger
  useLayoutEffect(() => {
    pinned.current = true;
  }, [key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new content is the trigger
  useLayoutEffect(() => {
    const box = ref.current;
    if (box && pinned.current) box.scrollTop = box.scrollHeight;
  }, [content, key]);
  return ref;
}

export function ChatBody({
  conversationId,
  onStarted,
  onGone,
  variant,
  className,
}: {
  conversationId: string | null;
  onStarted(conversationId: string): void;
  /** The chat no longer exists (deleted in another tab): the view moves to a new one. */
  onGone(): void;
  variant: ChatVariant;
  className?: string;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const place = useMemo(() => placeOf(pathname), [pathname]);
  const context = useMemo(() => contextOf(place), [place]);
  const chat = useChat(conversationId, { context, onStarted });
  const access = useAssistantAccess();
  const scroller = useStickToBottom(conversationId ?? "new", chat.messages);
  const wide = variant === "page";
  const gone = chat.loadError?.code === "NOT_FOUND";
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the answer says it is gone
  useEffect(() => {
    if (gone) onGone();
  }, [gone]);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={scroller}
        role="log"
        aria-label={t("assistant.messages")}
        aria-live="polite"
        aria-busy={chat.answering}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className={cn("mx-auto flex w-full flex-col gap-4", wide ? "max-w-[760px] px-4 py-6 sm:px-6" : "px-4 py-4")}>
          {chat.loading ? (
            <ConversationSkeleton />
          ) : chat.messages.length === 0 ? (
            <EmptyChat
              suggestions={suggestionsFor(place).map((key) => t(key))}
              wide={wide}
              disabled={chat.answering || access.budgetReached}
              onPick={(text) => void chat.send(text)}
            />
          ) : (
            chat.messages.map((message, index) => (
              <MessageView
                key={message.id}
                message={message}
                last={index === chat.messages.length - 1}
                chat={chat}
                waiting={chat.answering && index === chat.messages.length - 1 && message.role === "user"}
              />
            ))
          )}
          {chat.loadError && (
            <p role="alert" className="m-0 text-[13px] text-chip-red-fg">
              {chat.loadError.message}
            </p>
          )}
        </div>
      </div>
      <Composer chat={chat} wide={wide} autoMode={access.autoMode} budgetReached={access.budgetReached} />
    </div>
  );
}

/** Two exchanges while the chat loads. */
function ConversationSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <Skeleton className="ml-auto h-9 w-48 rounded-card" />
      <div className="flex flex-col gap-1.5">
        <SkeletonText className="w-[85%] text-[13.5px] leading-relaxed" />
        <SkeletonText className="w-[70%] text-[13.5px] leading-relaxed" />
        <Skeleton className="mt-1 h-11 w-full bg-raised" />
      </div>
      <Skeleton className="ml-auto h-9 w-36 rounded-card" />
      <SkeletonText className="w-[60%] text-[13.5px] leading-relaxed" />
    </div>
  );
}

function EmptyChat({
  suggestions,
  wide,
  disabled,
  onPick,
}: {
  suggestions: string[];
  wide: boolean;
  disabled: boolean;
  onPick(text: string): void;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-3 text-center", wide ? "pt-[12vh]" : "pt-6")}>
      <span className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <IconSparkles size={20} stroke={1.8} aria-hidden="true" />
      </span>
      <h2 className={cn("m-0 font-semibold text-foreground", wide ? "text-xl tracking-[-0.015em]" : "text-[15px]")}>
        {t("assistant.empty.title")}
      </h2>
      <p className="m-0 max-w-sm text-[13px] leading-relaxed text-muted-foreground">{t("assistant.empty.description")}</p>
      <ul aria-label={t("assistant.suggestions.title")} className="m-0 mt-2 flex list-none flex-wrap justify-center gap-2 p-0">
        {suggestions.map((text) => (
          <li key={text}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(text)}
              className="cursor-pointer rounded-full border-0 bg-muted px-3 py-1.5 text-[12.5px] text-ink-strong transition-interactive hover-enabled:bg-accent hover-enabled:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MessageView({ message, last, chat, waiting }: { message: Message; last: boolean; chat: Chat; waiting: boolean }) {
  if (message.role === "user") {
    const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
    return (
      <>
        <div className="flex justify-end">
          <p className="m-0 max-w-[85%] rounded-card rounded-br-chip bg-accent px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-accent-foreground [overflow-wrap:anywhere]">
            {text}
          </p>
        </div>
        {waiting && <Thinking />}
      </>
    );
  }
  const streaming = message.status === "streaming";
  const lastPart = message.parts.at(-1);
  // Something is going on but nothing shows it yet: no text so far, or a tool call just finished.
  const thinking = streaming && (!lastPart || (lastPart.type === "tool_call" && lastPart.status !== "running"));
  return (
    <div className="flex flex-col gap-2.5" aria-busy={streaming}>
      {message.parts.map((part, index) =>
        part.type === "text" ? (
          part.text.trim() ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts only ever grow at the end, so the index is the part
            <Markdown key={index} className="text-[13.5px]">
              {part.text}
            </Markdown>
          ) : null
        ) : (
          <ToolCallCard key={part.toolCallId} part={part} />
        ),
      )}
      {thinking && <Thinking />}
      {(message.status === "error" || message.status === "cancelled") && (
        <ReplyProblem message={message} canRetry={last} retrying={chat.retrying} onRetry={chat.retry} />
      )}
    </div>
  );
}

/** Three soft dots while the assistant works out its answer. */
function Thinking() {
  return (
    <div role="status" aria-label={t("assistant.thinking")} className="flex h-6 items-center gap-1 text-ink-faint">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </div>
  );
}

function ReplyProblem({
  message,
  canRetry,
  retrying,
  onRetry,
}: {
  message: Message;
  canRetry: boolean;
  retrying: boolean;
  onRetry(): void;
}) {
  const failed = message.status === "error";
  return (
    <div
      role={failed ? "alert" : undefined}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-control px-3 py-2 text-[12.5px]",
        failed ? "bg-chip-red-bg text-chip-red-fg" : "bg-muted text-muted-foreground",
      )}
    >
      {failed && <IconAlertTriangle size={14} stroke={1.9} aria-hidden="true" />}
      <span className="min-w-0 flex-1">{failed ? `${t("assistant.failed")}: ${message.error ?? ""}` : t("assistant.stopped")}</span>
      {canRetry && (
        <button
          type="button"
          disabled={retrying}
          onClick={onRetry}
          className="flex cursor-pointer items-center gap-1 rounded-chip border-0 bg-transparent px-1.5 py-0.5 font-medium text-current transition-interactive hover-enabled:bg-card/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconRefresh size={13} stroke={2} aria-hidden="true" className={cn(retrying && "animate-spin")} />
          {t("assistant.retry")}
        </button>
      )}
    </div>
  );
}

function Composer({ chat, wide, autoMode, budgetReached }: { chat: Chat; wide: boolean; autoMode: boolean; budgetReached: boolean }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const autoOff = useOpMutation(ai.setAutoMode, { onSuccess: () => void invalidateOps([ai.me]) });
  const canSend = text.trim() !== "" && !chat.answering && !budgetReached;

  // Grows with the text up to six lines, then scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the trigger
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = async () => {
    if (!canSend) return;
    const message = text.trim();
    setText("");
    const sent = await chat.send(message);
    // Refused: the text comes back, unless the person already typed something new.
    if (!sent) setText((current) => (current === "" ? message : current));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className={cn("mx-auto flex w-full flex-col gap-2", wide ? "max-w-[760px] px-4 pb-5 sm:px-6" : "px-3 pb-3")}>
      {budgetReached && (
        <p className="m-0 rounded-control bg-chip-amber-bg px-3 py-2 text-[12.5px] text-chip-amber-fg">{t("assistant.budget")}</p>
      )}
      {chat.sendError && (
        <p role="alert" className="m-0 rounded-control bg-chip-red-bg px-3 py-2 text-[12.5px] text-chip-red-fg">
          {t("assistant.sendFailed")}: {chat.sendError.message}
        </p>
      )}
      {autoMode && (
        <div className="flex items-center gap-2 rounded-control bg-chip-violet-bg px-3 py-1.5 text-[12.5px] text-chip-violet-fg">
          <IconBolt size={14} stroke={2} aria-hidden="true" />
          <span className="min-w-0 flex-1">{t("assistant.autoOn")}</span>
          <button
            type="button"
            disabled={autoOff.isPending}
            onClick={() => autoOff.mutate({ enabled: false })}
            className="cursor-pointer rounded-chip border-0 bg-transparent px-1.5 py-0.5 font-medium text-current underline-offset-2 transition-interactive hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("assistant.autoTurnOff")}
          </button>
        </div>
      )}
      <form
        className="flex items-end gap-2 rounded-card bg-field p-1.5 pl-3 transition-interactive focus-within:ring-3 focus-within:ring-ring/15"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={area}
          rows={1}
          value={text}
          aria-label={t("assistant.composer")}
          placeholder={chat.answering ? t("assistant.placeholderBusy") : t("assistant.placeholder")}
          title={t("assistant.enterHint")}
          maxLength={20_000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-40 min-h-[34px] flex-1 resize-none border-0 bg-transparent py-[7px] text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-ink-ghost"
        />
        {chat.answering ? (
          <button
            type="button"
            aria-label={t("assistant.stop")}
            onClick={chat.stop}
            className="flex size-[34px] shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-button-dark text-button-dark-foreground transition-interactive hover:opacity-90"
          >
            <IconPlayerStopFilled size={13} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label={t("assistant.send")}
            disabled={!canSend}
            className="flex size-[34px] shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-primary text-primary-foreground shadow-primary transition-interactive hover-enabled:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            <IconArrowUp size={17} stroke={2.2} aria-hidden="true" />
          </button>
        )}
      </form>
    </div>
  );
}
