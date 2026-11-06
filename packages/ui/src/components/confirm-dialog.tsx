import { AlertDialog } from "radix-ui";
import { type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { useUiLabels } from "./labels";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra content between the description and the buttons (a list of what goes away, a checkbox). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. */
  destructive?: boolean;
  /**
   * The text the user must type before confirming (a service or node name).
   * Use it for actions that cannot be undone.
   */
  confirmText?: string;
  /**
   * Runs on confirm. The dialog shows a busy button while a returned promise
   * is pending, closes when it resolves, and stays open showing the error's
   * message when it rejects.
   */
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  destructive = false,
  confirmText,
  onConfirm,
}: ConfirmDialogProps) {
  const labels = useUiLabels();
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const locked = confirmText !== undefined && typed.trim() !== confirmText;

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (locked || busy) return;
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-foreground/20 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <AlertDialog.Content
          data-slot="confirm-dialog"
          className={cn(
            "fixed top-[18%] left-1/2 z-50 w-[calc(100%-32px)] max-w-md -translate-x-1/2 rounded-card bg-popover p-5 text-popover-foreground shadow-popover outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <form onSubmit={run} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <AlertDialog.Title className="m-0 text-base font-semibold">{title}</AlertDialog.Title>
              {description && (
                <AlertDialog.Description className="m-0 text-[13px] leading-relaxed text-muted-foreground">
                  {description}
                </AlertDialog.Description>
              )}
            </div>
            {children}
            {confirmText !== undefined && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={inputId} className="text-[12.5px] text-ink-strong">
                  {labels.typeToConfirm.split("{value}").flatMap((part, i) =>
                    i === 0
                      ? [part]
                      : [
                          <b key="value" className="font-mono font-semibold text-foreground">
                            {confirmText}
                          </b>,
                          part,
                        ],
                  )}
                </label>
                <Input
                  id={inputId}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-[13px]"
                  autoFocus
                />
              </div>
            )}
            {error && (
              <p role="alert" className="m-0 rounded-control bg-chip-red-bg px-3 py-2 text-[12.5px] text-chip-red-fg">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button disabled={busy}>{cancelLabel ?? labels.cancel}</Button>
              </AlertDialog.Cancel>
              <Button type="submit" variant={destructive ? "destructive" : "primary"} disabled={locked || busy} aria-busy={busy}>
                {confirmLabel ?? labels.confirm}
              </Button>
            </div>
          </form>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
