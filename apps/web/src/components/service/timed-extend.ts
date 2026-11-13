// "+1 hour" on a timed expose: exposures.extendTimed sets the end to
// durationMinutes from now, so the button asks for what is left plus an
// hour (at most the op's 24 hours). Asking for 60 minutes cut an expose
// with more than an hour left short.

/** durationMinutes for extendTimed that ends one hour after `leftMs` from now. */
export function oneHourMore(leftMs: number): number {
  return Math.min(1440, Math.max(5, Math.ceil(Math.max(0, leftMs) / 60_000) + 60));
}
