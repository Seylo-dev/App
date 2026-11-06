// After a mutation, refetch the queries it changed. The live socket does
// the same once the panel publishes; doing it here too makes the screen
// update even when the socket is reconnecting.

import { opQueryKey } from "@seylo/ops/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

export function useInvalidate(): (...ops: { id: string }[]) => void {
  const client = useQueryClient();
  return useCallback(
    (...ops) => {
      for (const op of ops) void client.invalidateQueries({ queryKey: opQueryKey(op) });
    },
    [client],
  );
}
