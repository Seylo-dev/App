import { IconCheck, IconCopy } from "@tabler/icons-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { useCopy } from "./copy-field";
import { useUiLabels } from "./labels";

export interface CodeBlockProps {
  code: string;
  /** A small label in the top bar: a file name or language ("docker-compose.yml", "bash"). */
  title?: React.ReactNode;
  /** "light" on cards (default), "dark" for shell snippets. */
  tone?: "light" | "dark";
  /** Hide the copy button. */
  noCopy?: boolean;
  /**
   * Keep long lines whole and scroll sideways. Off by default: commands,
   * JSON an approval shows and process output wrap, so nothing sits off
   * screen on a phone.
   */
  noWrap?: boolean;
  className?: string;
  maxHeight?: number;
}

/**
 * Monospace code or config with a copy button. No syntax colors; use Monaco
 * for editing. With a title the copy button sits in the title bar; without
 * one it sits at the top right of the code, so a one-line command is not
 * a half-empty bar over a line of text: the first lines flow around a
 * same-sized gap in the code, and the button itself stays put outside the
 * scrolling code, so it is still there after scrolling a long block down.
 * Titles are labels in the sans font and wrap, never cut off ("SSH tunnel,
 * then open http://127.0.0.1:3000").
 */
export function CodeBlock({ code, title, tone = "light", noCopy = false, noWrap = false, className, maxHeight }: CodeBlockProps) {
  const labels = useUiLabels();
  const [copied, copy] = useCopy();
  const dark = tone === "dark";
  const face = (
    <>
      {copied ? <IconCheck size={14} stroke={2.2} /> : <IconCopy size={14} />}
      {copied ? labels.copied : labels.copy}
    </>
  );
  const shape = "flex h-7 shrink-0 items-center gap-1.5 rounded-chip border-0 px-2 font-sans text-[12px] leading-none";
  const copyButton = (
    <button
      type="button"
      onClick={() => void copy(code)}
      className={cn(
        shape,
        "cursor-pointer transition-interactive",
        // Over the code (no title) it keeps the block's fill, so scrolled code never shows through it.
        dark
          ? cn(title ? "bg-transparent" : "bg-terminal", "text-terminal-muted hover:bg-terminal-bar")
          : cn(title ? "bg-transparent" : "bg-raised", "text-ink-faint hover:bg-muted hover:text-foreground"),
        title ? "ml-auto" : "absolute top-[9px] right-1.5 z-10",
      )}
    >
      {face}
    </button>
  );
  return (
    <div
      data-slot="code-block"
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-control",
        dark ? "bg-terminal text-terminal-foreground" : "bg-raised text-foreground",
        className,
      )}
    >
      {title && (
        <div
          className={cn(
            "flex min-h-9 items-center gap-2 pr-1.5 pl-3.5 text-[12px]",
            dark ? "bg-terminal-bar text-terminal-muted" : "border-b border-divider text-muted-foreground",
          )}
        >
          <span className="min-w-0 py-2 leading-snug [overflow-wrap:anywhere]">{title}</span>
          {!noCopy && copyButton}
        </div>
      )}
      <pre
        className={cn(
          "m-0 overflow-auto px-3.5 pb-3 font-mono text-[12.5px] leading-[1.7]",
          !title && "pt-3",
          noWrap ? "whitespace-pre" : "whitespace-pre-wrap [overflow-wrap:anywhere]",
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {/* The room the button takes on the first lines: the same size, never read or clicked. */}
        {!title && !noCopy && (
          <span aria-hidden="true" className={cn(shape, "invisible float-right -mt-[3px] -mr-2 ml-2")}>
            {face}
          </span>
        )}
        <code>{code}</code>
      </pre>
      {!title && !noCopy && copyButton}
    </div>
  );
}

/**
 * A short command or value inside a sentence or a row (a cron command, one
 * SQL statement): a code chip that wraps instead of cutting the text off,
 * with a small copy button. Long or multi-line code goes in CodeBlock.
 */
export function CopyCode({ code, className, ...rest }: { code: string; "aria-label"?: string; className?: string }) {
  const labels = useUiLabels();
  const [copied, copy] = useCopy();
  return (
    <span
      data-slot="copy-code"
      className={cn("inline-flex max-w-full min-w-0 items-start gap-1 rounded-chip bg-field py-0.5 pr-0.5 pl-2 align-middle", className)}
    >
      <code className="min-w-0 py-0.5 font-mono text-xs leading-4 whitespace-pre-wrap [overflow-wrap:anywhere]">{code}</code>
      <button
        type="button"
        aria-label={rest["aria-label"] ? `${labels.copy}: ${rest["aria-label"]}` : labels.copy}
        onClick={() => void copy(code)}
        className={cn(
          "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-0 transition-interactive",
          copied ? "text-chip-green-fg" : "text-ink-faint hover:bg-muted hover:text-foreground",
        )}
      >
        {copied ? <IconCheck size={13} stroke={2.2} /> : <IconCopy size={13} />}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? labels.copied : ""}
      </span>
    </span>
  );
}
