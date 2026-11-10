// The assistant's chat bubble on every signed-in page but the Assistant
// page: a small round button bottom right, shown while the assistant is
// there for this person (ai.me), that opens a compact chat panel above it
// (a full-screen sheet on a phone). Open or closed and the current chat
// survive navigation (assistant-context.tsx). The shell keeps room under
// the page for the button (AppLayout's padding) and lifts the toasts
// above it, so it never sits on a page's own buttons. A dot says a chat
// waits for an approval or is answering.

import { ai } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconSparkles, IconX } from "@tabler/icons-react";
import { AnimatePresence, m, useReducedMotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useId } from "react";
import { t } from "../../i18n/t";
import { useAssistant, useBubbleShown } from "./assistant-context";

const ChatPanel = lazy(() => import("./chat-panel"));

/** Room the bubble takes in the bottom right corner (its size plus the gap), for the toasts. */
const bubbleRoom = "60px";

export function AssistantBubble() {
  const shown = useBubbleShown();
  const assistant = useAssistant();
  const reduced = useReducedMotionConfig();
  const titleId = useId();
  const open = shown && assistant.open;
  // One list for the dot; the chats menu reads the same cache entry.
  const chats = useOp(ai.conversations, { limit: 20 }, { enabled: shown && !open });
  const attention = (chats.data?.conversations ?? []).some((c) => c.pendingApprovals > 0 || c.streaming);

  useEffect(() => {
    if (!shown) return undefined;
    document.documentElement.style.setProperty("--toast-lift", bubbleRoom);
    return () => {
      document.documentElement.style.removeProperty("--toast-lift");
    };
  }, [shown]);

  // Escape closes the chat (unless a menu or dialog inside it took the key first).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && document.activeElement?.closest("[data-assistant-panel]")) {
        assistant.setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, assistant]);

  if (!shown) return null;
  return (
    <>
      <AnimatePresence>
        {open && (
          <m.section
            key="assistant-panel"
            data-assistant-panel=""
            role="dialog"
            aria-modal="false"
            aria-labelledby={titleId}
            initial={reduced ? false : { opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? undefined : { opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.15, ease: "easeIn" } }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            style={{ transformOrigin: "bottom right" }}
            className={cn(
              "fixed z-40 flex flex-col overflow-hidden bg-popover text-popover-foreground shadow-popover",
              // A phone: the whole screen. Larger: a panel above the button.
              "inset-0 max-sm:pb-[env(safe-area-inset-bottom)]",
              "sm:inset-auto sm:right-6 sm:bottom-[88px] sm:h-[min(640px,calc(100dvh-120px))] sm:w-[400px] sm:rounded-card",
            )}
          >
            <Suspense fallback={<PanelSkeleton />}>
              <ChatPanel titleId={titleId} />
            </Suspense>
          </m.section>
        )}
      </AnimatePresence>
      <button
        type="button"
        aria-label={open ? t("assistant.close") : t("assistant.open")}
        aria-expanded={open}
        onClick={() => assistant.setOpen(!open)}
        className={cn(
          "fixed right-4 bottom-4 z-40 flex size-12 cursor-pointer items-center justify-center rounded-full border-0 bg-primary text-primary-foreground shadow-primary transition-interactive hover:brightness-110 sm:right-6 sm:bottom-6",
          // On a phone the open chat covers the screen and has its own close button.
          open && "max-sm:hidden",
        )}
      >
        {open ? <IconX size={20} stroke={2} aria-hidden="true" /> : <IconSparkles size={21} stroke={1.8} aria-hidden="true" />}
        {!open && attention && (
          <span aria-hidden="true" className="absolute top-0.5 right-0.5 size-3 rounded-full border-2 border-background bg-status-busy" />
        )}
      </button>
    </>
  );
}

/** The panel's header and an empty chat while its code loads. */
function PanelSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-divider px-3 py-3">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="ml-auto h-4 w-16" />
        <Skeleton className="size-6" />
      </div>
      <div className="flex flex-1 flex-col items-center gap-3 pt-16">
        <Skeleton className="size-11 rounded-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-56" />
      </div>
      <Skeleton className="m-3 h-[46px] rounded-card" />
    </div>
  );
}
