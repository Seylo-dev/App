// xterm.js as a React component, for the Console, Shell and database
// shells. Output is batched: chunks queue up and go to xterm once per
// animation frame, so a flood of output is one write per frame instead of
// thousands. Colors come from the terminal and ANSI tokens of the theme.

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@seylo/ui/lib/utils";
import { useEffect, useRef } from "react";
import { WriteBatcher } from "./write-batcher";

export interface XtermHandle {
  write(data: Uint8Array | string): void;
  /** A muted line from the panel itself ("Connected to ..."). */
  note(text: string): void;
  clear(): void;
  focus(): void;
  findNext(query: string): boolean;
  findPrevious(query: string): boolean;
  clearSearch(): void;
  /** Every line in the scrollback as plain text. */
  text(): string;
  size(): { columns: number; rows: number };
  /** Holds output while paused; resume writes what arrived meanwhile. */
  setPaused(paused: boolean): void;
}

export interface XtermViewProps {
  /** Keystrokes (shells). Leave out for read-only output. */
  onData?: (data: string) => void;
  onResize?: (size: { columns: number; rows: number }) => void;
  onReady?: (handle: XtermHandle) => void;
  scrollback?: number;
  className?: string;
  "aria-label": string;
}

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

/** xterm theme from the page's tokens, so every preset gets matching terminal colors. */
export function themeFromCss(): ITheme {
  const s = getComputedStyle(document.documentElement);
  const ansi = (i: number, f: string) => cssVar(s, `--ansi-${i}`, f);
  return {
    background: cssVar(s, "--terminal", "#0b1020"),
    foreground: cssVar(s, "--terminal-foreground", "#d6dce8"),
    cursor: cssVar(s, "--terminal-foreground", "#d6dce8"),
    selectionBackground: "rgba(138, 164, 255, 0.3)",
    black: ansi(0, "#3b4252"),
    red: ansi(1, "#ff7b72"),
    green: ansi(2, "#5fd394"),
    yellow: ansi(3, "#f5b85a"),
    blue: ansi(4, "#7aa2ff"),
    magenta: ansi(5, "#c3a6ff"),
    cyan: ansi(6, "#5ccfe6"),
    white: ansi(7, "#d6dce8"),
    brightBlack: ansi(8, "#6b7586"),
    brightRed: ansi(9, "#ffa198"),
    brightGreen: ansi(10, "#8ee6b3"),
    brightYellow: ansi(11, "#ffd38a"),
    brightBlue: ansi(12, "#a5c0ff"),
    brightMagenta: ansi(13, "#dcc8ff"),
    brightCyan: ansi(14, "#9ae8f5"),
    brightWhite: ansi(15, "#ffffff"),
  };
}

export function XtermView({ onData, onResize, onReady, scrollback = 10_000, className, ...rest }: XtermViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ onData, onResize, onReady });
  latest.current = { onData, onResize, onReady };
  const readOnly = !onData;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the terminal lives as long as the component; callbacks are read from the ref.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace",
      fontSize: 12.5,
      lineHeight: 1.45,
      scrollback,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      cursorStyle: readOnly ? "underline" : "block",
      cursorInactiveStyle: "none",
      convertEol: readOnly,
      allowProposedApi: true,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(el);
    const batcher = new WriteBatcher((chunk) => term.write(chunk));
    const doFit = () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet (hidden tab); the next resize fits.
      }
    };
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(el);
    const dataSub = term.onData((d) => latest.current.onData?.(d));
    const resizeSub = term.onResize(({ cols, rows }) => latest.current.onResize?.({ columns: cols, rows }));
    const decorations = {
      matchBackground: "#f5b85a59",
      activeMatchBackground: "#f5b85ab3",
      matchOverviewRuler: "#f5b85a",
      activeMatchColorOverviewRuler: "#f5b85a",
    };
    const handle: XtermHandle = {
      write: (data) => batcher.push(data),
      note: (text) => batcher.push(`\x1b[2m${text}\x1b[0m\r\n`),
      clear: () => {
        batcher.drop();
        term.clear();
      },
      focus: () => term.focus(),
      findNext: (q) => search.findNext(q, { decorations }),
      findPrevious: (q) => search.findPrevious(q, { decorations }),
      clearSearch: () => search.clearDecorations(),
      text: () => {
        const buffer = term.buffer.active;
        const out: string[] = [];
        for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? "");
        while (out.length && out[out.length - 1] === "") out.pop();
        return out.join("\n");
      },
      size: () => ({ columns: term.cols, rows: term.rows }),
      setPaused: (paused) => batcher.setPaused(paused),
    };
    latest.current.onReady?.(handle);
    return () => {
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      batcher.dispose();
      term.dispose();
    };
  }, []);

  return <div ref={host} role="application" aria-label={rest["aria-label"]} className={cn("min-h-0 min-w-0", className)} />;
}
