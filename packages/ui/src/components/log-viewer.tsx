// The log viewer for service logs, build logs, node logs and the deploy
// modal. Lines live in a LogBuffer (a ring outside React); the viewer
// re-renders at most once per animation frame and only draws the rows in
// view, so 10,000 lines or a fast build stays smooth. Rows have a fixed
// height and never wrap; long lines scroll sideways.

import { IconArrowBarToDown, IconChevronDown, IconChevronUp, IconSearch } from "@tabler/icons-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type HighlightedSegment, highlight } from "../lib/ansi";
import { LogBuffer, type LogLine, visibleRange } from "../lib/log-buffer";
import { cn } from "../lib/utils";
import { fill, useUiLabels } from "./labels";

export { LogBuffer, type LogLevel, type LogLine, type LogLineInput } from "../lib/log-buffer";

/** A LogBuffer that lives as long as the component. */
export function useLogBuffer(capacity = 10_000): LogBuffer {
  const [buffer] = useState(() => new LogBuffer(capacity));
  return buffer;
}

export interface LogViewerProps {
  buffer: LogBuffer;
  /** Accessible name of the log region, for example "Build log". */
  "aria-label": string;
  /** Left side of the top bar (a title, a Console/Shell switch). */
  title?: ReactNode;
  /** Extra buttons on the right of the top bar (pause, download, clear). */
  actions?: ReactNode;
  /** Show the top bar with search and follow. Default true. */
  toolbar?: boolean;
  showTimestamps?: boolean;
  formatTime?: (ts: number) => string;
  /** Show each line's source tag in a narrow column. */
  showSource?: boolean;
  /** Shown while the buffer is empty. */
  empty?: ReactNode;
  /** Start following the newest line. Default true. */
  initialFollow?: boolean;
  rowHeight?: number;
  className?: string;
  /** Height of the scroll area; the viewer fills its parent when omitted (give the parent a height). */
  height?: number | string;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const levelColor: Record<string, string | undefined> = {
  error: "var(--ansi-1)",
  warn: "var(--ansi-3)",
  system: "var(--terminal-muted)",
};

export function LogViewer({
  buffer,
  title,
  actions,
  toolbar = true,
  showTimestamps = false,
  formatTime = (ts) => timeFormat.format(ts),
  showSource = false,
  empty,
  initialFollow = true,
  rowHeight = 22,
  className,
  height,
  ...rest
}: LogViewerProps) {
  const labels = useUiLabels();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const [follow, setFollow] = useState(initialFollow);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const programmatic = useRef<number | null>(null);
  const firstSeq = useRef(buffer.firstSeq);

  // One render per animation frame, whatever the push rate.
  useEffect(() => buffer.subscribe(() => setTick((n) => n + 1)), [buffer]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const count = buffer.length;
  const version = buffer.version;

  // Keep the view still or pinned to the end after each flush.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dropped = buffer.firstSeq - firstSeq.current;
    firstSeq.current = buffer.firstSeq;
    if (follow) {
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(el.scrollTop - target) > 1) {
        programmatic.current = target;
        el.scrollTop = target;
        setScrollTop(target);
      }
    } else if (dropped > 0 && el.scrollTop > 0) {
      // Old lines fell off the ring: move up with the content so the reader's line stays put.
      const target = Math.max(0, el.scrollTop - dropped * rowHeight);
      programmatic.current = target;
      el.scrollTop = target;
      setScrollTop(target);
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: version changes whenever lines arrive, so matches follow new output.
  const matches = useMemo(() => (query ? buffer.search(query) : []), [buffer, query, version]);
  const currentLine = matches.length ? matches[Math.min(current, matches.length - 1)] : undefined;

  function scrollToLine(index: number) {
    const el = scrollRef.current;
    if (!el) return;
    setFollow(false);
    const target = Math.max(0, index * rowHeight - el.clientHeight / 2 + rowHeight / 2);
    programmatic.current = target;
    el.scrollTop = target;
    setScrollTop(target);
  }

  function step(dir: 1 | -1) {
    if (!matches.length) return;
    const next = (Math.min(current, matches.length - 1) + dir + matches.length) % matches.length;
    setCurrent(next);
    scrollToLine(matches[next] as number);
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (programmatic.current !== null && Math.abs(el.scrollTop - programmatic.current) < 2) {
      programmatic.current = null;
      return;
    }
    programmatic.current = null;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight;
    if (follow && !atBottom) setFollow(false);
    else if (!follow && atBottom) setFollow(true);
  }

  const [start, end] = visibleRange({ scrollTop, viewport, rowHeight, count });
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const line = buffer.at(i);
    if (!line) continue;
    rows.push(
      <LogRow
        key={line.seq}
        line={line}
        segments={highlight(buffer.segments(line), query)}
        current={i === currentLine}
        rowHeight={rowHeight}
        showTimestamps={showTimestamps}
        showSource={showSource}
        formatTime={formatTime}
      />,
    );
  }

  return (
    <section
      data-slot="log-viewer"
      aria-label={rest["aria-label"]}
      className={cn("relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-card bg-terminal text-terminal-foreground", className)}
      style={height !== undefined ? { height } : undefined}
    >
      {toolbar && (
        <div className="flex flex-wrap items-center gap-2 bg-terminal-bar px-2.5 py-2">
          {title && <div className="flex min-w-0 items-center gap-2 pl-1 text-[13px] font-medium">{title}</div>}
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
            <label className="flex h-[30px] items-center gap-1.5 rounded-chip bg-terminal-field px-2 text-terminal-muted focus-within:text-terminal-foreground">
              <IconSearch size={14} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCurrent(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    step(e.shiftKey ? -1 : 1);
                  } else if (e.key === "Escape") setQuery("");
                }}
                placeholder={labels.searchOutput}
                aria-label={labels.searchOutput}
                className="w-36 min-w-0 border-0 bg-transparent p-0 text-[12.5px] text-terminal-foreground outline-none placeholder:text-terminal-muted [&::-webkit-search-cancel-button]:hidden"
              />
            </label>
            {query && (
              <>
                <span aria-live="polite" className="px-1 text-[12px] whitespace-nowrap text-terminal-muted tabular-nums">
                  {fill(labels.matches, { count: matches.length })}
                </span>
                <BarButton label={labels.previousMatch} onClick={() => step(-1)} disabled={!matches.length}>
                  <IconChevronUp size={15} />
                </BarButton>
                <BarButton label={labels.nextMatch} onClick={() => step(1)} disabled={!matches.length}>
                  <IconChevronDown size={15} />
                </BarButton>
              </>
            )}
            <BarButton label={labels.followOutput} pressed={follow} onClick={() => setFollow((f) => !f)}>
              <IconArrowBarToDown size={15} />
            </BarButton>
            {actions}
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll area must be keyboard scrollable.
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto py-2 font-mono text-[12.5px] outline-none [scrollbar-color:var(--terminal-field)_transparent] [scrollbar-width:thin]"
      >
        {count === 0 ? (
          <div className="flex h-full min-h-24 items-center justify-center font-sans text-[13px] text-terminal-muted">
            {empty ?? labels.noOutput}
          </div>
        ) : (
          <div style={{ height: count * rowHeight, position: "relative" }}>
            <div className="w-max min-w-full" style={{ transform: `translateY(${start * rowHeight}px)` }}>
              {rows}
            </div>
          </div>
        )}
      </div>
      {!follow && count > 0 && (
        <button
          type="button"
          onClick={() => setFollow(true)}
          className="absolute right-4 bottom-4 flex h-8 cursor-pointer items-center gap-1.5 rounded-control border-0 bg-primary px-3 text-[12.5px] font-medium text-primary-foreground shadow-primary transition-interactive animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out hover:brightness-110"
        >
          <IconArrowBarToDown size={14} />
          {labels.jumpToLatest}
        </button>
      )}
    </section>
  );
}

function BarButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-[30px] cursor-pointer items-center justify-center rounded-chip border-0 bg-transparent text-terminal-muted transition-interactive hover:text-terminal-foreground disabled:opacity-40",
        pressed && "bg-terminal-field text-terminal-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LogRow({
  line,
  segments,
  current,
  rowHeight,
  showTimestamps,
  showSource,
  formatTime,
}: {
  line: LogLine;
  segments: HighlightedSegment[];
  current: boolean;
  rowHeight: number;
  showTimestamps: boolean;
  showSource: boolean;
  formatTime: (ts: number) => string;
}) {
  const base = line.level ? levelColor[line.level] : undefined;
  // Each segment's start offset in the line: a stable, unique key.
  const offsets: number[] = [];
  let at = 0;
  for (const s of segments) {
    offsets.push(at);
    at += s.text.length;
  }
  return (
    <div
      className={cn("flex gap-3.5 px-4 whitespace-pre", current && "bg-terminal-bar")}
      style={{ height: rowHeight, lineHeight: `${rowHeight}px`, color: base }}
    >
      {showTimestamps && (
        <span className="shrink-0 text-terminal-muted select-none">{line.ts === undefined ? "" : formatTime(line.ts)}</span>
      )}
      {showSource && <span className="w-[52px] shrink-0 truncate text-terminal-prompt select-none">{line.source ?? ""}</span>}
      <span>
        {segments.map((s, i) => (
          <span
            key={offsets[i]}
            style={segmentStyle(s)}
            className={s.match ? (current ? "rounded-[2px] bg-terminal-match-current" : "rounded-[2px] bg-terminal-match") : undefined}
          >
            {s.text}
          </span>
        ))}
      </span>
    </div>
  );
}

function segmentStyle(s: HighlightedSegment): CSSProperties | undefined {
  if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline) return undefined;
  return {
    color: s.fg,
    background: s.match ? undefined : s.bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.65 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: s.underline ? "underline" : undefined,
  };
}
