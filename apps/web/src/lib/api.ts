// The app's single op client and query cache. Every server call goes
// through these, typed by the contracts in @seylo/ops.

import { OpError } from "@seylo/ops";
import { createOpClient } from "@seylo/ops/client";
import { QueryClient } from "@tanstack/react-query";
import { withReauth } from "./reauth";
import { sessionFetch } from "./session-key";

/**
 * Changes the panel refuses for want of a recent sign-in open the re-auth
 * dialog, then run again (lib/reauth.ts). Every call carries the session key
 * (lib/session-key.ts).
 */
export const opClient = withReauth(createOpClient({ fetch: sessionFetch as typeof fetch }));

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The live socket invalidates what changed, so polling-style refetches
      // on focus would only add load.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      // Retry only what can heal by itself: network trouble, 500 and 503.
      // Client errors and NOT_IMPLEMENTED (501) give the same answer again.
      retry: (failureCount, error) =>
        failureCount < 2 && !(error instanceof OpError && (error.status < 500 || error.code === "NOT_IMPLEMENTED")),
    },
  },
});

/** A message safe to show for any error a query or mutation produced. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof OpError ? error.message : fallback;
}
