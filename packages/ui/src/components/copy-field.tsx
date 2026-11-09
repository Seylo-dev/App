import { IconCheck, IconCopy, IconEye, IconEyeOff } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { useUiLabels } from "./labels";

/** Copies text, falling back to a hidden textarea where the async clipboard is missing (plain HTTP on an IP:port). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** true for `ms` after copy() succeeds; drives the "Copied" check mark. */
export function useCopy(ms = 1500): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    copied,
    async (text: string) => {
      if (!(await copyText(text))) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), ms);
    },
  ];
}

export interface CopyFieldProps {
  value: string;
  /** Accessible name, for example "Connection URL". */
  "aria-label"?: string;
  /** Mask the value (passwords, tokens) until the eye button is pressed. Copy still copies the real value. */
  secret?: boolean;
  /** What a secret shows while hidden, for example a URL with only its password as dots. Default: all dots. */
  masked?: string;
  /** Text before the value, for example "$" for a command. */
  prefix?: string;
  mono?: boolean;
  /** "card" on a page or card (default), "terminal" for dark install commands. */
  tone?: "card" | "terminal";
  className?: string;
}

/**
 * A read-only value that copies itself when clicked, or with Enter or Space
 * on the keyboard (install commands, connection URLs, API keys). A click
 * anywhere on the field copies, the copy icon included (it used to be
 * decoration, so clicking it did nothing); only the eye button of a secret
 * does something else. The text stays selectable.
 * Focus alone never copies: tabbing across a page must not put its secrets
 * on the clipboard. Keyboard focus on the value rings the whole field, the
 * same 2px ring the kit's :focus-visible draws around a button.
 * A long value (a join command, an invite link) wraps onto more lines
 * instead of ending in an ellipsis, so people can read what they paste; the
 * copy and eye buttons stay on the first line.
 */
export function CopyField({ value, secret = false, masked, prefix, mono = true, tone = "card", className, ...rest }: CopyFieldProps) {
  const labels = useUiLabels();
  const [copied, copy] = useCopy();
  const [revealed, setRevealed] = useState(false);
  const shown = secret && !revealed ? (masked ?? "•".repeat(Math.min(Math.max(value.length, 8), 24))) : value;
  const dark = tone === "terminal";

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the value button inside is the keyboard path; its click bubbles here.
    // biome-ignore lint/a11y/noStaticElementInteractions: same: the field only widens the value button's click area.
    <div
      data-slot="copy-field"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-slot=copy-field-reveal]")) return;
        void copy(value);
      }}
      className={cn(
        "group relative flex min-h-[38px] min-w-0 cursor-pointer items-start gap-1 rounded-control pr-1 pl-3 text-[13px]",
        "has-[[data-slot=copy-field-value]:focus-visible]:outline-2 has-[[data-slot=copy-field-value]:focus-visible]:outline-offset-2 has-[[data-slot=copy-field-value]:focus-visible]:outline-ring",
        dark ? "bg-terminal text-terminal-foreground" : "bg-field text-foreground shadow-[inset_0_0_0_1px_var(--input)]",
        className,
      )}
    >
      {prefix && (
        <span className={cn("shrink-0 select-none py-[9px] font-mono leading-5", dark ? "text-terminal-prompt" : "text-ink-faint")}>
          {prefix}
        </span>
      )}
      <button
        type="button"
        data-slot="copy-field-value"
        aria-label={rest["aria-label"] ? `${labels.copy}: ${rest["aria-label"]}` : labels.copy}
        className={cn(
          "min-w-0 flex-1 cursor-pointer border-0 bg-transparent px-0 py-[9px] text-left text-inherit leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] outline-none select-text",
          mono && "font-mono text-[12.5px]",
        )}
      >
        {shown}
      </button>
      {secret && (
        <button
          type="button"
          data-slot="copy-field-reveal"
          aria-label={revealed ? labels.hide : labels.show}
          aria-pressed={revealed}
          onClick={() => setRevealed((r) => !r)}
          className={cn(
            "mt-1 flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent transition-interactive",
            dark ? "text-terminal-muted hover:bg-terminal-bar" : "text-ink-faint hover:bg-muted hover:text-foreground",
          )}
        >
          {revealed ? <IconEyeOff size={15} /> : <IconEye size={15} />}
        </button>
      )}
      <span
        aria-live="polite"
        className={cn(
          "mt-1 flex h-[30px] shrink-0 items-center gap-1 rounded-chip px-2 text-[12px] font-medium",
          copied ? (dark ? "text-ansi-green" : "text-chip-green-fg") : dark ? "text-terminal-muted" : "text-ink-faint",
        )}
      >
        {copied ? <IconCheck size={15} stroke={2.2} /> : <IconCopy size={15} />}
        <span className={copied ? "" : "sr-only"}>{copied ? labels.copied : ""}</span>
      </span>
    </div>
  );
}
