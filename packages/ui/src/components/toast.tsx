// Toasts, sonner-style: call toast() from anywhere (see lib/toast-store),
// mount <Toaster /> once. Bottom right, newest at the bottom, auto-hide
// paused while the pointer is over the stack. An app that keeps something
// fixed in that corner (the assistant's chat bubble) sets --toast-lift on
// the root, and the stack sits that much higher.

import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconInfoCircle, IconX } from "@tabler/icons-react";
import { AnimatePresence, m, useReducedMotionConfig } from "motion/react";
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type ToastItem, type ToastStore, type ToastTone, toastStore } from "../lib/toast-store";
import { useUiLabels } from "./labels";

export { type ToastOptions, type ToastTone, toast, toastStore } from "../lib/toast-store";

const icons: Record<ToastTone, ReactNode> = {
  neutral: null,
  success: <IconCircleCheck size={17} className="text-status-ok" />,
  error: <IconCircleX size={17} className="text-status-error" />,
  warning: <IconAlertTriangle size={17} className="text-status-busy" />,
  info: <IconInfoCircle size={17} className="text-primary" />,
};

export function Toaster({ store = toastStore }: { store?: ToastStore }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [paused, setPaused] = useState(false);
  const labels = useUiLabels();
  // One function for every render: a card restarts its timer when onDismiss changes.
  const dismiss = useCallback((id: string) => store.dismiss(id), [store]);
  return (
    <section
      aria-label={labels.notifications}
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-[calc(16px+var(--toast-lift,0px))] z-[60] flex w-[calc(100%-32px)] max-w-[380px] flex-col gap-2"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <ToastCard key={item.id} item={item} paused={paused} onDismiss={dismiss} dismissLabel={labels.dismiss} />
        ))}
      </AnimatePresence>
    </section>
  );
}

function ToastCard({
  item,
  paused,
  onDismiss,
  dismissLabel,
}: {
  item: ToastItem;
  paused: boolean;
  onDismiss: (id: string) => void;
  dismissLabel: string;
}) {
  // The time left survives pauses. A ref, not state: the timer's cleanup
  // writes it, and as state it re-ran this effect from its own cleanup, a
  // render loop for as long as each render took a millisecond or more.
  const left = useRef({ createdAt: item.createdAt, ms: item.duration });
  useEffect(() => {
    // A replaced toast (same id, new createdAt) starts over.
    if (left.current.createdAt !== item.createdAt) left.current = { createdAt: item.createdAt, ms: item.duration };
    if (paused || item.duration === 0) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(item.id), left.current.ms);
    return () => {
      clearTimeout(timer);
      left.current.ms = Math.max(0, left.current.ms - (Date.now() - started));
    };
  }, [paused, item.id, item.createdAt, item.duration, onDismiss]);
  const reduced = useReducedMotionConfig();

  // Rises in from the bottom, fades and shrinks away; the rest of the stack slides into place (layout).
  return (
    <m.div
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? undefined : { opacity: 0, scale: 0.96, transition: { duration: 0.15, ease: "easeIn" } }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      role={item.tone === "error" ? "alert" : "status"}
      className="pointer-events-auto flex items-start gap-2.5 rounded-card bg-popover px-4 py-3 text-popover-foreground shadow-popover"
    >
      {icons[item.tone] && <span className="mt-px flex">{icons[item.tone]}</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium">{item.title}</span>
        {item.description && <span className="text-[12.5px] text-muted-foreground">{item.description}</span>}
      </div>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action?.onClick();
            onDismiss(item.id);
          }}
          className="h-7 shrink-0 cursor-pointer rounded-chip border-0 bg-muted px-2.5 text-[12.5px] font-medium text-foreground transition-interactive hover:bg-track"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={() => onDismiss(item.id)}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent text-ink-faint transition-interactive hover:bg-muted hover:text-foreground"
      >
        <IconX size={13} stroke={2.2} />
      </button>
    </m.div>
  );
}
