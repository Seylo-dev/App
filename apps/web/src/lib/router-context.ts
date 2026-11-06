import type { OpClient } from "@seylo/ops/client";
import type { QueryClient } from "@tanstack/react-query";

/** Available to every route's loader and beforeLoad. */
export interface RouterContext {
  queryClient: QueryClient;
  opClient: OpClient;
}
