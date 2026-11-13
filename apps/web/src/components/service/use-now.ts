import { useEffect, useState } from "react";
import { serverClock } from "../../lib/server-clock";

/** The current time, ticking every intervalMs while mounted; 0 never ticks. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The panel's time (lib/server-clock.ts), ticking like useNow: for clocks
 * that count from the panel's own timestamps (a running deploy's elapsed
 * time, "2 minutes ago"), so a computer whose clock is off does not add its
 * error to them.
 */
export function useServerNow(intervalMs = 1000): number {
  return useNow(intervalMs) + serverClock.offsetMs();
}
