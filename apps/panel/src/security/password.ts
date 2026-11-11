// Password hashing with argon2id (Bun.password, which also picks the salt
// and encodes the parameters into the hash).
//
// Each verification costs about 64 MiB and some CPU, and sign-in is open to
// anyone, so only a few run at once: the rest wait in a short queue, and
// past that the caller gets RATE_LIMITED instead of the panel running out
// of memory under a flood of guesses.

import { OpError } from "@seylo/ops";
import { createLimiter } from "./limiter";

// Verified against when the email is unknown, so a wrong email costs as much
// time as a wrong password and response timing does not reveal accounts.
let dummyHash: Promise<string> | undefined;

/** How many verifications run at once and how many may wait; tests change it. */
export const verifyLimits = { running: 4, waiting: 32 };

const limiter = createLimiter(
  verifyLimits,
  () => new OpError("RATE_LIMITED", "The panel is busy checking passwords. Try again in 2 seconds.", { retryAfter: "2" }),
);

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  await limiter.acquire();
  try {
    if (!hash) {
      dummyHash ??= hashPassword("not-a-real-password");
      await Bun.password.verify(password, await dummyHash);
      return false;
    }
    return await Bun.password.verify(password, hash);
  } finally {
    limiter.release();
  }
}
