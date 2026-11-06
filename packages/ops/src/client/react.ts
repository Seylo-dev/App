// TanStack Query hooks over the op client. Query keys are
// ["op", <op id>, <input>], so the live socket can invalidate every cached
// call of an op by id (see apps/web/src/lib/live.ts).

import { type QueryKey, type UseMutationOptions, type UseQueryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { createContext, createElement, type ReactNode, useContext } from "react";
import type { AnyOpContract, OpInput, OpOutput } from "../define";
import type { OpError } from "../errors";
import type { OpClient } from "./client";

type QueryOp = AnyOpContract & { readonly kind: "query" };
type ChangeOp = AnyOpContract & { readonly kind: "mutation" | "destructive" };

const OpClientContext = createContext<OpClient | null>(null);

export function OpClientProvider(props: { client: OpClient; children: ReactNode }) {
  return createElement(OpClientContext.Provider, { value: props.client }, props.children);
}

export function useOpClient(): OpClient {
  const client = useContext(OpClientContext);
  if (!client) throw new Error("useOpClient: wrap the app in <OpClientProvider>");
  return client;
}

/** Key for every cached call of `op`, or for one input when given. */
export function opQueryKey(op: Pick<AnyOpContract, "id">, input?: unknown): QueryKey {
  return input === undefined ? ["op", op.id] : ["op", op.id, input];
}

/** Runs a query op and caches it. Mutations go through useOpMutation. */
export function useOp<C extends QueryOp>(
  op: C,
  input: OpInput<C>,
  options?: Omit<UseQueryOptions<OpOutput<C>, OpError>, "queryKey" | "queryFn">,
) {
  const client = useOpClient();
  return useQuery<OpOutput<C>, OpError>({
    queryKey: opQueryKey(op, input),
    queryFn: ({ signal }) => client.call(op, input, { signal }),
    ...options,
  });
}

export function useOpMutation<C extends ChangeOp>(
  op: C,
  options?: Omit<UseMutationOptions<OpOutput<C>, OpError, OpInput<C>>, "mutationFn">,
) {
  const client = useOpClient();
  return useMutation<OpOutput<C>, OpError, OpInput<C>>({
    mutationKey: ["op", op.id],
    mutationFn: (input) => client.call(op, input),
    ...options,
  });
}
