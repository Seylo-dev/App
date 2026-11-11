// How many of an expensive operation (a password hash, a key derivation)
// run at once: the rest wait in a short queue, and past that the caller
// gets an error instead of the panel running out of memory under a flood.

export interface Limiter {
  /** Resolves when a slot is free; rejects with `busy()` when the queue is full too. */
  acquire(): Promise<void>;
  release(): void;
}

/** `limits` is read on every call, so tests can change it. */
export function createLimiter(limits: { running: number; waiting: number }, busy: () => Error): Limiter {
  let running = 0;
  const queue: (() => void)[] = [];
  return {
    acquire() {
      if (running < limits.running) {
        running++;
        return Promise.resolve();
      }
      if (queue.length >= limits.waiting) return Promise.reject(busy());
      // The slot is handed over by release(), so `running` stays counted.
      return new Promise((resolve) => queue.push(resolve));
    },
    release() {
      const next = queue.shift();
      if (next) next();
      else running--;
    },
  };
}
