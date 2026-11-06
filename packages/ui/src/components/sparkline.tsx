import { useMemo } from "react";
import { niceDomain, smoothAreaPath, smoothPath, toSegments } from "../lib/smooth-path";
import { cn } from "../lib/utils";

/** A tiny smooth trend line with a light fill, for tiles and table cells. Decorative unless given a label. */
export function Sparkline({
  values,
  color = "var(--chart-1)",
  height = 32,
  min,
  max,
  area = true,
  className,
  "aria-label": label,
}: {
  values: readonly (number | null)[];
  color?: string;
  height?: number;
  min?: number;
  max?: number;
  area?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const { line, fill } = useMemo(() => {
    const runs = toSegments(values, { width: 100, height: 30, ...niceDomain(values, { min, max }) });
    // Keep the stroke inside the box: 2px of headroom top and bottom.
    const inset = runs.map((r) => r.map(([x, y]) => [x, 2 + (y / 30) * 26] as const));
    return { line: inset.map((r) => smoothPath(r)).join(" "), fill: inset.map((r) => smoothAreaPath(r, 30)).join(" ") };
  }, [values, min, max]);
  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      width="100%"
      height={height}
      className={cn("block", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {area && <path d={fill} fill={color} fillOpacity={0.1} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
