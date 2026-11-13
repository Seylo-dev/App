// The panel's clock as this tab sees it. A deploy's times (createdAt,
// startedAt) are the panel's clock, and a running deploy's clock shows
// "now minus startedAt": a computer whose clock ran half a minute ahead of
// the panel's showed a 12-second deploy at 0:37. Every op answer carries
// the panel's Date header, to the second; between the moment a call left
// and the moment its answer came, the offset (panel minus browser) lies in
// [date - receivedAt, date + 1000 - sentAt). The tab keeps the overlap of
// the last few such windows and uses its middle, or none when that is under
// a second (both clocks synced, as they usually are).

/** How many recent answers narrow the window. */
const keep = 20;
/** Offsets below this are noise of the one-second Date header, not a wrong clock. */
const ignoreBelowMs = 1000;

export interface ServerClock {
  /** One answer's Date header, with when its call left and when its answer came (this tab's clock). */
  observe(dateHeader: string | null, sentAt: number, receivedAt: number): void;
  /** The panel's clock minus this tab's, 0 while unknown or under a second. */
  offsetMs(): number;
  /** The panel's time now. */
  now(): number;
}

export function createServerClock(localNow: () => number = Date.now): ServerClock {
  let windows: { low: number; high: number }[] = [];
  let offset = 0;
  const settle = () => {
    let low = Number.NEGATIVE_INFINITY;
    let high = Number.POSITIVE_INFINITY;
    for (const w of windows) {
      low = Math.max(low, w.low);
      high = Math.min(high, w.high);
    }
    // No overlap: a clock was set since (NTP, by hand). The newest answer alone counts.
    if (low > high) {
      windows = windows.slice(-1);
      return settle();
    }
    const middle = (low + high) / 2;
    offset = Math.abs(middle) < ignoreBelowMs ? 0 : Math.round(middle);
  };
  return {
    observe(dateHeader, sentAt, receivedAt) {
      if (!dateHeader) return;
      const date = Date.parse(dateHeader);
      if (!Number.isFinite(date) || receivedAt < sentAt) return;
      windows = [...windows.slice(-(keep - 1)), { low: date - receivedAt, high: date + 1000 - sentAt }];
      settle();
    },
    offsetMs: () => offset,
    now: () => localNow() + offset,
  };
}

/** The tab's one clock, fed by every op call (session-key.ts sessionFetch). */
export const serverClock = createServerClock();
