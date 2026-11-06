// Cursor paging over a query op ("Load more"), for the activity log and
// approvals. The cache key starts with the op's key, so the live socket's
// invalidations for the op refetch these pages too.

import type { AnyOpContract, OpError, OpInput, OpOutput } from "@seylo/ops";
import { opQueryKey, useOpClient } from "@seylo/ops/react";
import { useInfiniteQuery } from "@tanstack/react-query";

type QueryOp = AnyOpContract & { readonly kind: "query" };

export function useOpPages<C extends QueryOp>(op: C, input: Omit<OpInput<C>, "cursor">, nextCursor: (page: OpOutput<C>) => string | null) {
  const client = useOpClient();
  return useInfiniteQuery<OpOutput<C>, OpError, { pages: OpOutput<C>[] }, readonly unknown[], string | null>({
    queryKey: [...opQueryKey(op, input), "pages"],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => client.call(op, (pageParam ? { ...input, cursor: pageParam } : input) as OpInput<C>, { signal }),
    getNextPageParam: (last) => nextCursor(last),
  });
}
