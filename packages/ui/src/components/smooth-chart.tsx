// Smooth line and area charts in the dashboard's style: Catmull-Rom curves
// with light fills, a quiet grid, lines that draw in once, series that can
// be hidden from a legend, and a hover tooltip with every visible value.
// Plain SVG, no chart library: the curve math is in lib/smooth-path.

import { type ReactNode, useId, useMemo, useState } from "react";
import { niceDomain, smoothAreaPath, smoothPath, toSegments } from "../lib/smooth-path";
import { cn } from "../lib/utils";
import { useUiLabels } from "./labels";

export interface ChartSeries {
  id: string;
  label: string;
  values: readonly (number | null)[];
  /** Any CSS color; defaults to the --chart-N token by position. */
  color?: string;
}

export function seriesColor(series: ChartSeries, index: number): string {
  return series.color ?? `var(--chart-${(index % 5) + 1})`;
}

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
  /** Fixed y range; otherwise fitted to the visible series (min 0 for non-negative data). */
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
  /** Draw the lines in on mount. Default true. */
  animate?: boolean;
  className?: string;
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
  className,
  ...rest
}: SmoothChartProps) {
  const [hiddenState, setHiddenState] = useState<Set<string>>(() => new Set());
  const hidden = hiddenProp ?? hiddenState;
  const setHidden = (next: Set<string>) => {
    if (!hiddenProp) setHiddenState(next);
    onHiddenChange?.(next);
  };
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();

  const visible = series.filter((s) => !hidden.has(s.id));
  const domain = useMemo(
    () =>
      niceDomain(
        visible.flatMap((s) => s.values),
        { min, max },
      ),
    [visible, min, max],
  );
  const points = Math.max(0, ...series.map((s) => s.values.length));

  const shapes = useMemo(
    () =>
      series.map((s) => {
        const runs = toSegments(s.values, { width: W, height: H, ...domain });
        return { line: runs.map((r) => smoothPath(r)).join(" "), area: runs.map((r) => smoothAreaPath(r, H)).join(" ") };
      }),
    [series, domain],
  );

  const grid = Array.from({ length: gridLines }, (_, i) => ((i + 1) * H) / (gridLines + 1));

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    if (points < 2) return;
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    setHover(Math.round(ratio * (points - 1)));
  }

  const hoverLeft = hover === null || points < 2 ? 0 : (hover / (points - 1)) * 100;
  const span = domain.max - domain.min || 1;

  return (
    <div data-slot="smooth-chart" className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      <div className="relative" style={{ height }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={height}
          preserveAspectRatio="none"
          role="img"
          aria-label={rest["aria-label"]}
          className="block overflow-visible"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="white" stopOpacity="1" />
              <stop offset="1" stopColor="white" stopOpacity="0.35" />
            </linearGradient>
            <mask id={`${gradientId}-m`}>
              <rect x="0" y="0" width={W} height={H} fill={`url(#${gradientId})`} />
            </mask>
            {/* Lines draw in left to right by growing this clip (stroke dash tricks break with non-scaling strokes). */}
            <clipPath id={`${gradientId}-c`}>
              <rect
                x="-4"
                y="-4"
                width={W + 8}
                height={H + 8}
                className={animate ? "origin-left animate-chart-reveal [transform-box:fill-box]" : undefined}
              />
            </clipPath>
          </defs>
          <path
            d={grid.map((y) => `M0,${y} H${W}`).join(" ")}
            stroke="var(--grid-line)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
          {area &&
            series.map((s, i) => (
              <path
                key={`a-${s.id}`}
                d={shapes[i]?.area}
                fill={seriesColor(s, i)}
                fillOpacity={0.08}
                mask={`url(#${gradientId}-m)`}
                className={cn("transition-opacity duration-300", animate && "animate-chart-fade")}
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
        </svg>
        {hover !== null && visible.length > 0 && (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-border"
              style={{ left: `${hoverLeft}%` }}
            />
            {series.map((s, i) => {
              const v = s.values[hover];
              if (hidden.has(s.id) || v === null || v === undefined) return null;
              const top = (1 - (Math.min(domain.max, Math.max(domain.min, v)) - domain.min) / span) * 100;
              return (
                <span
                  key={`d-${s.id}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
                  style={{ left: `${hoverLeft}%`, top: `${top}%`, background: seriesColor(s, i) }}
                />
              );
            })}
            <div
              role="tooltip"
              className="pointer-events-none absolute top-1 z-10 flex min-w-32 flex-col gap-1 rounded-control bg-popover px-3 py-2 text-[12px] shadow-popover"
              style={hoverLeft > 55 ? { right: `calc(${100 - hoverLeft}% + 10px)` } : { left: `calc(${hoverLeft}% + 10px)` }}
            >
              {labels?.[hover] && <span className="text-muted-foreground">{labels[hover]}</span>}
              {series.map((s, i) => {
                const v = s.values[hover];
                if (hidden.has(s.id)) return null;
                return (
                  <span key={`t-${s.id}`} className="flex items-center gap-2 whitespace-nowrap text-ink-strong">
                    <span className="h-[3px] w-2.5 rounded-full" style={{ background: seriesColor(s, i) }} />
                    {s.label}
                    <b className="ml-auto pl-3 font-semibold text-foreground">{v === null || v === undefined ? "-" : formatValue(v, s)}</b>
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
