// Toasts, sonner-style: call toast() from anywhere (see lib/toast-store),
// mount <Toaster /> once. Bottom right, newest at the bottom, auto-hide
// paused while the pointer is over the stack.

import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconInfoCircle, IconX } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { type ToastItem, type ToastStore, type ToastTone, toastStore } from "../lib/toast-store";
import { cn } from "../lib/utils";
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
  return (
    <section
      aria-label={labels.notifications}
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[calc(100%-32px)] max-w-[380px] flex-col gap-2"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      {items.map((item) => (
        <ToastCard key={item.id} item={item} paused={paused} onDismiss={() => store.dismiss(item.id)} dismissLabel={labels.dismiss} />
      ))}
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
  onDismiss: () => void;
  dismissLabel: string;
}) {
  // Remaining time survives pauses; a replaced toast (same id, new createdAt) starts over.
  const [remaining, setRemaining] = useState(item.duration);
  // biome-ignore lint/correctness/useExhaustiveDependencies: createdAt changes when the toast is replaced, which restarts the timer.
  useEffect(() => setRemaining(item.duration), [item.duration, item.createdAt]);
  useEffect(() => {
    if (paused || item.duration === 0) return;
    const started = Date.now();
    const timer = setTimeout(onDismiss, remaining);
    return () => {
      clearTimeout(timer);
      setRemaining((r) => Math.max(0, r - (Date.now() - started)));
    };
  }, [paused, remaining, item.duration, onDismiss]);

  return (
    <div
      role={item.tone === "error" ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex items-start gap-2.5 rounded-card bg-popover px-4 py-3 text-popover-foreground shadow-popover",
        "animate-in fade-in-0 slide-in-from-bottom-2",
      )}
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
            onDismiss();
          }}
          className="h-7 shrink-0 cursor-pointer rounded-chip border-0 bg-muted px-2.5 text-[12.5px] font-medium text-foreground hover:bg-track"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent text-ink-faint hover:bg-muted hover:text-foreground"
      >
        <IconX size={13} stroke={2.2} />
      </button>
    </div>
  );
}
