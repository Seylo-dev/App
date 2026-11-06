// Loads the signed-in person for route guards. Shares the cache entry with
// useOp(auth.whoami), so the sidebar renders without a second request.

import { auth, OpError } from "@seylo/ops";
import { opQueryKey } from "@seylo/ops/react";
import type { RouterContext } from "./router-context";

export function ensureViewer({ queryClient, opClient }: RouterContext) {
  return queryClient.ensureQueryData({
    queryKey: opQueryKey(auth.whoami, {}),
    queryFn: () => opClient.call(auth.whoami, {}),
  });
}

export function isSignedOut(error: unknown): boolean {
  return error instanceof OpError && error.code === "UNAUTHENTICATED";
}
