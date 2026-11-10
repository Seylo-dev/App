// Smooth SVG paths through points: Catmull-Rom splines written as cubic
// Beziers (the same math the approved designs used, design/smoothpath.py).
// The first and last points repeat themselves as the missing neighbors, so
// the curve starts and ends flat on the data instead of overshooting.

export type Point = readonly [x: number, y: number];

function num(n: number): string {
  // One decimal is plenty for a 300x100 viewBox and keeps paths short.
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
}

/** A cubic Bezier path through the points. tension 0.5 matches the designs. */
export function smoothPath(points: readonly Point[], tension = 0.5): string {
  const first = points[0];
  if (!first) return "";
  let d = `M${num(first[0])},${num(first[1])}`;
  if (points.length === 1) return d;
  const k = tension / 3;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i] as Point;
    const p2 = points[i + 1] as Point;
    const p0 = points[i - 1] ?? p1;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) * k;
    const c1y = p1[1] + (p2[1] - p0[1]) * k;
    const c2x = p2[0] - (p3[0] - p1[0]) * k;
    const c2y = p2[1] - (p3[1] - p1[1]) * k;
    d += ` C${num(c1x)},${num(c1y)} ${num(c2x)},${num(c2y)} ${num(p2[0])},${num(p2[1])}`;
  }
  return d;
}

/** The smooth line closed down to `baseline`, for a light area fill. */
export function smoothAreaPath(points: readonly Point[], baseline: number, tension = 0.5): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return "";
  return `${smoothPath(points, tension)} L${num(last[0])},${num(baseline)} L${num(first[0])},${num(baseline)} Z`;
}

/**
 * Splits a series with gaps (null) into runs of points, mapping index and
 * value into the box: x from 0 to width across all indexes, y from height
 * (min) to 0 (max).
 */
export function toSegments(
  values: readonly (number | null | undefined)[],
  box: { width: number; height: number; min: number; max: number },
): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const span = box.max - box.min || 1;
  const step = values.length > 1 ? box.width / (values.length - 1) : 0;
  values.forEach((v, i) => {
    if (v === null || v === undefined || !Number.isFinite(v)) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    const clamped = Math.min(box.max, Math.max(box.min, v));
    run.push([i * step, box.height - ((clamped - box.min) / span) * box.height]);
  });
  if (run.length) runs.push(run);
  return runs;
}

/**
 * toSegments on a time axis: values[i] sits at times[i] (any unit), x
 * from `start` (0) over `span` (width), so points outside the box keep
 * their place beyond its edges. A gap longer than maxGap between two
 * points breaks the line as a null does (the node was away).
 */
export function toTimeSegments(
  times: readonly number[],
  values: readonly (number | null | undefined)[],
  box: { width: number; height: number; min: number; max: number; start: number; span: number; maxGap?: number },
): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  const range = box.max - box.min || 1;
  const scale = box.span > 0 ? box.width / box.span : 0;
  let previous = Number.NEGATIVE_INFINITY;
  values.forEach((v, i) => {
    const t = times[i];
    if (t === undefined || v === null || v === undefined || !Number.isFinite(v) || !Number.isFinite(t)) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    if (run.length && box.maxGap !== undefined && t - previous > box.maxGap) {
      runs.push(run);
      run = [];
    }
    previous = t;
    const clamped = Math.min(box.max, Math.max(box.min, v));
    run.push([(t - box.start) * scale, box.height - ((clamped - box.min) / range) * box.height]);
  });
  if (run.length) runs.push(run);
  return runs;
}

/** The smallest of 1, 2, 2.5 and 5 times a power of ten that is at least v (1 for 0 or less). */
export function niceCeil(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const base = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 2.5, 5]) if (step * base >= v * (1 - 1e-12)) return step * base;
  return 10 * base;
}

/**
 * A y maximum for a live graph that does not move with every sample: the
 * nice step above the data (with headroom), grown at once when the data
 * needs more room, shrunk only once the data would fit in well under half
 * of it.
 */
export function stickyNiceMax(previous: number | undefined, dataMax: number, headroom = 1.1): number {
  const wanted = niceCeil(dataMax * headroom);
  if (previous === undefined || wanted > previous) return wanted;
  return wanted * 2.5 <= previous ? wanted : previous;
}

/** A y range that fits every value with a little headroom; min stays at 0 for non-negative data. */
export function niceDomain(
  values: Iterable<number | null | undefined>,
  opts: { min?: number; max?: number } = {},
): { min: number; max: number } {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Number.POSITIVE_INFINITY) return { min: opts.min ?? 0, max: opts.max ?? 1 };
  const min = opts.min ?? (lo >= 0 ? 0 : lo - (hi - lo) * 0.1);
  const max = opts.max ?? (hi === min ? min + 1 : hi + (hi - min) * 0.12);
  return { min, max };
}
