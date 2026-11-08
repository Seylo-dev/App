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

/** Monospace code or config with a copy button. No syntax colors; use Monaco for editing. */
export function CodeBlock({ code, title, tone = "light", noCopy = false, noWrap = false, className, maxHeight }: CodeBlockProps) {
  const labels = useUiLabels();
  const [copied, copy] = useCopy();
  const dark = tone === "dark";
  return (
    <div
      data-slot="code-block"
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-control",
        dark ? "bg-terminal text-terminal-foreground" : "bg-raised text-foreground",
        className,
      )}
    >
      {(title || !noCopy) && (
        <div
          className={cn(
            "flex min-h-9 items-center gap-2 pr-1.5 pl-3.5 text-[12px]",
            dark ? "bg-terminal-bar text-terminal-muted" : "text-muted-foreground",
            title && !dark && "border-b border-divider",
          )}
        >
          {title && <span className="truncate font-mono">{title}</span>}
          {!noCopy && (
            <button
              type="button"
              onClick={() => void copy(code)}
              className={cn(
                "ml-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-chip border-0 bg-transparent px-2 text-[12px] transition-interactive",
                dark ? "text-terminal-muted hover:bg-terminal" : "text-ink-faint hover:bg-muted hover:text-foreground",
              )}
            >
              {copied ? <IconCheck size={14} stroke={2.2} /> : <IconCopy size={14} />}
              {copied ? labels.copied : labels.copy}
            </button>
          )}
        </div>
      )}
      <pre
        className={cn(
          "m-0 overflow-auto px-3.5 pb-3 font-mono text-[12.5px] leading-[1.7]",
          !title && noCopy && "pt-3",
          noWrap ? "whitespace-pre" : "whitespace-pre-wrap [overflow-wrap:anywhere]",
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
