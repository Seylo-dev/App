// Smooth line and area charts in the dashboard's style: Catmull-Rom curves
// with light fills, a quiet grid, lines that draw in once, series that can
// be hidden from a legend, and a hover tooltip with every visible value.
// Plain SVG, no chart library: the curve math is in lib/smooth-path.
//
// With `window` the x axis is time (live graphs): each series has its own
// times, the plot shows the last spanMs and, with `follow`, keeps sliding
// left at real speed between renders. The lines sit in a wider layer that
// a compositor animation moves (no work per frame on the main thread); a
// render with new points starts it again from where the old one was, so
// the line scrolls without jumps. Reduced motion: no sliding, each render
// shows the window up to now.

import { useReducedMotionConfig } from "motion/react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { niceDomain, smoothAreaPath, smoothPath, stickyNiceMax, toSegments, toTimeSegments } from "../lib/smooth-path";
import { cn } from "../lib/utils";
import { useUiLabels } from "./labels";

export interface ChartSeries {
  id: string;
  label: string;
  values: readonly (number | null)[];
  /** With `window`: when each value was taken, Unix ms, ascending, one per value. */
  times?: readonly number[];
  /** Any CSS color; defaults to the --chart-N token by position. */
  color?: string;
}

export function seriesColor(series: ChartSeries, index: number): string {
  return series.color ?? `var(--chart-${(index % 5) + 1})`;
}

/** A sliding time window (live graphs). */
export interface ChartWindow {
  /** Unix ms of this render, usually Date.now(). */
  now: number;
  /** How much time the plot shows. */
  spanMs: number;
  /**
   * How far behind `now` the right edge runs while following, so a new
   * point slides in from the right instead of popping in at the edge
   * (about one and a half sample intervals). Ignored with reduced motion.
   */
  lagMs?: number;
  /** Keep sliding at real speed until the next render. Off with reduced motion. */
  follow?: boolean;
  /** Points further apart than this are not joined (a node that was away). */
  maxGapMs?: number;
}

/** How long one follow animation runs: longer than any wait for the next render. */
const followMs = 10_000;

const W = 300;
const H = 100;

export interface SmoothChartProps {
  series: readonly ChartSeries[];
  /** Accessible description, for example "CPU per node, last hour". */
  "aria-label": string;
  /** One label per point, shown in the tooltip (times, dates). */
  labels?: readonly string[];
  /** Pixel height of the plot. Default 120. */
  height?: number;
  /**
   * Fixed y range; otherwise fitted to the visible series (min 0 for
   * non-negative data). With `window` an unset max is a nice round number
   * that changes only when the data outgrows it or shrinks well below it.
   */
  min?: number;
  max?: number;
  /** Fill under each line. Default true. */
  area?: boolean;
  /** Horizontal grid lines inside the plot. Default 3. */
  gridLines?: number;
  /** Series ids to hide. Pair with ChartLegend, or set legend to render one under the chart. */
  hidden?: ReadonlySet<string>;
  onHiddenChange?: (hidden: Set<string>) => void;
  /** Render toggle chips under the chart (uncontrolled unless hidden is passed). */
  legend?: boolean;
  formatValue?: (value: number, series: ChartSeries) => ReactNode;
  /** Draw the lines in on mount. Default true (not with `window`). */
  animate?: boolean;
  /** A time axis that slides (see ChartWindow); each series needs `times`. */
  window?: ChartWindow;
  /** The tooltip's label for a hovered time, with `window`. */
  formatTime?: (t: number) => string;
  className?: string;
}

/** Index of the time in a sorted list closest to t (-1 for an empty list). */
function nearest(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  const before = lo - 1;
  return before >= 0 && t - (times[before] as number) < (times[lo] as number) - t ? before : lo;
}

export function SmoothChart({
  series,
  labels,
  height = 120,
  min,
  max,
  area = true,
  gridLines = 3,
  hidden: hiddenProp,
  onHiddenChange,
  legend = false,
  formatValue = (v) => (Math.round(v * 10) / 10).toString(),
  animate = true,
  window: win,
  formatTime,
  className,
  ...rest
}: SmoothChartProps) {
  const [hiddenState, setHiddenState] = useState<Set<string>>(() => new Set());
  const hidden = hiddenProp ?? hiddenState;
  const setHidden = (next: Set<string>) => {
    if (!hiddenProp) setHiddenState(next);
    onHiddenChange?.(next);
  };
  // An index in index mode, a time (Unix ms) in window mode.
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();
  const reduced = useReducedMotionConfig() ?? false;

  // Window geometry: the plot shows [start, end]; the moving layer also
  // holds `back` before it (the point the line enters from) and `ahead`
  // after it (the lag and the follow animation's distance).
  const follow = !!win?.follow && !reduced;
  const span = win ? Math.max(1, win.spanMs) : 1;
  const lag = follow ? (win?.lagMs ?? 0) : 0;
  const end = win ? win.now - lag : 0;
  const start = end - span;
  const back = win ? Math.min(span, win.maxGapMs ?? span / 20) : 0;
  const ahead = follow ? lag + followMs : span / 50;
  const layerSpan = back + span + ahead;
  const layerWidth = (W * layerSpan) / span;

  const visible = series.filter((s) => !hidden.has(s.id));
  // The sticky maximum belongs to the series shown: hiding or showing one fits the graph again.
  const shownKey = visible.map((s) => s.id).join(" ");
  const stickyMax = useRef<{ key: string; max: number } | undefined>(undefined);
  const domain = useMemo(() => {
    const values = visible.flatMap((s) => s.values);
    if (!win || max !== undefined) return niceDomain(values, { min, max });
    const fitted = niceDomain(values, { min });
    let top = fitted.min;
    for (const v of values) if (v !== null && Number.isFinite(v) && v > top) top = v;
    const previous = stickyMax.current?.key === shownKey ? stickyMax.current.max : undefined;
    return { min: fitted.min, max: stickyNiceMax(previous, top - fitted.min) + fitted.min };
  }, [visible, min, max, win, shownKey]);
  useEffect(() => {
    if (win && max === undefined) stickyMax.current = { key: shownKey, max: domain.max - domain.min };
  }, [win, max, domain, shownKey]);
  const points = Math.max(0, ...series.map((s) => s.values.length));

  const shapes = useMemo(
    () =>
      series.map((s) => {
        const runs = win
          ? toTimeSegments(s.times ?? [], s.values, {
              width: W,
              height: H,
              ...domain,
              start: start - back,
              span,
              maxGap: win.maxGapMs,
            })
          : toSegments(s.values, { width: W, height: H, ...domain });
        return { line: runs.map((r) => smoothPath(r)).join(" "), area: runs.map((r) => smoothAreaPath(r, H)).join(" ") };
      }),
    [series, domain, win, start, back, span],
  );

  // The follow animation: from this render's place, left at real speed.
  const layerRef = useRef<HTMLDivElement>(null);
  const travel = (followMs / layerSpan) * 100;
  // biome-ignore lint/correctness/useExhaustiveDependencies: every new `end` (a render with new points) starts it again from 0.
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!follow || !el || typeof el.animate !== "function") return;
    const slide = el.animate([{ transform: "translateX(0)" }, { transform: `translateX(-${travel}%)` }], {
      duration: followMs,
      easing: "linear",
      fill: "forwards",
    });
    return () => slide.cancel();
  }, [follow, travel, end]);

  const grid = Array.from({ length: gridLines }, (_, i) => ((i + 1) * H) / (gridLines + 1));
  const span01 = domain.max - domain.min || 1;
  const topOf = (v: number) => (1 - (Math.min(domain.max, Math.max(domain.min, v)) - domain.min) / span01) * 100;
  /** Where the plot's left edge is now: the follow animation moved it since this render. */
  const shownStart = () => start + (follow && win ? Math.min(followMs, Math.max(0, Date.now() - win.now)) : 0);

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    if (win) setHover(shownStart() + ratio * span);
    else if (points >= 2) setHover(Math.round(ratio * (points - 1)));
  }

  // What the hover shows: per series the value (and its place), the line's place and the label.
  let hoverLeft = 0;
  let hoverLabel: string | undefined;
  const hoverValues: ({ v: number; left: number } | null)[] = [];
  if (hover !== null && win) {
    const left0 = shownStart();
    const tolerance = Math.max(win.maxGapMs ?? 0, 1) / 2;
    let lineT: number | null = null;
    for (const s of series) {
      const times = s.times ?? [];
      const k = nearest(times, hover);
      const t = times[k];
      const v = s.values[k];
      if (k < 0 || t === undefined || v === null || v === undefined || Math.abs(t - hover) > tolerance) {
        hoverValues.push(null);
        continue;
      }
      hoverValues.push({ v, left: ((t - left0) / span) * 100 });
      if (lineT === null && !hidden.has(s.id)) lineT = t;
    }
    const at = lineT ?? hover;
    hoverLeft = Math.min(100, Math.max(0, ((at - left0) / span) * 100));
    hoverLabel = formatTime?.(at);
  } else if (hover !== null && points >= 2) {
    hoverLeft = (hover / (points - 1)) * 100;
    hoverLabel = labels?.[hover];
    for (const s of series) {
      const v = s.values[hover];
      hoverValues.push(v === null || v === undefined ? null : { v, left: hoverLeft });
    }
  }
  const showHover = hover !== null && visible.length > 0 && (win !== undefined || points >= 2);

  const defs = (width: number) => (
    <defs>
      <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="white" stopOpacity="1" />
        <stop offset="1" stopColor="white" stopOpacity="0.35" />
      </linearGradient>
      <mask id={`${gradientId}-m`}>
        <rect x="0" y="0" width={width} height={H} fill={`url(#${gradientId})`} />
      </mask>
      {/* Lines draw in left to right by growing this clip (stroke dash tricks break with non-scaling strokes). */}
      <clipPath id={`${gradientId}-c`}>
        <rect
          x="-4"
          y="-4"
          width={width + 8}
          height={H + 8}
          className={animate && !win ? "origin-left animate-chart-reveal [transform-box:fill-box]" : undefined}
        />
      </clipPath>
    </defs>
  );
  const gridPath = (
    <path
      d={grid.map((y) => `M0,${y} H${W}`).join(" ")}
      stroke="var(--grid-line)"
      strokeWidth="1"
      vectorEffect="non-scaling-stroke"
      fill="none"
    />
  );
  const marks = (
    <>
      {area &&
        series.map((s, i) => (
          <path
            key={`a-${s.id}`}
            d={shapes[i]?.area}
            fill={seriesColor(s, i)}
            fillOpacity={0.08}
            mask={`url(#${gradientId}-m)`}
            className={cn("transition-opacity duration-300", animate && !win && "animate-chart-fade")}
            opacity={hidden.has(s.id) ? 0 : 1}
          />
        ))}
      <g clipPath={`url(#${gradientId}-c)`}>
        {series.map((s, i) => (
          <path
            key={`l-${s.id}`}
            d={shapes[i]?.line}
            fill="none"
            stroke={seriesColor(s, i)}
            strokeWidth={2.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className="transition-opacity duration-300"
            opacity={hidden.has(s.id) ? 0 : 1}
          />
        ))}
      </g>
    </>
  );

  return (
    <div data-slot="smooth-chart" data-mode={win ? "window" : undefined} className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      <div className="relative" style={{ height }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {win ? (
          <div role="img" aria-label={rest["aria-label"]} className="absolute inset-0">
            <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="none" className="block">
              {gridPath}
            </svg>
            {/* Clips the sliding layer at the plot's sides only: a line at 0 or 100% keeps its full stroke. */}
            <div className="absolute inset-x-0 -top-1.5 -bottom-1.5 overflow-hidden">
              <div
                ref={layerRef}
                data-slot="smooth-chart-layer"
                className="absolute top-1.5 bottom-1.5 will-change-transform"
                style={{ left: `${(-back / span) * 100}%`, width: `${(layerSpan / span) * 100}%` }}
              >
                <svg
                  aria-hidden="true"
                  viewBox={`0 0 ${layerWidth} ${H}`}
                  width="100%"
                  height={height}
                  preserveAspectRatio="none"
                  className="block overflow-visible"
                >
                  {defs(layerWidth)}
                  {marks}
                </svg>
              </div>
            </div>
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={height}
            preserveAspectRatio="none"
            role="img"
            aria-label={rest["aria-label"]}
            className="block overflow-visible"
          >
            {defs(W)}
            {gridPath}
            {marks}
          </svg>
        )}
        {showHover && (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-border"
              style={{ left: `${hoverLeft}%` }}
            />
            {series.map((s, i) => {
              const at = hoverValues[i];
              if (hidden.has(s.id) || !at) return null;
              return (
                <span
                  key={`d-${s.id}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
                  style={{ left: `${at.left}%`, top: `${topOf(at.v)}%`, background: seriesColor(s, i) }}
                />
              );
            })}
            <div
              role="tooltip"
              className="pointer-events-none absolute top-1 z-10 flex min-w-32 flex-col gap-1 rounded-control bg-popover px-3 py-2 text-[12px] shadow-popover"
              style={hoverLeft > 55 ? { right: `calc(${100 - hoverLeft}% + 10px)` } : { left: `calc(${hoverLeft}% + 10px)` }}
            >
              {hoverLabel && <span className="text-muted-foreground">{hoverLabel}</span>}
              {series.map((s, i) => {
                const at = hoverValues[i];
                if (hidden.has(s.id)) return null;
                return (
                  <span key={`t-${s.id}`} className="flex items-center gap-2 whitespace-nowrap text-ink-strong">
                    <span className="h-[3px] w-2.5 rounded-full" style={{ background: seriesColor(s, i) }} />
                    {s.label}
                    <b className="ml-auto pl-3 font-semibold text-foreground">{at ? formatValue(at.v, s) : "-"}</b>
                  </span>
                );
              })}
            </div>
          </>
        )}
      </div>
      {legend && <ChartLegend series={series} hidden={hidden} onToggle={(id) => setHidden(toggled(hidden, id))} />}
    </div>
  );
}

function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Toggle chips for chart series (one legend can drive several charts, like
 * the dashboard's CPU, memory and network graphs). Pressed = visible.
 */
export function ChartLegend({
  series,
  hidden,
  onToggle,
  className,
}: {
  series: readonly Pick<ChartSeries, "id" | "label" | "color">[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
  className?: string;
}) {
  const labels = useUiLabels();
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {series.map((s, i) => {
        const on = !hidden.has(s.id);
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={on}
            title={labels.showOrHide}
            onClick={() => onToggle(s.id)}
            className={cn(
              // 32px, the height of the segmented range picker and small buttons beside it. Off: no fill, never an outline.
              "flex h-8 cursor-pointer items-center gap-[7px] rounded-[7px] border-0 px-[11px] text-[12.5px] transition-colors",
              on ? "bg-muted text-foreground" : "bg-transparent text-ink-faint hover:bg-muted/60 hover:text-muted-foreground",
            )}
          >
            <span
              className={cn("h-[3px] w-3 rounded-full transition-opacity", !on && "opacity-40")}
              style={{ background: seriesColor(s as ChartSeries, i) }}
            />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

/** Toggles an id in a set (for the hidden-series state of a shared legend). */
export { toggled as toggleHidden };
