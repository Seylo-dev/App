// The toast queue, outside React so any code (an op mutation's onError, a
// live event handler) can call toast() without a hook. <Toaster> renders it.

import type { ReactNode } from "react";

export type ToastTone = "neutral" | "success" | "error" | "warning" | "info";

export interface ToastOptions {
  description?: ReactNode;
  tone?: ToastTone;
  /** Milliseconds before it hides; 0 keeps it until dismissed. Default 5000 (errors 8000). */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Reuse an id to replace a toast in place (for example "Deploying" -> "Deployed"). */
  id?: string;
}

export interface ToastItem extends Required<Pick<ToastOptions, "tone" | "duration">> {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ToastOptions["action"];
  createdAt: number;
}

const MAX_VISIBLE = 5;

export class ToastStore {
  private items: ToastItem[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;

  show(title: ReactNode, opts: ToastOptions = {}): string {
    const tone = opts.tone ?? "neutral";
    const id = opts.id ?? `t${++this.seq}`;
    const item: ToastItem = {
      id,
      title,
      description: opts.description,
      action: opts.action,
      tone,
      duration: opts.duration ?? (tone === "error" ? 8000 : 5000),
      createdAt: Date.now(),
    };
    const at = this.items.findIndex((t) => t.id === id);
    if (at >= 0) this.items = this.items.map((t, i) => (i === at ? item : t));
    else this.items = [...this.items, item].slice(-MAX_VISIBLE);
    this.emit();
    return id;
  }

  dismiss(id?: string): void {
    this.items = id === undefined ? [] : this.items.filter((t) => t.id !== id);
    this.emit();
  }

  getSnapshot = (): readonly ToastItem[] => this.items;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const toastStore = new ToastStore();

type ToastFn = ((title: ReactNode, opts?: ToastOptions) => string) & {
  success: (title: ReactNode, opts?: Omit<ToastOptions, "tone">) => string;
  error: (title: ReactNode, opts?: Omit<ToastOptions, "tone">) => string;
  warning: (title: ReactNode, opts?: Omit<ToastOptions, "tone">) => string;
  info: (title: ReactNode, opts?: Omit<ToastOptions, "tone">) => string;
  dismiss: (id?: string) => void;
};

/** Shows a toast: toast("Saved"), toast.error("Deploy failed", { description }). Returns its id. */
export const toast: ToastFn = Object.assign((title: ReactNode, opts?: ToastOptions) => toastStore.show(title, opts), {
  success: (title: ReactNode, opts?: Omit<ToastOptions, "tone">) => toastStore.show(title, { ...opts, tone: "success" }),
  error: (title: ReactNode, opts?: Omit<ToastOptions, "tone">) => toastStore.show(title, { ...opts, tone: "error" }),
  warning: (title: ReactNode, opts?: Omit<ToastOptions, "tone">) => toastStore.show(title, { ...opts, tone: "warning" }),
  info: (title: ReactNode, opts?: Omit<ToastOptions, "tone">) => toastStore.show(title, { ...opts, tone: "info" }),
  dismiss: (id?: string) => toastStore.dismiss(id),
});
