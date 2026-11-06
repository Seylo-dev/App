// Mutations on settings screens: run the op, refetch the queries it
// changed, and tell the person how it went. The live socket also
// invalidates, but a local refetch makes the screen update without waiting
// for it (and works when the socket is down).

import type { AnyOpContract, OpError, OpInput, OpOutput } from "@seylo/ops";
import { opQueryKey, useOpMutation } from "@seylo/ops/react";
import { toast } from "@seylo/ui/components/toast";
import { queryClient } from "../../lib/api";
import { toastError } from "./op-state";

type ChangeOp = AnyOpContract & { readonly kind: "mutation" | "destructive" };

export function invalidateOps(ops: readonly Pick<AnyOpContract, "id">[]): Promise<void> {
  return Promise.all(ops.map((op) => queryClient.invalidateQueries({ queryKey: opQueryKey(op) }))).then(() => undefined);
}

export function useSettingsMutation<C extends ChangeOp>(
  op: C,
  options: {
    /** Queries to refetch after success. */
    invalidates?: readonly Pick<AnyOpContract, "id">[];
    /** Toast title on success; omit for no toast. */
    success?: string | ((output: OpOutput<C>) => string);
    /** Toast title on failure; false when the screen shows the error itself. */
    failure?: string | false;
    onSuccess?: (output: OpOutput<C>, input: OpInput<C>) => void;
    onError?: (error: OpError) => void;
  } = {},
) {
  return useOpMutation(op, {
    onSuccess: async (output, input) => {
      if (options.invalidates) await invalidateOps(options.invalidates);
      if (options.success) toast.success(typeof options.success === "function" ? options.success(output) : options.success);
      options.onSuccess?.(output, input);
    },
    onError: (error) => {
      if (options.failure !== false) toastError(error, options.failure);
      options.onError?.(error);
    },
  });
}
